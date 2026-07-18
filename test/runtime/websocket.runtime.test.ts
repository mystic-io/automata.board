import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Automata } from '../../src/do/automata';
import { seedGig, workerFetch } from './helpers';

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

async function connect(gigId: string): Promise<WebSocket> {
  const response = await workerFetch(`http://automata.test/v1/gigs/${gigId}/tunnel`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error('Tunnel upgrade did not return a WebSocket');
  }
  socket.accept();
  return socket;
}

async function waitForConnectionCount(stub: DurableObjectStub, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = await runInDurableObject(
      stub,
      async (_instance: Automata, state) => state.getWebSockets().length
    );
    if (count === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} Durable Object WebSocket connections`);
}

describe('Durable Object WebSocket tunnel in workerd', () => {
  it('routes messages between peers and supports disconnect/reconnect', async () => {
    const gigId = await seedGig(env.DB);
    const buyer = await connect(gigId);
    const worker = await connect(gigId);
    const stub = env.TUNNEL.get(env.TUNNEL.idFromName(gigId));
    await waitForConnectionCount(stub, 2);

    const firstMessage = waitForMessage(worker);
    buyer.send(JSON.stringify({ type: 'task', value: 42 }));
    expect((await firstMessage).data).toBe(JSON.stringify({ type: 'task', value: 42 }));

    worker.close(1000, 'reconnect');
    await waitForConnectionCount(stub, 1);

    const reconnectedWorker = await connect(gigId);
    await waitForConnectionCount(stub, 2);
    const secondMessage = waitForMessage(reconnectedWorker);
    buyer.send('after-reconnect');
    expect((await secondMessage).data).toBe('after-reconnect');

    buyer.close(1000, 'done');
    reconnectedWorker.close(1000, 'done');
  });

  it('rejects invalid tunnel requests and oversized messages', async () => {
    const missingResponse = await workerFetch(
      'http://automata.test/v1/gigs/00000000-0000-4000-8000-000000000000/tunnel',
      { headers: { Upgrade: 'websocket' } }
    );
    expect(missingResponse.status).toBe(404);

    const gigId = await seedGig(env.DB);
    const noUpgradeResponse = await workerFetch(`http://automata.test/v1/gigs/${gigId}/tunnel`);
    expect(noUpgradeResponse.status).toBe(426);

    const sender = await connect(gigId);
    const senderClosed = waitForClose(sender);
    sender.send('x'.repeat(64 * 1024 + 1));
    const close = await senderClosed;
    expect(close.code).toBe(1009);
    expect(close.reason).toBe('Message too large');
  });

  it('closes connected peers when the Durable Object alarm fires', async () => {
    const gigId = await seedGig(env.DB);
    const buyer = await connect(gigId);
    const worker = await connect(gigId);
    const buyerClosed = waitForClose(buyer);
    const workerClosed = waitForClose(worker);

    const stub = env.TUNNEL.get(env.TUNNEL.idFromName(gigId));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await buyerClosed).code).toBe(1011);
    expect((await workerClosed).code).toBe(1011);
  });
});
