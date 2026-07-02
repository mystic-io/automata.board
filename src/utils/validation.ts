/**
 * Vivia MVP — Input Validation & Response Utilities
 *
 * Pure functions for request validation and standardized
 * JSON response construction.
 */

import type { CreateGigPayload } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_TASK_TYPES = new Set([
  'web_scrape',
  'captcha_solve',
  'data_extraction',
  'computation',
  'api_relay',
  'custom',
]);

const MAX_PAYLOAD_SIZE = 10_000;   // 10 KB max for payload_json
const MAX_TTL_MINUTES = 120;       // 2 hours (matches PRD ephemerality)
const MIN_TTL_MINUTES = 1;
const MAX_BOUNTY_SATS = 1_000_000; // 1M sats cap
const MIN_BOUNTY_SATS = 1;

// ---------------------------------------------------------------------------
// Payload Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validates the raw parsed body against the CreateGigPayload schema.
 * Returns an array of validation errors (empty = valid).
 */
export function validateCreateGigPayload(
  body: unknown
): { data: CreateGigPayload; errors: never[] } | { data: null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== 'object') {
    return { data: null, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  // buyer_pubkey
  if (typeof obj.buyer_pubkey !== 'string' || obj.buyer_pubkey.trim().length === 0) {
    errors.push({ field: 'buyer_pubkey', message: 'Must be a non-empty string (hex-encoded public key)' });
  }

  // task_type
  if (typeof obj.task_type !== 'string' || !ALLOWED_TASK_TYPES.has(obj.task_type)) {
    errors.push({
      field: 'task_type',
      message: `Must be one of: ${[...ALLOWED_TASK_TYPES].join(', ')}`,
    });
  }

  // payload_json — must be a valid JSON string
  if (typeof obj.payload_json !== 'string') {
    errors.push({ field: 'payload_json', message: 'Must be a JSON-encoded string' });
  } else {
    if (obj.payload_json.length > MAX_PAYLOAD_SIZE) {
      errors.push({ field: 'payload_json', message: `Must not exceed ${MAX_PAYLOAD_SIZE} characters` });
    }
    try {
      JSON.parse(obj.payload_json);
    } catch {
      errors.push({ field: 'payload_json', message: 'Must contain valid JSON' });
    }
  }

  // bounty_sats
  if (
    typeof obj.bounty_sats !== 'number' ||
    !Number.isInteger(obj.bounty_sats) ||
    obj.bounty_sats < MIN_BOUNTY_SATS ||
    obj.bounty_sats > MAX_BOUNTY_SATS
  ) {
    errors.push({
      field: 'bounty_sats',
      message: `Must be an integer between ${MIN_BOUNTY_SATS} and ${MAX_BOUNTY_SATS}`,
    });
  }

  // ttl_minutes
  if (
    typeof obj.ttl_minutes !== 'number' ||
    !Number.isInteger(obj.ttl_minutes) ||
    obj.ttl_minutes < MIN_TTL_MINUTES ||
    obj.ttl_minutes > MAX_TTL_MINUTES
  ) {
    errors.push({
      field: 'ttl_minutes',
      message: `Must be an integer between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES}`,
    });
  }

  if (errors.length > 0) {
    return { data: null, errors };
  }

  return {
    data: obj as unknown as CreateGigPayload,
    errors: [] as never[],
  };
}

// ---------------------------------------------------------------------------
// Response Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Constructs a JSON Response with proper headers.
 */
export function jsonResponse(
  body: unknown,
  status: number = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Standard error response envelope.
 */
export function errorResponse(
  message: string,
  status: number = 400,
  details?: unknown
): Response {
  return jsonResponse(
    {
      error: true,
      message,
      ...(details ? { details } : {}),
    },
    status
  );
}
