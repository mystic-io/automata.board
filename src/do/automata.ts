/**
 * Automata MVP — authenticated two-party Gig Tunnel Durable Object.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  ActivateTunnelSession,
  Env,
  PrepareTunnelSession,
  TunnelParticipantState,
  TunnelRole,
  TunnelSessionState,
} from '../types';
import {
  hashTunnelGrant,
  MAX_TUNNEL_GRANT_TOKEN_LENGTH,
  tunnelGrantHashesEqual,
} from '../services/tunnel-grants';
import { errorResponse, MAX_AGENT_IDENTITY_LENGTH } from '../utils/validation';

const SESSION_KEY = 'tunnel_session';
const MAX_MESSAGE_BYTES = 64 * 1024;
const AUTH_CLOSE_CODE = 4003;

type AuthorizationResult =
  | { authorized: true; role: TunnelRole }
  | { authorized: false; message: string; status: 401 | 409 };

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function isPingMessage(message: string): boolean {
  try {
    const data: unknown = JSON.parse(message);
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      (data as { type?: unknown }).type === 'ping'
    );
  } catch {
    return false;
  }
}

export class Automata extends DurableObject<Env> {
  async prepareTunnelSession(input: PrepareTunnelSession): Promise<void> {
    const expiresAtMs = Date.parse(input.expires_at);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('Tunnel session expiry must be in the future');
    }

    const existing = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (existing) {
      const isSamePreparation =
        existing.gig_id === input.gig_id &&
        existing.buyer.identity === input.buyer_identity &&
        existing.buyer.grant_hash === input.buyer_grant_hash &&
        existing.expires_at === input.expires_at;
      if (isSamePreparation) {
        return;
      }
      throw new Error('Tunnel session is already prepared with different participants');
    }

    const session: TunnelSessionState = {
      gig_id: input.gig_id,
      buyer: {
        identity: input.buyer_identity,
        grant_hash: input.buyer_grant_hash,
      },
      expires_at: input.expires_at,
    };

    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.setAlarm(expiresAtMs);
  }

  async activateTunnelSession(input: ActivateTunnelSession): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (!session || session.gig_id !== input.gig_id) {
      throw new Error('Tunnel session is not prepared for this gig');
    }
    if (session.revoked_at || Date.parse(session.expires_at) <= Date.now()) {
      throw new Error('Tunnel session is expired or revoked');
    }
    if (session.buyer.identity === input.worker_identity) {
      throw new Error('Buyer and worker identities must be distinct');
    }

    if (session.worker) {
      const isSameActivation =
        session.worker.identity === input.worker_identity &&
        session.worker.grant_hash === input.worker_grant_hash;
      if (isSameActivation) {
        return;
      }
      throw new Error('Tunnel session is already activated by another worker');
    }

    session.worker = {
      identity: input.worker_identity,
      grant_hash: input.worker_grant_hash,
    };
    session.activated_at = new Date().toISOString();
    await this.ctx.storage.put(SESSION_KEY, session);
  }

  async revokeTunnelSession(reason: string): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (!session || session.revoked_at) {
      return;
    }

    session.revoked_at = new Date().toISOString();
    session.revocation_reason = reason.slice(0, 120) || 'revoked';
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.deleteAlarm();
    this.closeAllSockets('Tunnel grants revoked');
  }

  async alarm(): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (session && !session.revoked_at) {
      session.revoked_at = new Date().toISOString();
      session.revocation_reason = 'expired';
      await this.ctx.storage.put(SESSION_KEY, session);
    }
    this.closeAllSockets('Tunnel grant expired');
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return errorResponse('Expected Upgrade: websocket', 426);
    }

    const token = getBearerToken(request);
    const agentIdentity = request.headers.get('X-Agent-Identity')?.trim();
    if (
      !token ||
      token.length > MAX_TUNNEL_GRANT_TOKEN_LENGTH ||
      !agentIdentity ||
      agentIdentity.length > MAX_AGENT_IDENTITY_LENGTH
    ) {
      return errorResponse('Valid tunnel grant and agent identity required', 401);
    }

    const providedHash = await hashTunnelGrant(token);
    const authorization = await this.authorizeJoin(
      new URL(request.url).pathname,
      agentIdentity,
      providedHash
    );
    if (!authorization.authorized) {
      if (authorization.message === 'Tunnel grant expired') {
        await this.ctx.storage.deleteAlarm();
        this.closeAllSockets('Tunnel grant expired');
      }
      return errorResponse(authorization.message, authorization.status);
    }

    const { role } = authorization;

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.ctx.acceptWebSocket(server, [role]);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const messageBytes =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (messageBytes > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'Message too large');
      return;
    }

    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) {
      if (session && !session.revoked_at) {
        await this.expireSession(session);
      } else {
        ws.close(AUTH_CLOSE_CODE, 'Tunnel grants revoked');
      }
      return;
    }

    if (typeof message === 'string' && isPingMessage(message)) {
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      return;
    }

    const senderRole = this.ctx
      .getTags(ws)
      .find((tag): tag is TunnelRole => tag === 'buyer' || tag === 'worker');
    if (!senderRole) {
      ws.close(AUTH_CLOSE_CODE, 'Unauthorized tunnel participant');
      return;
    }

    const recipientRole: TunnelRole = senderRole === 'buyer' ? 'worker' : 'buyer';
    for (const socket of this.ctx.getWebSockets(recipientRole)) {
      try {
        socket.send(message);
      } catch (error) {
        console.error('Failed to relay tunnel message', error);
      }
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    console.log(`WebSocket closed: ${code} ${reason}`);
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
  }

  private findParticipant(
    session: TunnelSessionState,
    agentIdentity: string
  ): { role: TunnelRole; state: TunnelParticipantState } | null {
    if (session.buyer.identity === agentIdentity) {
      return { role: 'buyer', state: session.buyer };
    }
    if (session.worker?.identity === agentIdentity) {
      return { role: 'worker', state: session.worker };
    }
    return null;
  }

  private authorizeJoin(
    requestPath: string,
    agentIdentity: string,
    providedHash: string
  ): Promise<AuthorizationResult> {
    return this.ctx.storage.transaction(async (transaction) => {
      const session = await transaction.get<TunnelSessionState>(SESSION_KEY);
      if (!session || !session.worker || !session.activated_at) {
        return { authorized: false, message: 'Tunnel is not active', status: 401 };
      }

      const expectedPath = `/v1/gigs/${encodeURIComponent(session.gig_id)}/tunnel`;
      if (requestPath !== expectedPath) {
        return {
          authorized: false,
          message: 'Tunnel grant does not match this gig',
          status: 401,
        };
      }
      if (Date.parse(session.expires_at) <= Date.now()) {
        if (!session.revoked_at) {
          session.revoked_at = new Date().toISOString();
          session.revocation_reason = 'expired';
          await transaction.put(SESSION_KEY, session);
        }
        return { authorized: false, message: 'Tunnel grant expired', status: 401 };
      }
      if (session.revoked_at) {
        return { authorized: false, message: 'Tunnel grants revoked', status: 401 };
      }

      const participant = this.findParticipant(session, agentIdentity);
      if (!participant) {
        return { authorized: false, message: 'Tunnel grant identity mismatch', status: 401 };
      }
      if (participant.state.consumed_at) {
        return { authorized: false, message: 'Tunnel grant already used', status: 401 };
      }
      if (!tunnelGrantHashesEqual(providedHash, participant.state.grant_hash)) {
        return { authorized: false, message: 'Invalid tunnel grant', status: 401 };
      }
      if (
        this.ctx.getWebSockets(participant.role).length > 0 ||
        this.ctx.getWebSockets().length >= 2
      ) {
        return {
          authorized: false,
          message: 'Tunnel already has both authorized participants',
          status: 409,
        };
      }

      participant.state.consumed_at = new Date().toISOString();
      await transaction.put(SESSION_KEY, session);
      return { authorized: true, role: participant.role };
    });
  }

  private async expireSession(session: TunnelSessionState): Promise<void> {
    session.revoked_at = new Date().toISOString();
    session.revocation_reason = 'expired';
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.ctx.storage.deleteAlarm();
    this.closeAllSockets('Tunnel grant expired');
  }

  private closeAllSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(AUTH_CLOSE_CODE, reason);
    }
  }
}
