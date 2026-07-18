/**
 * Automata MVP — Claim Gig Handler
 */

import type { Context } from 'hono';
import type { Env } from '../types';
import { validateClaimGigPayload, errorResponse, jsonResponse } from '../utils/validation';
import { createTunnelGrant, hashTunnelGrant } from '../services/tunnel-grants';

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
    const gig = await env.DB.prepare(
      `SELECT buyer_pubkey, expires_at
       FROM agent_gigs
       WHERE gig_id = ? AND status = 'ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    )
      .bind(payload.payload.gig_id)
      .first<{ buyer_pubkey: string; expires_at: string }>();

    if (!gig || gig.buyer_pubkey === payload.sender) {
      return errorResponse('Gig not found, already claimed, expired, or self-claimed', 404);
    }

    const workerGrant = createTunnelGrant('worker', payload.sender, gig.expires_at);
    const workerGrantHash = await hashTunnelGrant(workerGrant.token);

    // Attempt to claim the gig atomically.
    // It must exist, be ACTIVE, and not be expired.
    const result = await env.DB.prepare(
      `UPDATE agent_gigs
       SET status = 'IN_PROGRESS', worker_pubkey = ?
       WHERE gig_id = ? AND status = 'ACTIVE'
         AND buyer_pubkey <> ?
         AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    )
      .bind(payload.sender, payload.payload.gig_id, payload.sender)
      .run();

    if (!result.success || result.meta.changes === 0) {
      return errorResponse('Gig not found, already claimed, or expired', 404);
    }

    try {
      await env.TUNNEL.getByName(payload.payload.gig_id).activateTunnelSession({
        gig_id: payload.payload.gig_id,
        worker_identity: payload.sender,
        worker_grant_hash: workerGrantHash,
      });
    } catch (activationError) {
      console.error('Tunnel activation error:', activationError);
      try {
        await env.TUNNEL.getByName(payload.payload.gig_id).revokeTunnelSession(
          'claim activation failed'
        );
      } catch (revocationError) {
        console.error('Failed to revoke tunnel after activation error:', revocationError);
      }
      await env.DB.prepare(
        `UPDATE agent_gigs
         SET status = 'EXPIRED'
         WHERE gig_id = ? AND status = 'IN_PROGRESS' AND worker_pubkey = ?`
      )
        .bind(payload.payload.gig_id, payload.sender)
        .run();
      return errorResponse('Failed to activate authenticated tunnel', 500);
    }

    // Gig claimed successfully. Provide the tunnel connection info.
    // The client will connect to wss://<host>/v1/gigs/<gig_id>/tunnel
    const host = c.req.header('host') || 'automata.board';
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'ws' : 'wss';
    const tunnelUrl = `${protocol}://${host}/v1/gigs/${payload.payload.gig_id}/tunnel`;

    return jsonResponse(
      {
        message: 'Gig claimed successfully',
        gig_id: payload.payload.gig_id,
        tunnel_url: tunnelUrl,
        tunnel_grant: workerGrant,
      },
      200
    );
  } catch (err) {
    console.error('Claim gig error:', err);
    return errorResponse('Internal server error', 500);
  }
}
