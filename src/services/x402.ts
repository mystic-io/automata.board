import type { MiddlewareHandler } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { registerExactEvmScheme as registerFacilitatorEvm } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { createWalletClient, http, publicActions } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { Env } from '../types';
import { PAYMENT_NETWORK, PAYMENT_PRICE } from '../config';

export type PaymentMiddlewareProvider = (env: Env) => Promise<MiddlewareHandler>;

export class PaymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
  }
}

export function createX402PaymentMiddleware(
  facilitatorClient: FacilitatorClient,
  payTo: string
): MiddlewareHandler {
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    PAYMENT_NETWORK,
    new ExactEvmScheme()
  );

  return paymentMiddleware(
    {
      'POST /v1/gigs/create': {
        accepts: {
          scheme: 'exact',
          price: PAYMENT_PRICE,
          network: PAYMENT_NETWORK,
          payTo,
        },
        description: 'Post a gig to the Automata network',
      },
    },
    resourceServer
  );
}

export async function createProductionPaymentMiddleware(env: Env): Promise<MiddlewareHandler> {
  if (!env.X402_PAY_TO) {
    throw new PaymentConfigurationError('X402_PAY_TO secret is missing');
  }

  if (!env.WALLET_MNEMONIC) {
    throw new PaymentConfigurationError('WALLET_MNEMONIC secret is missing for local facilitator');
  }

  const account = mnemonicToAccount(env.WALLET_MNEMONIC);
  const combinedClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http('https://sepolia.base.org'),
  }).extend(publicActions);
  const signerClient = {
    ...combinedClient,
    address: account.address,
  } as Parameters<typeof toFacilitatorEvmSigner>[0];
  const signer = toFacilitatorEvmSigner(signerClient);

  const localFacilitator = new x402Facilitator();
  registerFacilitatorEvm(localFacilitator, {
    signer,
    networks: PAYMENT_NETWORK,
  });

  localFacilitator.onVerifyFailure(async (ctx) => {
    console.error('Facilitator Verify Failed:', ctx.error);
  });
  localFacilitator.onSettleFailure(async (ctx) => {
    console.error('Facilitator Settle Failed:', ctx.error);
  });

  const facilitatorClient: FacilitatorClient = {
    verify: (payload, requirements) => localFacilitator.verify(payload, requirements),
    settle: (payload, requirements) => localFacilitator.settle(payload, requirements),
    getSupported: async () => {
      const supported = localFacilitator.getSupported();
      return {
        ...supported,
        kinds: supported.kinds.map((kind) => ({ ...kind, network: PAYMENT_NETWORK })),
      };
    },
  };

  return createX402PaymentMiddleware(facilitatorClient, env.X402_PAY_TO);
}
