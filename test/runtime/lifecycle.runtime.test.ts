import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { GigRecord } from '../../src/types';
import { postPaidGig, seedGig, workerFetch } from './helpers';

interface CreatedGigResponse {
  gig: GigRecord;
}

describe('gig lifecycle in workerd', () => {
  it('posts, discovers, and atomically awards one concurrent claim', async () => {
    const createResponse = await postPaidGig('lifecycle-create');
    expect(createResponse.status).toBe(201);
    const { gig } = (await createResponse.json()) as CreatedGigResponse;

    const discoverResponse = await workerFetch('http://automata.test/v1/gigs/discover');
    expect(discoverResponse.status).toBe(200);
    const discovery = (await discoverResponse.json()) as { count: number; gigs: GigRecord[] };
    expect(discovery.count).toBe(1);
    expect(discovery.gigs[0]?.gig_id).toBe(gig.gig_id);

    const claim = (sender: string) =>
      workerFetch('http://automata.test/v1/gigs/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message_id: `claim-${sender}`,
          sender,
          type: 'TaskClaim',
          payload: { gig_id: gig.gig_id },
        }),
      });

    const responses = await Promise.all([claim('0xworker-a'), claim('0xworker-b')]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 404]);

    const row = await env.DB.prepare(
      'SELECT status, worker_pubkey FROM agent_gigs WHERE gig_id = ?'
    )
      .bind(gig.gig_id)
      .first<{ status: string; worker_pubkey: string }>();
    expect(row?.status).toBe('IN_PROGRESS');
    expect(['0xworker-a', '0xworker-b']).toContain(row?.worker_pubkey);
  });

  it('does not discover or allow claims for an expired active gig', async () => {
    const gigId = await seedGig(env.DB, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const discoverResponse = await workerFetch('http://automata.test/v1/gigs/discover');
    const discovery = (await discoverResponse.json()) as { count: number; gigs: GigRecord[] };
    expect(discovery.gigs).toEqual([]);

    const claimResponse = await workerFetch('http://automata.test/v1/gigs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message_id: 'claim-expired',
        sender: '0xworker-expired',
        type: 'TaskClaim',
        payload: { gig_id: gigId },
      }),
    });
    expect(claimResponse.status).toBe(404);
  });
});
