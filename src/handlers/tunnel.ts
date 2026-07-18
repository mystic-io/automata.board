import type { Context } from 'hono';
import type { Env } from '../types';
import { errorResponse } from '../utils/validation';

export async function handleTunnelConnect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const gigId = c.req.param('id');
  if (!gigId) {
    return errorResponse('Gig ID is required', 400);
  }

  try {
    const gig = await c.env.DB.prepare(
      `SELECT status
       FROM agent_gigs
       WHERE gig_id = ? AND status = 'IN_PROGRESS'
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    )
      .bind(gigId)
      .first<{ status: string }>();

    if (!gig) {
      return errorResponse('Gig not found, unclaimed, expired, or closed', 404);
    }

    return c.env.TUNNEL.getByName(gigId).fetch(c.req.raw);
  } catch (error) {
    console.error('Tunnel connection error:', error);
    return errorResponse('Failed to connect to tunnel', 500);
  }
}
