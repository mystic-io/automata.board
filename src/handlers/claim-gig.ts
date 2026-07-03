/**
 * Automata MVP — Claim Gig Handler
 */

import type { Context } from 'hono';
import type { Env } from '../types';
import { validateClaimGigPayload, errorResponse, jsonResponse } from '../utils/validation';

export async function handleClaimGig(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  const validationResult = validateClaimGigPayload(body);
  if (validationResult.errors.length > 0 || !validationResult.data) {
    return errorResponse('Validation failed', 400, { errors: validationResult.errors });
  }
  const payload = validationResult.data;

  try {
    // Attempt to claim the gig atomically.
    // It must exist, be ACTIVE, and not be expired.
    const result = await env.DB.prepare(
      `UPDATE agent_gigs
       SET status = 'IN_PROGRESS', worker_pubkey = ?
       WHERE gig_id = ? AND status = 'ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).bind(payload.sender, payload.payload.gig_id).run();

    if (!result.success || result.meta.changes === 0) {
      return errorResponse('Gig not found, already claimed, or expired', 404);
    }

    // Gig claimed successfully. Provide the tunnel connection info.
    // The client will connect to wss://<host>/v1/gigs/<gig_id>/tunnel
    const host = c.req.header('host') || 'automata.board';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'ws' : 'wss';
    const tunnelUrl = `${protocol}://${host}/v1/gigs/${payload.payload.gig_id}/tunnel`;

    return jsonResponse({
      message: 'Gig claimed successfully',
      gig_id: payload.payload.gig_id,
      tunnel_url: tunnelUrl
    }, 200);
  } catch (err) {
    console.error('Claim gig error:', err);
    return errorResponse('Internal server error', 500);
  }
}
