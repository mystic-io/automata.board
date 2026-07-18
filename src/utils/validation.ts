/**
 * Automata MVP — Input Validation & Response Utilities
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
  'data_extraction',
  'computation',
  'api_relay',
  'custom',
]);

const MAX_PAYLOAD_SIZE = 10_000; // 10 KB max for payload_json
const MAX_TTL_MINUTES = 120; // 2 hours (matches PRD ephemerality)
const MIN_TTL_MINUTES = 1;
const MAX_BOUNTY_SATS = 1_000_000; // 1M sats cap
const MIN_BOUNTY_SATS = 1;
export const MAX_AGENT_IDENTITY_LENGTH = 512;

// ---------------------------------------------------------------------------
// Payload Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the raw parsed body against the CreateGigPayload schema.
 * Returns an array of validation errors (empty = valid).
 */
export function validateCreateGigPayload(
  body: unknown
): { data: CreateGigPayload; errors: never[] } | { data: null; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!isJsonObject(body)) {
    return {
      data: null,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }

  const obj = body;

  if (typeof obj.message_id !== 'string' || obj.message_id.trim().length === 0) {
    errors.push({ field: 'message_id', message: 'Must be a non-empty string' });
  }

  if (
    typeof obj.sender !== 'string' ||
    obj.sender.trim().length === 0 ||
    obj.sender !== obj.sender.trim() ||
    obj.sender.length > MAX_AGENT_IDENTITY_LENGTH
  ) {
    errors.push({
      field: 'sender',
      message: `Must be a trimmed string between 1 and ${MAX_AGENT_IDENTITY_LENGTH} characters`,
    });
  }

  if (obj.type !== 'TaskDelegation') {
    errors.push({ field: 'type', message: 'Must be exactly "TaskDelegation"' });
  }

  if (!isJsonObject(obj.payload)) {
    errors.push({ field: 'payload', message: 'Must be a JSON object' });
  } else {
    const payload = obj.payload;

    if (
      typeof payload.title !== 'string' ||
      payload.title.trim().length === 0 ||
      payload.title.length > 80
    ) {
      errors.push({
        field: 'payload.title',
        message: 'Must be a string between 1 and 80 characters',
      });
    }

    if (
      typeof payload.description !== 'string' ||
      payload.description.trim().length === 0 ||
      payload.description.length > 500
    ) {
      errors.push({
        field: 'payload.description',
        message: 'Must be a string between 1 and 500 characters',
      });
    }

    if (typeof payload.task_type !== 'string' || !ALLOWED_TASK_TYPES.has(payload.task_type)) {
      errors.push({
        field: 'payload.task_type',
        message: `Must be one of: ${[...ALLOWED_TASK_TYPES].join(', ')}`,
      });
    }

    if (!isJsonObject(payload.task_params)) {
      errors.push({ field: 'payload.task_params', message: 'Must be a JSON object' });
    } else {
      const taskParamsStr = JSON.stringify(payload.task_params);
      if (taskParamsStr.length > MAX_PAYLOAD_SIZE) {
        errors.push({
          field: 'payload.task_params',
          message: `Serialized params must not exceed ${MAX_PAYLOAD_SIZE} characters`,
        });
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
    data: {
      message_id: obj.message_id as string,
      sender: obj.sender as string,
      type: 'TaskDelegation',
      payload: {
        title: (obj.payload as Record<string, unknown>).title as string,
        description: (obj.payload as Record<string, unknown>).description as string,
        task_type: (obj.payload as Record<string, unknown>).task_type as string,
        task_params: (obj.payload as Record<string, unknown>).task_params as Record<
          string,
          unknown
        >,
        bounty_sats: (obj.payload as Record<string, unknown>).bounty_sats as number,
        ttl_minutes: (obj.payload as Record<string, unknown>).ttl_minutes as number,
      },
    },
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

  if (!isJsonObject(body)) {
    return {
      data: null,
      errors: [{ field: 'body', message: 'Request body must be a JSON object' }],
    };
  }

  const obj = body;

  if (typeof obj.message_id !== 'string' || obj.message_id.trim().length === 0) {
    errors.push({ field: 'message_id', message: 'Must be a non-empty string' });
  }

  if (
    typeof obj.sender !== 'string' ||
    obj.sender.trim().length === 0 ||
    obj.sender !== obj.sender.trim() ||
    obj.sender.length > MAX_AGENT_IDENTITY_LENGTH
  ) {
    errors.push({
      field: 'sender',
      message: `Must be a trimmed string between 1 and ${MAX_AGENT_IDENTITY_LENGTH} characters`,
    });
  }

  if (obj.type !== 'TaskClaim') {
    errors.push({ field: 'type', message: 'Must be exactly "TaskClaim"' });
  }

  if (!isJsonObject(obj.payload)) {
    errors.push({ field: 'payload', message: 'Must be a JSON object' });
  } else {
    const payload = obj.payload;
    if (typeof payload.gig_id !== 'string' || payload.gig_id.trim().length === 0) {
      errors.push({ field: 'payload.gig_id', message: 'Must be a non-empty string' });
    }
  }

  if (errors.length > 0) {
    return { data: null, errors };
  }

  return {
    data: {
      message_id: obj.message_id as string,
      sender: obj.sender as string,
      type: 'TaskClaim',
      payload: {
        gig_id: (obj.payload as Record<string, unknown>).gig_id as string,
      },
    },
    errors: [] as never[],
  };
}

// ---------------------------------------------------------------------------
// Response Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Agent-Identity, PAYMENT-SIGNATURE, X-PAYMENT',
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
export function errorResponse(message: string, status: number = 400, details?: unknown): Response {
  return jsonResponse(
    {
      error: true,
      message,
      ...(details ? { details } : {}),
    },
    status
  );
}
