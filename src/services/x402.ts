import type { MiddlewareHandler } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { Env } from '../types';
import { PAYMENT_NETWORK, PAYMENT_PRICE } from '../config';
import type { Facilitator } from './facilitator';
import { createConfiguredFacilitator, FacilitatorConfigurationError } from './facilitator';

export type PaymentMiddlewareProvider = (
  env: Env,
  correlationId: string
) => Promise<MiddlewareHandler>;
export { FacilitatorConfigurationError as PaymentConfigurationError };

export function createX402PaymentMiddleware(
  facilitator: Facilitator,
  payTo: string
): MiddlewareHandler {
  const resourceServer = new x402ResourceServer(facilitator).register(
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
        description: 'Post a gig to the Automata testnet board',
      },
    },
    resourceServer
  );
}

export async function createProductionPaymentMiddleware(
  env: Env,
  correlationId: string
): Promise<MiddlewareHandler> {
  if (!env.X402_PAY_TO) throw new FacilitatorConfigurationError('X402_PAY_TO is missing');
  return createX402PaymentMiddleware(
    createConfiguredFacilitator(env, correlationId),
    env.X402_PAY_TO
  );
}
