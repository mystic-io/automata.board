import { HTTPFacilitatorClient } from '@x402/core/server';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { PAYMENT_NETWORK } from '../config';
import type { Env } from '../types';
import { logEvent, safeErrorName } from './observability';

export type Facilitator = FacilitatorClient;

export class FacilitatorConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacilitatorConfigurationError';
  }
}

export class FacilitatorTimeoutError extends Error {
  constructor(operation: 'verify' | 'settle' | 'supported', timeoutMs: number) {
    super(`Facilitator ${operation} timed out after ${timeoutMs}ms`);
    this.name = 'FacilitatorTimeoutError';
  }
}

async function withTimeout<T>(
  operation: 'verify' | 'settle' | 'supported',
  timeoutMs: number,
  correlationId: string,
  task: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new FacilitatorTimeoutError(operation, timeoutMs)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([task, timeout]);
  } catch (error) {
    logEvent('error', 'x402.facilitator_operation', {
      correlation_id: correlationId,
      operation,
      outcome: error instanceof FacilitatorTimeoutError ? 'timeout' : 'unavailable',
      error_name: safeErrorName(error),
    });
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function withFacilitatorTimeout(
  facilitator: Facilitator,
  timeoutMs: number,
  correlationId = crypto.randomUUID()
): Facilitator {
  return {
    verify: (payload, requirements) =>
      withTimeout('verify', timeoutMs, correlationId, facilitator.verify(payload, requirements)),
    settle: (payload, requirements) =>
      withTimeout('settle', timeoutMs, correlationId, facilitator.settle(payload, requirements)),
    getSupported: () =>
      withTimeout('supported', timeoutMs, correlationId, facilitator.getSupported()),
  };
}

const TEST_PAYER = '0x0000000000000000000000000000000000000002';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function simulationLabel(nonce: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(nonce)) return '';
  const bytes = nonce.slice(2).match(/.{2}/g);
  if (!bytes) return '';
  return bytes
    .map((hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .join('')
    .replace(/\0+$/g, '');
}

/** Secret-free, deterministic, testnet-only facilitator for local development and tests. */
export class SimulatedFacilitator implements Facilitator {
  constructor(private readonly db: D1Database) {}

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    const authorization = paymentPayload.payload.authorization;
    const signature = paymentPayload.payload.signature;
    if (!isRecord(authorization)) {
      return { isValid: false, invalidReason: 'invalid_simulated_proof' };
    }
    const nonce = authorization.nonce;
    const amount = authorization.value;
    const label = typeof nonce === 'string' ? simulationLabel(nonce) : '';
    if (label === 'verify-unavailable') throw new Error('simulated_facilitator_unavailable');
    if (label === 'verify-timeout') await new Promise((resolve) => setTimeout(resolve, 250));
    if (
      typeof signature !== 'string' ||
      !/^0x[0-9a-f]{130}$/i.test(signature) ||
      typeof nonce !== 'string' ||
      typeof amount !== 'string' ||
      authorization.to !== paymentRequirements.payTo
    ) {
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
      .prepare('INSERT OR IGNORE INTO facilitator_simulator_nonces (nonce) VALUES (?)')
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
    const authorization = paymentPayload.payload.authorization;
    const nonce = isRecord(authorization) ? authorization.nonce : undefined;
    const label = typeof nonce === 'string' ? simulationLabel(nonce) : '';
    if (label === 'settle-unavailable') throw new Error('simulated_facilitator_unavailable');
    if (label === 'settle-timeout') await new Promise((resolve) => setTimeout(resolve, 250));
    if (label === 'settlement-failure' || label === 'settlement-pending') {
      const pending = label === 'settlement-pending';
      return {
        success: false,
        errorReason: pending ? 'settlement_pending' : 'simulated_settlement_failure',
        errorMessage: pending
          ? 'Settlement was not final before the resource-server deadline'
          : 'Deterministic runtime settlement failure',
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

function timeoutFromEnv(value: string | undefined): number {
  const parsed = Number(value ?? '3000');
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 30_000) {
    throw new FacilitatorConfigurationError('FACILITATOR_TIMEOUT_MS must be 10..30000');
  }
  return parsed;
}

export function createConfiguredFacilitator(env: Env, correlationId: string): Facilitator {
  const mode = env.FACILITATOR_MODE;
  let facilitator: Facilitator;
  if (mode === 'simulator') {
    if (env.ENVIRONMENT === 'production') {
      throw new FacilitatorConfigurationError('Simulator is forbidden in production');
    }
    facilitator = new SimulatedFacilitator(env.DB);
  } else if (mode === 'remote') {
    if (!env.X402_FACILITATOR_URL) {
      throw new FacilitatorConfigurationError('X402_FACILITATOR_URL is required in remote mode');
    }
    facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });
  } else {
    throw new FacilitatorConfigurationError('FACILITATOR_MODE must be simulator or remote');
  }
  return withFacilitatorTimeout(
    facilitator,
    timeoutFromEnv(env.FACILITATOR_TIMEOUT_MS),
    correlationId
  );
}
