import { exports as workerExports } from 'cloudflare:workers';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { GigRecord, TunnelGrant } from '../../src/types';

export const VALID_CREATE_PAYLOAD = {
  message_id: 'runtime-message-create',
  sender: '0xbuyer-runtime',
  type: 'TaskDelegation',
  payload: {
    title: 'Runtime integration task',
    description: 'Exercise the complete workerd-backed lifecycle.',
    task_type: 'data_extraction',
    task_params: { target: 'https://example.com/runtime-fixture' },
    bounty_sats: 50,
    ttl_minutes: 60,
  },
} as const;

export function workerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return workerExports.default.fetch(input, init);
}

export function encodePaymentSignature(
  accepted: PaymentRequirements,
  options: { proof?: string; amount?: string; nonce: string }
): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepted,
      payload: {
        proof: options.proof ?? 'valid',
        amount: options.amount ?? accepted.amount,
        nonce: options.nonce,
      },
    })
  );
}

export async function getPaymentRequirements(body: unknown): Promise<PaymentRequirements> {
  const response = await workerFetch('http://automata.test/v1/gigs/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const encoded = response.headers.get('PAYMENT-REQUIRED');

  if (response.status !== 402 || !encoded) {
    throw new Error(`Expected an x402 challenge, received ${response.status}`);
  }

  const challenge = JSON.parse(atob(encoded)) as PaymentRequired;
  const accepted = challenge.accepts[0];
  if (!accepted) {
    throw new Error('x402 challenge did not include payment requirements');
  }
  return accepted;
}

export async function postPaidGig(
  nonce: string,
  body: unknown = VALID_CREATE_PAYLOAD
): Promise<Response> {
  const accepted = await getPaymentRequirements(body);
  return workerFetch('http://automata.test/v1/gigs/create', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'PAYMENT-SIGNATURE': encodePaymentSignature(accepted, { nonce }),
    },
    body: JSON.stringify(body),
  });
}

interface CreatedGigResponse {
  gig: GigRecord;
  tunnel_grant: TunnelGrant;
}

interface ClaimedGigResponse {
  gig_id: string;
  tunnel_url: string;
  tunnel_grant: TunnelGrant;
}

export interface AuthenticatedTunnelFixture {
  gig: GigRecord;
  tunnelUrl: string;
  buyerGrant: TunnelGrant;
  workerGrant: TunnelGrant;
}

export async function createClaimedGig(
  nonce: string,
  buyerIdentity = '0xbuyer-runtime',
  workerIdentity = '0xworker-runtime'
): Promise<AuthenticatedTunnelFixture> {
  const createResponse = await postPaidGig(nonce, {
    ...VALID_CREATE_PAYLOAD,
    message_id: `create-${nonce}`,
    sender: buyerIdentity,
  });
  if (createResponse.status !== 201) {
    throw new Error(`Expected gig creation to succeed, received ${createResponse.status}`);
  }
  const created = (await createResponse.json()) as CreatedGigResponse;

  const claimResponse = await workerFetch('http://automata.test/v1/gigs/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message_id: `claim-${nonce}`,
      sender: workerIdentity,
      type: 'TaskClaim',
      payload: { gig_id: created.gig.gig_id },
    }),
  });
  if (claimResponse.status !== 200) {
    throw new Error(`Expected gig claim to succeed, received ${claimResponse.status}`);
  }
  const claimed = (await claimResponse.json()) as ClaimedGigResponse;

  return {
    gig: created.gig,
    tunnelUrl: claimed.tunnel_url,
    buyerGrant: created.tunnel_grant,
    workerGrant: claimed.tunnel_grant,
  };
}

export async function seedGig(
  db: D1Database,
  overrides: Partial<{
    gigId: string;
    status: string;
    expiresAt: string;
    workerPubkey: string | null;
  }> = {}
): Promise<string> {
  const gigId = overrides.gigId ?? crypto.randomUUID();
  const now = new Date();
  const expiresAt = overrides.expiresAt ?? new Date(now.getTime() + 60 * 60 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO agent_gigs
       (gig_id, buyer_pubkey, worker_pubkey, title, description, task_type, payload_json, bounty_sats, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      gigId,
      '0xbuyer-seed',
      overrides.workerPubkey ?? null,
      'Seeded runtime gig',
      'A deterministic runtime fixture.',
      'computation',
      JSON.stringify({ operation: 'sum' }),
      25,
      overrides.status ?? 'ACTIVE',
      now.toISOString(),
      expiresAt
    )
    .run();

  return gigId;
}
