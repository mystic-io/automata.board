/**
 * Vivia MVP — Input Validation & Response Utilities
 *
 * Pure functions for request validation and standardized
 * JSON response construction.
 */

import type { CreateGigPayload, ClaimGigPayload } from '../types';

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

  if (typeof obj.message_id !== 'string' || obj.message_id.trim().length === 0) {
    errors.push({ field: 'message_id', message: 'Must be a non-empty string' });
  }

  if (typeof obj.sender !== 'string' || obj.sender.trim().length === 0) {
    errors.push({ field: 'sender', message: 'Must be a non-empty string (hex-encoded public key)' });
  }

  if (obj.type !== 'TaskDelegation') {
    errors.push({ field: 'type', message: 'Must be exactly "TaskDelegation"' });
  }

  if (!obj.payload || typeof obj.payload !== 'object') {
    errors.push({ field: 'payload', message: 'Must be a JSON object' });
  } else {
    const payload = obj.payload as Record<string, unknown>;

    if (typeof payload.task_type !== 'string' || !ALLOWED_TASK_TYPES.has(payload.task_type)) {
      errors.push({
        field: 'payload.task_type',
        message: `Must be one of: ${[...ALLOWED_TASK_TYPES].join(', ')}`,
      });
    }

    if (!payload.task_params || typeof payload.task_params !== 'object') {
      errors.push({ field: 'payload.task_params', message: 'Must be a JSON object' });
    } else {
      const taskParamsStr = JSON.stringify(payload.task_params);
      if (taskParamsStr.length > MAX_PAYLOAD_SIZE) {
        errors.push({ field: 'payload.task_params', message: `Serialized params must not exceed ${MAX_PAYLOAD_SIZE} characters` });
      }
    }

    if (
      typeof payload.bounty_sats !== 'number' ||
      !Number.isInteger(payload.bounty_sats) ||
      payload.bounty_sats < MIN_BOUNTY_SATS ||
      payload.bounty_sats > MAX_BOUNTY_SATS
    ) {
      errors.push({
        field: 'payload.bounty_sats',
        message: `Must be an integer between ${MIN_BOUNTY_SATS} and ${MAX_BOUNTY_SATS}`,
      });
    }

    if (
      typeof payload.ttl_minutes !== 'number' ||
      !Number.isInteger(payload.ttl_minutes) ||
      payload.ttl_minutes < MIN_TTL_MINUTES ||
      payload.ttl_minutes > MAX_TTL_MINUTES
    ) {
      errors.push({
        field: 'payload.ttl_minutes',
        message: `Must be an integer between ${MIN_TTL_MINUTES} and ${MAX_TTL_MINUTES}`,
      });
    }
  }

  if (errors.length > 0) {
    return { data: null, errors };
  }

  return {
    data: obj as unknown as CreateGigPayload,
    errors: [] as never[],
  };
}

/**
 * Validates the raw parsed body against the ClaimGigPayload schema.
 */
export function validateClaimGigPayload(
  body: unknown
): { data: ClaimGigPayload; errors: never[] } | { data: null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== 'object') {
    return { data: null, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.message_id !== 'string' || obj.message_id.trim().length === 0) {
    errors.push({ field: 'message_id', message: 'Must be a non-empty string' });
  }

  if (typeof obj.sender !== 'string' || obj.sender.trim().length === 0) {
    errors.push({ field: 'sender', message: 'Must be a non-empty string (hex-encoded public key)' });
  }

  if (obj.type !== 'TaskClaim') {
    errors.push({ field: 'type', message: 'Must be exactly "TaskClaim"' });
  }

  if (!obj.payload || typeof obj.payload !== 'object') {
    errors.push({ field: 'payload', message: 'Must be a JSON object' });
  } else {
    const payload = obj.payload as Record<string, unknown>;
    if (typeof payload.gig_id !== 'string' || payload.gig_id.trim().length === 0) {
      errors.push({ field: 'payload.gig_id', message: 'Must be a non-empty string' });
    }
  }

  if (errors.length > 0) {
    return { data: null, errors };
  }

  return {
    data: obj as unknown as ClaimGigPayload,
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
