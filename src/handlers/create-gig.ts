/**
 * Vivia MVP — Create Gig Handler
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
import { moderateContent } from '../services/moderation';
import type { Context } from 'hono';

/**
 * Handles POST /v1/gigs/create
 */
export async function handleCreateGig(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const env = c.env;
  
  // -----------------------------------------------------------------------
  // Step 1: Parse & Validate
  // -----------------------------------------------------------------------

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse('Invalid JSON in request body', 400);
  }

  const validation = validateCreateGigPayload(body);
  if (validation.errors.length > 0) {
    return errorResponse('Validation failed', 400, validation.errors);
  }

  const payload = validation.data!;

  // -----------------------------------------------------------------------
  // Step 2: AI Moderation Gate
  // -----------------------------------------------------------------------

  const moderation = await moderateContent(
    payload.task_type,
    payload.payload_json,
    env.OPENAI_API_KEY,
    env.ENVIRONMENT || 'development'
  );

  if (moderation.error) {
    return errorResponse(
      `Moderation service failed: ${moderation.reason}`,
      503
    );
  }

  if (moderation.flagged) {
    return errorResponse(
      `Content rejected by moderation: ${moderation.reason}`,
      400
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: Write to D1
  // -----------------------------------------------------------------------

  const gigId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + payload.ttl_minutes * 60 * 1000);

  const gigRecord: GigRecord = {
    gig_id: gigId,
    buyer_pubkey: payload.buyer_pubkey,
    task_type: payload.task_type,
    payload_json: payload.payload_json,
    bounty_sats: payload.bounty_sats,
    status: 'ACTIVE',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO agent_gigs (gig_id, buyer_pubkey, task_type, payload_json, bounty_sats, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        gigRecord.gig_id,
        gigRecord.buyer_pubkey,
        gigRecord.task_type,
        gigRecord.payload_json,
        gigRecord.bounty_sats,
        gigRecord.status,
        gigRecord.created_at,
        gigRecord.expires_at
      )
      .run();
  } catch (err) {
    console.error('D1 insert error:', err);
    return errorResponse('Failed to create gig — database error', 500);
  }

  return jsonResponse(
    {
      message: 'Gig created successfully',
      gig: gigRecord,
    },
    201
  );
}
