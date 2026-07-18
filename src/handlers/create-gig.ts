/**
 * Automata MVP — Create Gig Handler
 *
 * POST /v1/gigs/create
 *
 * Implements the gig creation lifecycle.
 * Note: x402 payment verification is handled by middleware
 * BEFORE this handler is executed. If this runs, payment is complete.
 *
 * 1. Parse & validate the JSON payload
 * 2. Run AI moderation (injection scan + OpenAI)
 * 3. Insert into D1 with status = 'ACTIVE', return 201
 */

import type { Env, GigRecord } from '../types';
import { validateCreateGigPayload, jsonResponse, errorResponse } from '../utils/validation';
import type { Context } from 'hono';
import { createTunnelGrant, hashTunnelGrant } from '../services/tunnel-grants';

/**
 * Handles POST /v1/gigs/create
 */
export async function handleCreateGig(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // -----------------------------------------------------------------------
  // Step 1: Parse & Validate
  // -----------------------------------------------------------------------

  // Safely limit body size to 1MB before JSON parsing
  const rawText = await c.req.text();
  if (rawText.length > 1024 * 1024) {
    return errorResponse('Payload too large', 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    return errorResponse('Invalid JSON in request body', 400);
  }

  const validation = validateCreateGigPayload(body);
  if (validation.errors.length > 0) {
    return errorResponse('Validation failed', 400, validation.errors);
  }

  const payload = validation.data!;

  // -----------------------------------------------------------------------
  // Step 2: Write to D1
  // -----------------------------------------------------------------------

  const gigId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + payload.payload.ttl_minutes * 60 * 1000);
  const buyerGrant = createTunnelGrant('buyer', payload.sender, expiresAt.toISOString());
  const buyerGrantHash = await hashTunnelGrant(buyerGrant.token);

  const gigRecord: GigRecord = {
    gig_id: gigId,
    buyer_pubkey: payload.sender,
    title: payload.payload.title,
    description: payload.payload.description,
    task_type: payload.payload.task_type,
    payload_json: JSON.stringify(payload.payload.task_params),
    bounty_sats: payload.payload.bounty_sats,
    status: 'ACTIVE',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO agent_gigs (gig_id, buyer_pubkey, title, description, task_type, payload_json, bounty_sats, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        gigRecord.gig_id,
        gigRecord.buyer_pubkey,
        gigRecord.title,
        gigRecord.description,
        gigRecord.task_type,
        gigRecord.payload_json,
        gigRecord.bounty_sats,
        gigRecord.status,
        gigRecord.created_at,
        gigRecord.expires_at
      )
      .run();

    const tunnel = env.TUNNEL.getByName(gigId);
    await tunnel.prepareTunnelSession({
      gig_id: gigId,
      buyer_identity: payload.sender,
      buyer_grant_hash: buyerGrantHash,
      expires_at: expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('Gig creation or tunnel preparation error:', err);
    try {
      await env.TUNNEL.getByName(gigId).revokeTunnelSession('gig creation failed');
      await env.DB.prepare('DELETE FROM agent_gigs WHERE gig_id = ?').bind(gigId).run();
    } catch (cleanupError) {
      console.error('Failed to clean up partially created gig:', cleanupError);
    }
    return errorResponse('Failed to create gig', 500);
  }

  return jsonResponse(
    {
      message: 'Gig created successfully',
      gig: gigRecord,
      tunnel_grant: buyerGrant,
    },
    201
  );
}
