import type { FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { PAYMENT_NETWORK } from '../../src/config';
import { Automata } from '../../src/do/automata';
import { createApp } from '../../src/index';
import { createX402PaymentMiddleware } from '../../src/services/x402';

const TEST_PAY_TO = '0x0000000000000000000000000000000000000001';
const TEST_PAYER = '0x0000000000000000000000000000000000000002';

class SimulatedFacilitator implements FacilitatorClient {
  constructor(private readonly db: D1Database) {}

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    const proof = paymentPayload.payload.proof;
    const nonce = paymentPayload.payload.nonce;
    const amount = paymentPayload.payload.amount;

    if (proof !== 'valid' || typeof nonce !== 'string' || typeof amount !== 'string') {
      return { isValid: false, invalidReason: 'invalid_simulated_proof' };
    }

    try {
      if (BigInt(amount) < BigInt(paymentRequirements.amount)) {
        return { isValid: false, invalidReason: 'insufficient_simulated_payment' };
      }
    } catch {
      return { isValid: false, invalidReason: 'invalid_simulated_amount' };
    }

    const nonceResult = await this.db
      .prepare('INSERT OR IGNORE INTO runtime_payment_nonces (nonce) VALUES (?)')
      .bind(nonce)
      .run();
    if (nonceResult.meta.changes === 0) {
      return { isValid: false, invalidReason: 'replayed_simulated_payment' };
    }

    return { isValid: true, payer: TEST_PAYER };
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<SettleResponse> {
    const nonce = paymentPayload.payload.nonce;
    if (nonce === 'settlement-failure') {
      return {
        success: false,
        errorReason: 'simulated_settlement_failure',
        errorMessage: 'Deterministic runtime settlement failure',
        transaction: '',
        network: PAYMENT_NETWORK,
        amount: paymentRequirements.amount,
      };
    }
    return {
      success: true,
      payer: TEST_PAYER,
      transaction: `simulated:${typeof nonce === 'string' ? nonce : 'unknown'}`,
      network: PAYMENT_NETWORK,
      amount: paymentRequirements.amount,
    };
  }

  async getSupported(): Promise<Awaited<ReturnType<FacilitatorClient['getSupported']>>> {
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: PAYMENT_NETWORK }],
      extensions: [],
      signers: {},
    };
  }
}

const app = createApp({
  createPaymentMiddleware: async (env) =>
    createX402PaymentMiddleware(new SimulatedFacilitator(env.DB), TEST_PAY_TO),
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;

export { Automata };
