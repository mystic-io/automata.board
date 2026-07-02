/**
 * Vivia MVP — Create Gig Handler
 *
 * POST /v1/gigs/create
 *
 * Implements the full gig creation lifecycle from the PRD:
 *
 * 1. Parse & validate the JSON payload
 * 2. Run AI moderation (injection scan + OpenAI)
 * 3. Check for L402 Authorization header:
 *    - Missing → generate L402 challenge, return 402
 *    - Present → verify macaroon + preimage, proceed to write
 * 4. Insert into D1 with status = 'ACTIVE', return 201
 */

import type { Env, GigRecord } from '../types';
import { validateCreateGigPayload, jsonResponse, errorResponse } from '../utils/validation';
import { moderateContent } from '../services/moderation';
import { generateChallenge, verifyAuthorization } from '../services/l402';

/**
 * Handles POST /v1/gigs/create
 */
export async function handleCreateGig(
  request: Request,
  env: Env
): Promise<Response> {
  // -----------------------------------------------------------------------
  // Step 1: Parse & Validate
  // -----------------------------------------------------------------------

  let body: unknown;
  try {
    body = await request.json();
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
    env.OPENAI_API_KEY
  );

  if (moderation.flagged) {
    return errorResponse(
      `Content rejected by moderation: ${moderation.reason}`,
      400
    );
  }

  // -----------------------------------------------------------------------
  // Step 3: L402 Authorization Check
  // -----------------------------------------------------------------------

  const gigId = crypto.randomUUID();
  const authHeader = request.headers.get('Authorization');

  if (!authHeader) {
    // No authorization → issue L402 challenge
    const challenge = await generateChallenge(
      gigId,
      payload.bounty_sats,
      env.L402_SIGNING_SECRET
    );

    return jsonResponse(
      {
        error: false,
        message: 'Payment required. Pay the invoice and retry with the L402 authorization header.',
        gig_id: gigId,
        bounty_sats: payload.bounty_sats,
        invoice: challenge.invoice,
      },
      402,
      {
        'WWW-Authenticate': challenge.headerValue,
      }
    );
  }

  // Authorization header present → verify L402 credentials
  const verification = await verifyAuthorization(authHeader, env.L402_SIGNING_SECRET);

  if (!verification.valid) {
    return errorResponse(
      `L402 authorization failed: ${verification.error}`,
      401
    );
  }

  // Use the gig ID from the verified macaroon (ties payment to the gig)
  const verifiedGigId = verification.gigId!;

  // -----------------------------------------------------------------------
  // Step 4: Write to D1
  // -----------------------------------------------------------------------

  const now = new Date();
  const expiresAt = new Date(now.getTime() + payload.ttl_minutes * 60 * 1000);

  const gigRecord: GigRecord = {
    gig_id: verifiedGigId,
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
