import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { Automata } from '../../src/do/automata';
import type { GigRecord, TunnelGrant, TunnelSessionState } from '../../src/types';
import { createClaimedGig, postPaidGig, seedGig, workerFetch } from './helpers';

interface CreatedGigResponse {
  gig: GigRecord;
  tunnel_grant: TunnelGrant;
}

interface ClaimedGigResponse {
  tunnel_grant: TunnelGrant;
}

describe('gig lifecycle in workerd', () => {
  it('posts, discovers, and atomically awards one concurrent claim', async () => {
    const createResponse = await postPaidGig('lifecycle-create');
    expect(createResponse.status).toBe(201);
    const { gig, tunnel_grant: buyerGrant } = (await createResponse.json()) as CreatedGigResponse;
    expect(buyerGrant.role).toBe('buyer');
    expect(buyerGrant.agent_identity).toBe(gig.buyer_pubkey);
    expect(buyerGrant.expires_at).toBe(gig.expires_at);

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
    const successfulClaim = responses.find(({ status }) => status === 200);
    if (!successfulClaim) {
      throw new Error('Expected one successful claim response');
    }
    const claimed = (await successfulClaim.json()) as ClaimedGigResponse;
    expect(claimed.tunnel_grant.role).toBe('worker');
    expect(['0xworker-a', '0xworker-b']).toContain(claimed.tunnel_grant.agent_identity);

    const row = await env.DB.prepare(
      'SELECT status, worker_pubkey FROM agent_gigs WHERE gig_id = ?'
    )
      .bind(gig.gig_id)
      .first<{ status: string; worker_pubkey: string }>();
    expect(row?.status).toBe('IN_PROGRESS');
    expect(['0xworker-a', '0xworker-b']).toContain(row?.worker_pubkey);
  });

  function lifecycleAction(
    gigId: string,
    grant: TunnelGrant,
    type: 'TaskDelivery' | 'TaskAcceptance' | 'TaskCancellation' | 'TaskAbandonment',
    messageId: string
  ): Promise<Response> {
    return workerFetch(`http://automata.test/v1/gigs/${gigId}/lifecycle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${grant.token}`,
        'X-Correlation-ID': `corr-${messageId}`,
      },
      body: JSON.stringify({
        message_id: messageId,
        sender: grant.agent_identity,
        type,
        payload: { gig_id: gigId },
      }),
    });
  }

  async function startGig(gigId: string, grant: TunnelGrant): Promise<WebSocket> {
    const response = await workerFetch(`http://automata.test/v1/gigs/${gigId}/tunnel`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${grant.token}`,
        'X-Agent-Identity': grant.agent_identity,
      },
    });
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error('Expected WebSocket');
    response.webSocket.accept();
    return response.webSocket;
  }

  it('enforces delivery before acceptance and makes both operations idempotent', async () => {
    const fixture = await createClaimedGig('lifecycle-complete');
    const workerSocket = await startGig(fixture.gig.gig_id, fixture.workerGrant);

    const earlyAcceptance = await lifecycleAction(
      fixture.gig.gig_id,
      fixture.buyerGrant,
      'TaskAcceptance',
      'accept-too-early'
    );
    expect(earlyAcceptance.status).toBe(409);

    const delivery = await lifecycleAction(
      fixture.gig.gig_id,
      fixture.workerGrant,
      'TaskDelivery',
      'deliver-once'
    );
    expect(delivery.status).toBe(200);
    expect(await delivery.json()).toMatchObject({ lifecycle_state: 'DELIVERED', duplicate: false });

    const replayedDelivery = await lifecycleAction(
      fixture.gig.gig_id,
      fixture.workerGrant,
      'TaskDelivery',
      'deliver-once'
    );
    expect(await replayedDelivery.json()).toMatchObject({ lifecycle_state: 'DELIVERED', duplicate: true });

    const acceptance = await lifecycleAction(
      fixture.gig.gig_id,
      fixture.buyerGrant,
      'TaskAcceptance',
      'accept-once'
    );
    expect(acceptance.status).toBe(200);
    expect(await acceptance.json()).toMatchObject({ lifecycle_state: 'CLOSED', duplicate: false });

    const replayedAcceptance = await lifecycleAction(
      fixture.gig.gig_id,
      fixture.buyerGrant,
      'TaskAcceptance',
      'accept-once'
    );
    expect(await replayedAcceptance.json()).toMatchObject({ lifecycle_state: 'CLOSED', duplicate: true });

    const row = await env.DB.prepare(
      'SELECT status, lifecycle_state, lifecycle_version FROM agent_gigs WHERE gig_id = ?'
    ).bind(fixture.gig.gig_id).first<{ status: string; lifecycle_state: string; lifecycle_version: number }>();
    expect(row).toMatchObject({ status: 'COMPLETED', lifecycle_state: 'CLOSED', lifecycle_version: 7 });
    workerSocket.close(1000, 'test complete');
  });

  it('handles cancellation and worker abandonment as terminal, replay-safe paths', async () => {
    const cancellable = await postPaidGig('lifecycle-cancel');
    const created = (await cancellable.json()) as CreatedGigResponse;
    const cancelled = await lifecycleAction(created.gig.gig_id, created.tunnel_grant, 'TaskCancellation', 'cancel-once');
    expect(await cancelled.json()).toMatchObject({ lifecycle_state: 'CANCELLED', duplicate: false });
    const cancelledReplay = await lifecycleAction(created.gig.gig_id, created.tunnel_grant, 'TaskCancellation', 'cancel-once');
    expect(await cancelledReplay.json()).toMatchObject({ lifecycle_state: 'CANCELLED', duplicate: true });

    const abandoned = await createClaimedGig('lifecycle-abandon');
    const abandonedResult = await lifecycleAction(abandoned.gig.gig_id, abandoned.workerGrant, 'TaskAbandonment', 'abandon-once');
    expect(await abandonedResult.json()).toMatchObject({ lifecycle_state: 'FAILED' });
    expect((await workerFetch(`http://automata.test/v1/gigs/${abandoned.gig.gig_id}/status`)).status).toBe(200);
  });

  it('releases an untouched claim after timeout and permits a new atomic winner', async () => {
    const fixture = await createClaimedGig('lifecycle-claim-timeout');
    const stub = env.TUNNEL.getByName(fixture.gig.gig_id) as DurableObjectStub<Automata>;
    await runInDurableObject(stub, async (_instance, state) => {
      const session = await state.storage.get<TunnelSessionState>('tunnel_session');
      if (!session) throw new Error('Expected claimed session');
      session.claim_expires_at = new Date(Date.now() - 1).toISOString();
      await state.storage.put('tunnel_session', session);
      await state.storage.setAlarm(Date.now() + 100);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getLifecycle()).toMatchObject({ lifecycle_state: 'DISCOVERABLE' });
    const row = await env.DB.prepare('SELECT status, worker_pubkey FROM agent_gigs WHERE gig_id = ?')
      .bind(fixture.gig.gig_id).first<{ status: string; worker_pubkey: string | null }>();
    expect(row).toMatchObject({ status: 'ACTIVE', worker_pubkey: null });

    const replacementClaim = await workerFetch('http://automata.test/v1/gigs/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 'replacement-claim', sender: '0xreplacement-worker', type: 'TaskClaim', payload: { gig_id: fixture.gig.gig_id } }),
    });
    expect(replacementClaim.status).toBe(200);
  });

  it('rotates a disconnected participant grant without making the old grant replayable', async () => {
    const fixture = await createClaimedGig('lifecycle-reconnect');
    const buyer = await startGig(fixture.gig.gig_id, fixture.buyerGrant);
    buyer.close(1000, 'network interruption');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reconnect = await workerFetch(`http://automata.test/v1/gigs/${fixture.gig.gig_id}/reconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${fixture.buyerGrant.token}` },
      body: JSON.stringify({ message_id: 'reconnect-buyer', sender: fixture.buyerGrant.agent_identity, role: 'buyer' }),
    });
    expect(reconnect.status).toBe(200);
    const body = (await reconnect.json()) as { tunnel_grant: TunnelGrant };
    expect(body.tunnel_grant.token).not.toBe(fixture.buyerGrant.token);
    expect((await workerFetch(`http://automata.test/v1/gigs/${fixture.gig.gig_id}/tunnel`, { headers: { Upgrade: 'websocket', Authorization: `Bearer ${fixture.buyerGrant.token}`, 'X-Agent-Identity': fixture.buyerGrant.agent_identity } })).status).toBe(401);
    const reconnected = await startGig(fixture.gig.gig_id, body.tunnel_grant);
    reconnected.close(1000, 'done');
  });

  it('emits correlation-aware transition and rejection telemetry without grant tokens', async () => {
    const info = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const fixture = await createClaimedGig('lifecycle-observability');
    const correlationId = 'corr-observability-reject';
    const response = await workerFetch(`http://automata.test/v1/gigs/${fixture.gig.gig_id}/tunnel`, {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer atg_v1_invalid', 'X-Agent-Identity': fixture.buyerGrant.agent_identity, 'X-Correlation-ID': correlationId },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-Correlation-ID')).toBe(correlationId);
    const telemetry = [...info.mock.calls, ...warn.mock.calls].flat().join('\n');
    expect(telemetry).toContain('lifecycle.transition');
    expect(telemetry).toContain('tunnel.grant_rejected');
    expect(telemetry).toContain(correlationId);
    expect(telemetry).not.toContain(fixture.buyerGrant.token);
    info.mockRestore();
    warn.mockRestore();
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
