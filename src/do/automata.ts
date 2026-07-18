import { DurableObject } from 'cloudflare:workers';
import type {
  ActivateTunnelSession,
  Env,
  GigLifecycleState,
  LifecycleCommand,
  LifecycleResult,
  PrepareTunnelSession,
  ReconnectTunnelSession,
  TunnelParticipantState,
  TunnelRole,
  TunnelSessionState,
} from '../types';
import {
  hashTunnelGrant,
  MAX_TUNNEL_GRANT_TOKEN_LENGTH,
  tunnelGrantHashesEqual,
} from '../services/tunnel-grants';
import {
  assertLifecycleTransition,
  CLAIM_TIMEOUT_MS,
  isTerminalLifecycleState,
  legacyStatusForLifecycle,
  PROJECTION_RETRY_MS,
  rememberOperation,
} from '../services/lifecycle';
import { logEvent, safeErrorName } from '../services/observability';
import { errorResponse, MAX_AGENT_IDENTITY_LENGTH } from '../utils/validation';

const SESSION_KEY = 'tunnel_session';
const MAX_MESSAGE_BYTES = 64 * 1024;
const AUTH_CLOSE_CODE = 4003;

type GrantRejectReason =
  | 'missing_credentials'
  | 'tunnel_inactive'
  | 'gig_mismatch'
  | 'grant_expired'
  | 'grant_revoked'
  | 'identity_mismatch'
  | 'grant_replayed'
  | 'invalid_grant'
  | 'participant_capacity';

type AuthorizationResult =
  | { authorized: true; role: TunnelRole }
  | {
      authorized: false;
      message: string;
      status: 401 | 409;
      reason: GrantRejectReason;
    };

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
  async prepareTunnelSession(input: PrepareTunnelSession): Promise<LifecycleResult> {
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
        return this.result(existing, true);
      }
      throw new Error('Tunnel session is already prepared with different participants');
    }

    const now = new Date().toISOString();
    const session: TunnelSessionState = {
      gig_id: input.gig_id,
      buyer: { identity: input.buyer_identity, grant_hash: input.buyer_grant_hash },
      expires_at: input.expires_at,
      lifecycle_state: 'POSTED',
      lifecycle_version: 0,
      lifecycle_updated_at: now,
      projection_pending: true,
      processed_operations: {},
    };
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.scheduleNextAlarm(session);
    logEvent('info', 'lifecycle.initialized', {
      correlation_id: input.correlation_id,
      gig_id: input.gig_id,
      lifecycle_state: 'POSTED',
      lifecycle_version: 0,
    });
    return this.result(session, false);
  }

  async publishGig(command: LifecycleCommand): Promise<LifecycleResult> {
    const session = await this.requireSession();
    const duplicate = this.operationResult(session, command.message_id);
    if (duplicate) return duplicate;
    await this.transition(session, 'DISCOVERABLE', command.correlation_id, 'payment_verified');
    rememberOperation(session, command.message_id, session.lifecycle_state);
    await this.persistAndProject(session, command.correlation_id);
    return this.result(session, false);
  }

  async activateTunnelSession(input: ActivateTunnelSession): Promise<LifecycleResult> {
    const session = await this.requireSession(input.gig_id);
    this.ensureNotExpired(session);

    const duplicate = this.operationResult(session, input.message_id);
    if (duplicate) {
      if (session.worker?.identity !== input.worker_identity) {
        return this.rejected(session, 'Idempotency key belongs to another worker');
      }
      if (!session.worker.consumed_at && session.lifecycle_state === 'TUNNEL_GRANTED') {
        session.worker.grant_hash = input.worker_grant_hash;
        await this.ctx.storage.put(SESSION_KEY, session);
        logEvent('info', 'tunnel.grant_rotated', {
          correlation_id: input.correlation_id,
          gig_id: session.gig_id,
          role: 'worker',
          reason: 'idempotent_claim_retry',
        });
        return { ...duplicate, accepted: true };
      }
      return this.rejected(session, 'Claim grant was already consumed; use reconnect');
    }

    if (session.lifecycle_state !== 'DISCOVERABLE') {
      return {
        ...this.result(session, false),
        accepted: false,
        rejection_reason: `Gig is not claimable from ${session.lifecycle_state}`,
      };
    }
    if (session.buyer.identity === input.worker_identity) {
      throw new Error('Buyer and worker identities must be distinct');
    }

    await this.transition(session, 'CLAIMED', input.correlation_id, 'worker_claimed');
    session.worker = { identity: input.worker_identity, grant_hash: input.worker_grant_hash };
    session.activated_at = new Date().toISOString();
    session.claim_expires_at = new Date(
      Math.min(Date.parse(session.expires_at), Date.now() + CLAIM_TIMEOUT_MS)
    ).toISOString();
    await this.transition(session, 'TUNNEL_GRANTED', input.correlation_id, 'grants_activated');
    rememberOperation(session, input.message_id, session.lifecycle_state);
    await this.persistAndProject(session, input.correlation_id);
    return { ...this.result(session, false), accepted: true };
  }

  async deliver(command: LifecycleCommand, grantHash: string): Promise<LifecycleResult> {
    const session = await this.requireSession();
    const duplicate = this.operationResult(session, command.message_id);
    if (duplicate) return duplicate;
    this.authorizeControl(session, 'worker', command.actor_identity, grantHash);
    if (session.lifecycle_state !== 'IN_PROGRESS') {
      return this.rejected(session, `Delivery is unavailable from ${session.lifecycle_state}`);
    }
    await this.transition(session, 'DELIVERED', command.correlation_id, 'worker_delivered');
    rememberOperation(session, command.message_id, session.lifecycle_state);
    await this.persistAndProject(session, command.correlation_id);
    return { ...this.result(session, false), accepted: true };
  }

  async complete(command: LifecycleCommand, grantHash: string): Promise<LifecycleResult> {
    const session = await this.requireSession();
    const duplicate = this.operationResult(session, command.message_id);
    if (duplicate) return duplicate;
    this.authorizeControl(session, 'buyer', command.actor_identity, grantHash);
    if (session.lifecycle_state !== 'DELIVERED') {
      return this.rejected(session, `Acceptance is unavailable from ${session.lifecycle_state}`);
    }
    await this.transition(session, 'COMPLETED', command.correlation_id, 'buyer_accepted');
    await this.transition(session, 'CLOSED', command.correlation_id, 'lifecycle_closed');
    rememberOperation(session, command.message_id, session.lifecycle_state);
    this.revokeSession(session, 'completed');
    await this.persistAndProject(session, command.correlation_id);
    this.closeAllSockets('Gig completed');
    return { ...this.result(session, false), accepted: true };
  }

  async cancel(command: LifecycleCommand, grantHash: string): Promise<LifecycleResult> {
    const session = await this.requireSession();
    const duplicate = this.operationResult(session, command.message_id);
    if (duplicate) return duplicate;
    this.authorizeControl(session, 'buyer', command.actor_identity, grantHash);
    if (
      !['DISCOVERABLE', 'CLAIMED', 'TUNNEL_GRANTED', 'IN_PROGRESS', 'DELIVERED'].includes(
        session.lifecycle_state
      )
    ) {
      return this.rejected(session, `Cancellation is unavailable from ${session.lifecycle_state}`);
    }
    await this.transition(
      session,
      'CANCELLED',
      command.correlation_id,
      command.reason ?? 'buyer_cancelled'
    );
    rememberOperation(session, command.message_id, session.lifecycle_state);
    this.revokeSession(session, 'cancelled');
    await this.persistAndProject(session, command.correlation_id);
    this.closeAllSockets('Gig cancelled');
    return { ...this.result(session, false), accepted: true };
  }

  async abandon(command: LifecycleCommand, grantHash: string): Promise<LifecycleResult> {
    const session = await this.requireSession();
    const duplicate = this.operationResult(session, command.message_id);
    if (duplicate) return duplicate;
    this.authorizeControl(session, 'worker', command.actor_identity, grantHash);
    if (!['TUNNEL_GRANTED', 'IN_PROGRESS', 'DELIVERED'].includes(session.lifecycle_state)) {
      return this.rejected(session, `Abandonment is unavailable from ${session.lifecycle_state}`);
    }
    await this.transition(
      session,
      'FAILED',
      command.correlation_id,
      command.reason ?? 'worker_abandoned'
    );
    rememberOperation(session, command.message_id, session.lifecycle_state);
    this.revokeSession(session, 'worker_abandoned');
    await this.persistAndProject(session, command.correlation_id);
    this.closeAllSockets('Worker abandoned gig');
    return { ...this.result(session, false), accepted: true };
  }

  async reconnectTunnelSession(input: ReconnectTunnelSession): Promise<LifecycleResult> {
    const session = await this.requireSession();
    const duplicate = this.operationResult(session, input.message_id);
    if (duplicate) return this.rejected(session, 'Reconnect operation was already applied');
    if (!['TUNNEL_GRANTED', 'IN_PROGRESS', 'DELIVERED'].includes(session.lifecycle_state)) {
      throw new Error(`Reconnect is unavailable from ${session.lifecycle_state}`);
    }
    const participant = input.role === 'buyer' ? session.buyer : session.worker;
    if (!participant || participant.identity !== input.actor_identity) {
      throw new Error('Tunnel grant identity mismatch');
    }
    if (!tunnelGrantHashesEqual(input.current_grant_hash, participant.grant_hash)) {
      throw new Error('Invalid tunnel grant');
    }
    if (this.ctx.getWebSockets(input.role).length > 0) {
      throw new Error('Participant is still connected');
    }
    participant.grant_hash = input.replacement_grant_hash;
    delete participant.consumed_at;
    rememberOperation(session, input.message_id, session.lifecycle_state);
    await this.ctx.storage.put(SESSION_KEY, session);
    logEvent('info', 'tunnel.grant_rotated', {
      correlation_id: input.correlation_id,
      gig_id: session.gig_id,
      role: input.role,
      reason: 'reconnect',
    });
    return this.result(session, false);
  }

  async getLifecycle(): Promise<LifecycleResult> {
    return this.result(await this.requireSession(), false);
  }

  async reconcileProjection(correlationId: string): Promise<LifecycleResult> {
    const session = await this.requireSession();
    await this.projectSession(session, correlationId);
    return this.result(session, false);
  }

  async revokeTunnelSession(reason: string, correlationId = crypto.randomUUID()): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (!session || session.revoked_at) return;
    if (!isTerminalLifecycleState(session.lifecycle_state)) {
      await this.transition(session, 'FAILED', correlationId, reason);
    }
    this.revokeSession(session, reason);
    await this.persistAndProject(session, correlationId);
    this.closeAllSockets('Tunnel grants revoked');
  }

  async alarm(): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (!session) return;
    const correlationId = crypto.randomUUID();
    const now = Date.now();

    if (
      !isTerminalLifecycleState(session.lifecycle_state) &&
      Date.parse(session.expires_at) <= now
    ) {
      await this.transition(session, 'EXPIRED', correlationId, 'gig_deadline');
      this.revokeSession(session, 'expired');
      await this.persistAndProject(session, correlationId);
      this.closeAllSockets('Tunnel grant expired');
      return;
    }

    if (
      session.lifecycle_state === 'TUNNEL_GRANTED' &&
      session.claim_expires_at &&
      Date.parse(session.claim_expires_at) <= now &&
      !session.buyer.consumed_at &&
      !session.worker?.consumed_at
    ) {
      await this.transition(session, 'DISCOVERABLE', correlationId, 'claim_timeout');
      delete session.worker;
      delete session.activated_at;
      delete session.claim_expires_at;
      await this.persistAndProject(session, correlationId);
      return;
    }

    if (session.projection_pending) {
      await this.projectSession(session, correlationId);
    }
    await this.scheduleNextAlarm(session);
  }

  async fetch(request: Request): Promise<Response> {
    const correlationId = request.headers.get('X-Correlation-ID') ?? crypto.randomUUID();
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
      logEvent('warn', 'tunnel.grant_rejected', {
        correlation_id: correlationId,
        reason: 'missing_credentials',
        outcome: 'rejected',
        status: 401,
      });
      return errorResponse('Valid tunnel grant and agent identity required', 401);
    }

    const providedHash = await hashTunnelGrant(token);
    const authorization = await this.authorizeJoin(
      new URL(request.url).pathname,
      agentIdentity,
      providedHash
    );
    if (!authorization.authorized) {
      logEvent('warn', 'tunnel.grant_rejected', {
        correlation_id: correlationId,
        reason: authorization.reason,
        outcome: 'rejected',
        status: authorization.status,
      });
      return errorResponse(authorization.message, authorization.status);
    }

    const session = await this.requireSession();
    if (session.lifecycle_state === 'TUNNEL_GRANTED') {
      await this.transition(session, 'IN_PROGRESS', correlationId, 'participant_joined');
      delete session.claim_expires_at;
      await this.persistAndProject(session, correlationId);
    }
    logEvent('info', 'tunnel.grant_accepted', {
      correlation_id: correlationId,
      gig_id: session.gig_id,
      role: authorization.role,
      outcome: 'accepted',
    });

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    this.ctx.acceptWebSocket(server, [authorization.role]);
    return new Response(null, { status: 101, webSocket: client });
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
      if (session && !session.revoked_at && !isTerminalLifecycleState(session.lifecycle_state)) {
        const correlationId = crypto.randomUUID();
        await this.transition(session, 'EXPIRED', correlationId, 'gig_deadline_mid_tunnel');
        this.revokeSession(session, 'expired');
        await this.persistAndProject(session, correlationId);
      }
      this.closeAllSockets('Tunnel grant expired');
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
        logEvent('error', 'tunnel.relay_failed', {
          correlation_id: crypto.randomUUID(),
          gig_id: session.gig_id,
          role: senderRole,
          error_name: safeErrorName(error),
        });
      }
    }
  }

  async webSocketClose(_ws: WebSocket, code: number, _reason: string): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    logEvent('info', 'tunnel.socket_closed', {
      correlation_id: crypto.randomUUID(),
      gig_id: session?.gig_id,
      outcome: String(code),
    });
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    logEvent('error', 'tunnel.socket_error', {
      correlation_id: crypto.randomUUID(),
      gig_id: session?.gig_id,
      error_name: safeErrorName(error),
    });
  }

  private async requireSession(gigId?: string): Promise<TunnelSessionState> {
    const session = await this.ctx.storage.get<TunnelSessionState>(SESSION_KEY);
    if (!session || (gigId && session.gig_id !== gigId))
      throw new Error('Tunnel session is not prepared for this gig');
    return session;
  }

  private ensureNotExpired(session: TunnelSessionState): void {
    if (session.revoked_at || Date.parse(session.expires_at) <= Date.now())
      throw new Error('Tunnel session is expired or revoked');
  }

  private findParticipant(
    session: TunnelSessionState,
    agentIdentity: string
  ): { role: TunnelRole; state: TunnelParticipantState } | null {
    if (session.buyer.identity === agentIdentity) return { role: 'buyer', state: session.buyer };
    if (session.worker?.identity === agentIdentity)
      return { role: 'worker', state: session.worker };
    return null;
  }

  private authorizeControl(
    session: TunnelSessionState,
    role: TunnelRole,
    identity: string,
    grantHash: string
  ): void {
    this.ensureNotExpired(session);
    const participant = role === 'buyer' ? session.buyer : session.worker;
    if (
      !participant ||
      participant.identity !== identity ||
      !tunnelGrantHashesEqual(grantHash, participant.grant_hash)
    )
      throw new Error('Invalid lifecycle authorization');
  }

  private authorizeJoin(
    requestPath: string,
    agentIdentity: string,
    providedHash: string
  ): Promise<AuthorizationResult> {
    return this.ctx.storage.transaction(async (transaction) => {
      const session = await transaction.get<TunnelSessionState>(SESSION_KEY);
      if (
        !session ||
        !session.worker ||
        !['TUNNEL_GRANTED', 'IN_PROGRESS', 'DELIVERED'].includes(session.lifecycle_state)
      )
        return {
          authorized: false,
          message: 'Tunnel is not active',
          status: 401,
          reason: 'tunnel_inactive',
        };
      const expectedPath = `/v1/gigs/${encodeURIComponent(session.gig_id)}/tunnel`;
      if (requestPath !== expectedPath)
        return {
          authorized: false,
          message: 'Tunnel grant does not match this gig',
          status: 401,
          reason: 'gig_mismatch',
        };
      if (Date.parse(session.expires_at) <= Date.now())
        return {
          authorized: false,
          message: 'Tunnel grant expired',
          status: 401,
          reason: 'grant_expired',
        };
      if (session.revoked_at)
        return {
          authorized: false,
          message: 'Tunnel grants revoked',
          status: 401,
          reason: 'grant_revoked',
        };
      const participant = this.findParticipant(session, agentIdentity);
      if (!participant)
        return {
          authorized: false,
          message: 'Tunnel grant identity mismatch',
          status: 401,
          reason: 'identity_mismatch',
        };
      if (participant.state.consumed_at)
        return {
          authorized: false,
          message: 'Tunnel grant already used',
          status: 401,
          reason: 'grant_replayed',
        };
      if (!tunnelGrantHashesEqual(providedHash, participant.state.grant_hash))
        return {
          authorized: false,
          message: 'Invalid tunnel grant',
          status: 401,
          reason: 'invalid_grant',
        };
      if (
        this.ctx.getWebSockets(participant.role).length > 0 ||
        this.ctx.getWebSockets().length >= 2
      )
        return {
          authorized: false,
          message: 'Tunnel already has both authorized participants',
          status: 409,
          reason: 'participant_capacity',
        };
      participant.state.consumed_at = new Date().toISOString();
      await transaction.put(SESSION_KEY, session);
      return { authorized: true, role: participant.role };
    });
  }

  private async transition(
    session: TunnelSessionState,
    to: GigLifecycleState,
    correlationId: string,
    reason: string
  ): Promise<void> {
    const from = session.lifecycle_state;
    assertLifecycleTransition(from, to);
    session.lifecycle_state = to;
    session.lifecycle_version += 1;
    session.lifecycle_updated_at = new Date().toISOString();
    session.projection_pending = true;
    logEvent('info', 'lifecycle.transition', {
      correlation_id: correlationId,
      gig_id: session.gig_id,
      from_state: from,
      to_state: to,
      lifecycle_state: to,
      lifecycle_version: session.lifecycle_version,
      reason,
    });
  }

  private operationResult(session: TunnelSessionState, messageId: string): LifecycleResult | null {
    return session.processed_operations[messageId] ? this.result(session, true) : null;
  }

  private result(session: TunnelSessionState, duplicate: boolean): LifecycleResult {
    return {
      gig_id: session.gig_id,
      lifecycle_state: session.lifecycle_state,
      lifecycle_version: session.lifecycle_version,
      duplicate,
    };
  }

  private rejected(session: TunnelSessionState, reason: string): LifecycleResult {
    return { ...this.result(session, false), accepted: false, rejection_reason: reason };
  }

  private revokeSession(session: TunnelSessionState, reason: string): void {
    if (!session.revoked_at) session.revoked_at = new Date().toISOString();
    session.revocation_reason = reason.slice(0, 120) || 'revoked';
  }

  private async persistAndProject(
    session: TunnelSessionState,
    correlationId: string
  ): Promise<void> {
    await this.ctx.storage.put(SESSION_KEY, session);
    await this.projectSession(session, correlationId);
  }

  private async projectSession(session: TunnelSessionState, correlationId: string): Promise<void> {
    try {
      const result = await this.env.DB.prepare(
        `UPDATE agent_gigs SET status = ?, lifecycle_state = ?, lifecycle_version = ?, updated_at = ?, worker_pubkey = ? WHERE gig_id = ? AND lifecycle_version <= ?`
      )
        .bind(
          legacyStatusForLifecycle(session.lifecycle_state),
          session.lifecycle_state,
          session.lifecycle_version,
          session.lifecycle_updated_at,
          session.worker?.identity ?? null,
          session.gig_id,
          session.lifecycle_version
        )
        .run();
      if (!result.success || result.meta.changes === 0) {
        throw new Error('D1 lifecycle projection write failed or gig row is missing');
      }
      session.projection_pending = false;
      await this.ctx.storage.put(SESSION_KEY, session);
      logEvent('info', 'lifecycle.projection_synced', {
        correlation_id: correlationId,
        gig_id: session.gig_id,
        lifecycle_state: session.lifecycle_state,
        lifecycle_version: session.lifecycle_version,
        outcome: 'success',
      });
    } catch (error) {
      session.projection_pending = true;
      await this.ctx.storage.put(SESSION_KEY, session);
      logEvent('error', 'lifecycle.projection_failed', {
        correlation_id: correlationId,
        gig_id: session.gig_id,
        lifecycle_state: session.lifecycle_state,
        lifecycle_version: session.lifecycle_version,
        outcome: 'retry_scheduled',
        error_name: safeErrorName(error),
      });
    }
    await this.scheduleNextAlarm(session);
  }

  private async scheduleNextAlarm(session: TunnelSessionState): Promise<void> {
    if (isTerminalLifecycleState(session.lifecycle_state) && !session.projection_pending) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const candidates = [Date.parse(session.expires_at)];
    if (session.claim_expires_at) candidates.push(Date.parse(session.claim_expires_at));
    if (session.projection_pending) candidates.push(Date.now() + PROJECTION_RETRY_MS);
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 1, Math.min(...candidates.filter(Number.isFinite)))
    );
  }

  private closeAllSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets()) socket.close(AUTH_CLOSE_CODE, reason);
  }
}
