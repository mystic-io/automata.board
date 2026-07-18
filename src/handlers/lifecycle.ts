import type { AppContext } from '../types';
import {
  createTunnelGrant,
  hashTunnelGrant,
  MAX_TUNNEL_GRANT_TOKEN_LENGTH,
} from '../services/tunnel-grants';
import {
  errorResponse,
  jsonResponse,
  validateLifecycleActionPayload,
  validateReconnectPayload,
} from '../utils/validation';

function bearerToken(c: AppContext): string | null {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token && token.length <= MAX_TUNNEL_GRANT_TOKEN_LENGTH ? token : null;
}

function errorForLifecycle(error: unknown): Response {
  const message = error instanceof Error ? error.message : '';
  if (
    message.includes('authorization') ||
    message.includes('grant') ||
    message.includes('identity') ||
    message.includes('expired') ||
    message.includes('revoked')
  )
    return errorResponse('Invalid lifecycle authorization', 401);
  if (
    message.includes('Invalid lifecycle transition') ||
    message.includes('unavailable') ||
    message.includes('connected')
  )
    return errorResponse(message, 409);
  if (message.includes('not prepared')) return errorResponse('Gig not found', 404);
  console.error('Lifecycle action error:', error);
  return errorResponse('Failed to update gig lifecycle', 500);
}

export async function handleLifecycleAction(c: AppContext): Promise<Response> {
  const gigId = c.req.param('id');
  const token = bearerToken(c);
  if (!gigId || !token) return errorResponse('Gig ID and bearer grant are required', 401);
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  const validation = validateLifecycleActionPayload(value, gigId);
  if (!validation.data) return errorResponse('Validation failed', 400, validation.errors);
  const body = validation.data;
  const command = {
    message_id: body.message_id,
    actor_identity: body.sender,
    correlation_id: c.get('correlationId'),
    reason: body.payload.reason,
  };
  const grantHash = await hashTunnelGrant(token);
  const stub = c.env.TUNNEL.getByName(gigId);
  try {
    const result =
      body.type === 'TaskDelivery'
        ? await stub.deliver(command, grantHash)
        : body.type === 'TaskAcceptance'
          ? await stub.complete(command, grantHash)
          : body.type === 'TaskCancellation'
            ? await stub.cancel(command, grantHash)
            : await stub.abandon(command, grantHash);
    if (result.accepted === false)
      return errorResponse(result.rejection_reason ?? 'Invalid lifecycle transition', 409);
    return jsonResponse({ message: 'Lifecycle updated', ...result });
  } catch (error) {
    return errorForLifecycle(error);
  }
}

export async function handleReconnect(c: AppContext): Promise<Response> {
  const gigId = c.req.param('id');
  const token = bearerToken(c);
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }
  if (!gigId || !token) return errorResponse('Validation failed', 400);
  const validation = validateReconnectPayload(value);
  if (!validation.data) return errorResponse('Validation failed', 400, validation.errors);
  const body = validation.data;
  const role = body.role;
  const replacement = createTunnelGrant(role, body.sender, new Date(Date.now() + 1).toISOString());
  const stub = c.env.TUNNEL.getByName(gigId);
  try {
    const lifecycle = await stub.getLifecycle();
    const row = await c.env.DB.prepare('SELECT expires_at FROM agent_gigs WHERE gig_id = ?')
      .bind(gigId)
      .first<{ expires_at: string }>();
    if (!row) return errorResponse('Gig not found', 404);
    replacement.expires_at = row.expires_at;
    const result = await stub.reconnectTunnelSession({
      message_id: body.message_id,
      actor_identity: body.sender,
      role,
      current_grant_hash: await hashTunnelGrant(token),
      replacement_grant_hash: await hashTunnelGrant(replacement.token),
      correlation_id: c.get('correlationId'),
    });
    if (result.accepted === false)
      return errorResponse(result.rejection_reason ?? 'Reconnect rejected', 409);
    return jsonResponse({
      message: 'Reconnect grant issued',
      lifecycle,
      ...result,
      tunnel_grant: replacement,
    });
  } catch (error) {
    return errorForLifecycle(error);
  }
}

export async function handleLifecycleStatus(c: AppContext): Promise<Response> {
  const gigId = c.req.param('id');
  if (!gigId) return errorResponse('Gig ID is required', 400);
  try {
    return jsonResponse({
      message: 'Lifecycle status',
      ...(await c.env.TUNNEL.getByName(gigId).getLifecycle()),
    });
  } catch (error) {
    return errorForLifecycle(error);
  }
}
