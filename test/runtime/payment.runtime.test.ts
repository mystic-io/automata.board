import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  VALID_CREATE_PAYLOAD,
  encodePaymentSignature,
  getPaymentRequirements,
  workerFetch,
} from './helpers';

describe('x402 payment verification in workerd', () => {
  it('accepts a valid simulated proof and records the gig', async () => {
    const accepted = await getPaymentRequirements(VALID_CREATE_PAYLOAD);
    const response = await workerFetch('http://automata.test/v1/gigs/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': encodePaymentSignature(accepted, { nonce: 'payment-valid' }),
      },
      body: JSON.stringify(VALID_CREATE_PAYLOAD),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    const row = await env.DB.prepare('SELECT status FROM agent_gigs').first<{ status: string }>();
    expect(row?.status).toBe('ACTIVE');
  });

  it.each([
    {
      name: 'invalid',
      proof: 'forged',
      amount: undefined,
      nonce: 'payment-invalid',
    },
    {
      name: 'insufficient',
      proof: 'valid',
      amount: '0',
      nonce: 'payment-insufficient',
    },
  ])('rejects an $name simulated proof before the handler runs', async (testCase) => {
    const accepted = await getPaymentRequirements(VALID_CREATE_PAYLOAD);
    const response = await workerFetch('http://automata.test/v1/gigs/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': encodePaymentSignature(accepted, testCase),
      },
      body: JSON.stringify(VALID_CREATE_PAYLOAD),
    });

    expect(response.status).toBe(402);
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM agent_gigs').first<{
      count: number;
    }>();
    expect(row?.count).toBe(0);
  });

  it('rejects a replayed simulated proof', async () => {
    const accepted = await getPaymentRequirements(VALID_CREATE_PAYLOAD);
    const signature = encodePaymentSignature(accepted, { nonce: 'payment-replay' });
    const send = () =>
      workerFetch('http://automata.test/v1/gigs/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'PAYMENT-SIGNATURE': signature,
        },
        body: JSON.stringify(VALID_CREATE_PAYLOAD),
      });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(402);
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM agent_gigs').first<{
      count: number;
    }>();
    expect(row?.count).toBe(1);
  });

  it('fails the created lifecycle closed when settlement fails after handler execution', async () => {
    const accepted = await getPaymentRequirements(VALID_CREATE_PAYLOAD);
    const response = await workerFetch('http://automata.test/v1/gigs/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': encodePaymentSignature(accepted, { nonce: 'settlement-failure' }),
        'X-Correlation-ID': 'corr-settlement-failure',
      },
      body: JSON.stringify(VALID_CREATE_PAYLOAD),
    });
    expect(response.status).toBe(402);
    expect(response.headers.get('X-Correlation-ID')).toBe('corr-settlement-failure');
    const row = await env.DB.prepare('SELECT status, lifecycle_state FROM agent_gigs').first<{
      status: string;
      lifecycle_state: string;
    }>();
    expect(row).toMatchObject({ status: 'EXPIRED', lifecycle_state: 'FAILED' });
  });
});
