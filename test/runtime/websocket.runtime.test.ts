import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Automata } from '../../src/do/automata';
import type { TunnelGrant, TunnelSessionState } from '../../src/types';
import { createClaimedGig, workerFetch } from './helpers';

function waitForMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket message')),
      1_000
    );
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true }
    );
  });
}

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket close')),
      1_000
    );
    socket.addEventListener(
      'close',
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true }
    );
  });
}

function tunnelUrl(gigId: string): string {
  return `http://automata.test/v1/gigs/${gigId}/tunnel`;
}

function tunnelRequest(
  gigId: string,
  grant?: Pick<TunnelGrant, 'token' | 'agent_identity'>,
  upgrade = true
): Promise<Response> {
  const headers = new Headers();
  if (upgrade) {
    headers.set('Upgrade', 'websocket');
  }
  if (grant) {
    headers.set('Authorization', `Bearer ${grant.token}`);
    headers.set('X-Agent-Identity', grant.agent_identity);
  }
  return workerFetch(tunnelUrl(gigId), { headers });
}

async function connect(gigId: string, grant: TunnelGrant): Promise<WebSocket> {
  const response = await tunnelRequest(gigId, grant);
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error('Tunnel upgrade did not return a WebSocket');
  }
  socket.accept();
  return socket;
}

function getTunnelStub(gigId: string): DurableObjectStub<Automata> {
  return env.TUNNEL.get(env.TUNNEL.idFromName(gigId)) as DurableObjectStub<Automata>;
}

async function waitForConnectionCount(
  stub: DurableObjectStub<Automata>,
  expected: number
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = await runInDurableObject(
      stub,
      async (_instance, state) => state.getWebSockets().length
    );
    if (count === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} Durable Object WebSocket connections`);
}

describe('authenticated Durable Object WebSocket tunnel in workerd', () => {
  it('accepts exactly the buyer and claiming worker and relays only between their roles', async () => {
    const fixture = await createClaimedGig('tunnel-valid');
    const buyer = await connect(fixture.gig.gig_id, fixture.buyerGrant);
    const worker = await connect(fixture.gig.gig_id, fixture.workerGrant);
    const stub = getTunnelStub(fixture.gig.gig_id);
    await waitForConnectionCount(stub, 2);

    const workerMessage = waitForMessage(worker);
    buyer.send(JSON.stringify({ type: 'task', value: 42 }));
    expect((await workerMessage).data).toBe(JSON.stringify({ type: 'task', value: 42 }));

    const buyerMessage = waitForMessage(buyer);
    worker.send(JSON.stringify({ type: 'result', value: 84 }));
    expect((await buyerMessage).data).toBe(JSON.stringify({ type: 'result', value: 84 }));

    buyer.close(1000, 'done');
    worker.close(1000, 'done');
    await waitForConnectionCount(stub, 0);
  });

  it('rejects missing, invalid, identity-swapped, and gig-mismatched grants', async () => {
    const first = await createClaimedGig('tunnel-invalid-a', '0xbuyer-a', '0xworker-a');
    const second = await createClaimedGig('tunnel-invalid-b', '0xbuyer-b', '0xworker-b');

    expect((await tunnelRequest(first.gig.gig_id)).status).toBe(401);
    expect(
      (
        await tunnelRequest(first.gig.gig_id, {
          token: 'atg_v1_invalid',
          agent_identity: first.buyerGrant.agent_identity,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await tunnelRequest(first.gig.gig_id, {
          token: first.buyerGrant.token,
          agent_identity: first.workerGrant.agent_identity,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await tunnelRequest(second.gig.gig_id, {
          token: first.buyerGrant.token,
          agent_identity: second.buyerGrant.agent_identity,
        })
      ).status
    ).toBe(401);
    expect((await tunnelRequest(first.gig.gig_id, first.buyerGrant, false)).status).toBe(426);
  });

  it('rejects replayed grants and every third-party join attempt', async () => {
    const fixture = await createClaimedGig('tunnel-replay');
    const concurrentBuyerAttempts = await Promise.all([
      tunnelRequest(fixture.gig.gig_id, fixture.buyerGrant),
      tunnelRequest(fixture.gig.gig_id, fixture.buyerGrant),
    ]);
    expect(concurrentBuyerAttempts.map(({ status }) => status).sort()).toEqual([101, 401]);
    const acceptedBuyer = concurrentBuyerAttempts.find(({ status }) => status === 101);
    const buyer = acceptedBuyer?.webSocket;
    if (!buyer) {
      throw new Error('Expected exactly one concurrent buyer upgrade to succeed');
    }
    buyer.accept();
    const worker = await connect(fixture.gig.gig_id, fixture.workerGrant);
    const stub = getTunnelStub(fixture.gig.gig_id);
    await waitForConnectionCount(stub, 2);

    const thirdParty = await tunnelRequest(fixture.gig.gig_id, {
      token: 'atg_v1_third-party',
      agent_identity: '0xobserver',
    });
    expect(thirdParty.status).toBe(401);
    expect((await tunnelRequest(fixture.gig.gig_id, fixture.buyerGrant)).status).toBe(401);
    expect((await tunnelRequest(fixture.gig.gig_id, fixture.workerGrant)).status).toBe(401);
    await waitForConnectionCount(stub, 2);

    const relayed = waitForMessage(worker);
    buyer.send('private payload');
    expect((await relayed).data).toBe('private payload');

    buyer.close(1000, 'done');
    worker.close(1000, 'done');
    await waitForConnectionCount(stub, 0);
  });

  it('rejects expired grants inside the Durable Object', async () => {
    const fixture = await createClaimedGig('tunnel-expired');
    const stub = getTunnelStub(fixture.gig.gig_id);

    await runInDurableObject(stub, async (_instance, state) => {
      const session = await state.storage.get<TunnelSessionState>('tunnel_session');
      if (!session) {
        throw new Error('Expected a prepared tunnel session');
      }
      session.expires_at = new Date(Date.now() - 1_000).toISOString();
      await state.storage.put('tunnel_session', session);
    });

    const response = await tunnelRequest(fixture.gig.gig_id, fixture.buyerGrant);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: true, message: 'Tunnel grant expired' });
  });

  it('invalidates grants explicitly and on timeout', async () => {
    const revoked = await createClaimedGig('tunnel-revoked');
    const revokedBuyer = await connect(revoked.gig.gig_id, revoked.buyerGrant);
    const revokedBuyerClosed = waitForClose(revokedBuyer);
    const revokedStub = getTunnelStub(revoked.gig.gig_id);

    await revokedStub.revokeTunnelSession('gig completed');
    expect((await revokedBuyerClosed).code).toBe(4003);
    await waitForConnectionCount(revokedStub, 0);
    expect((await tunnelRequest(revoked.gig.gig_id, revoked.workerGrant)).status).toBe(401);

    const timedOut = await createClaimedGig('tunnel-timeout');
    const timeoutBuyer = await connect(timedOut.gig.gig_id, timedOut.buyerGrant);
    const timeoutWorker = await connect(timedOut.gig.gig_id, timedOut.workerGrant);
    const buyerClosed = waitForClose(timeoutBuyer);
    const workerClosed = waitForClose(timeoutWorker);
    const timeoutStub = getTunnelStub(timedOut.gig.gig_id);

    await runInDurableObject(timeoutStub, async (_instance, state) => {
      const session = await state.storage.get<TunnelSessionState>('tunnel_session');
      if (!session) throw new Error('Expected timeout session');
      session.expires_at = new Date(Date.now() - 1).toISOString();
      await state.storage.put('tunnel_session', session);
    });

    expect(await runDurableObjectAlarm(timeoutStub)).toBe(true);
    expect((await buyerClosed).code).toBe(4003);
    expect((await workerClosed).code).toBe(4003);
    await waitForConnectionCount(timeoutStub, 0);
  });

  it('closes a participant that exceeds the message-size limit', async () => {
    const fixture = await createClaimedGig('tunnel-message-limit');
    const buyer = await connect(fixture.gig.gig_id, fixture.buyerGrant);
    const buyerClosed = waitForClose(buyer);
    buyer.send('x'.repeat(64 * 1024 + 1));
    const close = await buyerClosed;
    expect(close.code).toBe(1009);
    expect(close.reason).toBe('Message too large');
    await waitForConnectionCount(getTunnelStub(fixture.gig.gig_id), 0);
  });
});
