/**
 * Automata MVP — Input Validation & Response Utilities
 *
 * Pure functions for request validation and standardized
 * JSON response construction.
 */

import type { CreateGigPayload, ClaimGigPayload, LifecycleActionPayload } from '../types';
import {
  A2A_AUTOMATA_MESSAGE_SCHEMA,
  CLAIM_GIG_PAYLOAD_SCHEMA,
  CREATE_GIG_PAYLOAD_SCHEMA,
  LIFECYCLE_ACTION_PAYLOAD_SCHEMA,
  RECONNECT_PAYLOAD_SCHEMA,
  validateContract,
} from '../contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAYLOAD_SIZE = 10_000; // 10 KB max for payload_json
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

function normalizeA2AEnvelope(body: unknown): unknown {
  if (!isJsonObject(body) || !('messageId' in body)) return body;
  if (validateContract(A2A_AUTOMATA_MESSAGE_SCHEMA, body).length > 0) return body;
  const firstPart = Array.isArray(body.parts) ? body.parts[0] : undefined;
  if (!isJsonObject(firstPart) || !isJsonObject(firstPart.data)) return body;
  const data = firstPart.data;
  return {
    message_id: body.messageId,
    sender: data.sender,
    type: data.type,
    payload: data.payload,
  };
}

function contractErrors(
  schema: Readonly<Record<string, unknown>>,
  body: unknown
): ValidationError[] {
  return validateContract(schema, body).map(({ path, message }) => ({
    field: path === '$' ? 'body' : path.replace(/^\$\./, ''),
    message,
  }));
}

/**
 * Validates the raw parsed body against the CreateGigPayload schema.
 * Returns an array of validation errors (empty = valid).
 */
export function validateCreateGigPayload(
  body: unknown
): { data: CreateGigPayload; errors: never[] } | { data: null; errors: ValidationError[] } {
  const normalized = normalizeA2AEnvelope(body);
  const errors = contractErrors(CREATE_GIG_PAYLOAD_SCHEMA, normalized);
  const obj = isJsonObject(normalized) ? normalized : {};
  const payload = isJsonObject(obj.payload) ? obj.payload : {};
  if (typeof obj.sender === 'string' && obj.sender !== obj.sender.trim()) {
    errors.push({ field: 'sender', message: 'Must be trimmed' });
  }
  if (
    isJsonObject(payload.task_params) &&
    JSON.stringify(payload.task_params).length > MAX_PAYLOAD_SIZE
  ) {
    errors.push({
      field: 'payload.task_params',
      message: `Serialized params must not exceed ${MAX_PAYLOAD_SIZE} characters`,
    });
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
        title: payload.title as string,
        description: payload.description as string,
        task_type: payload.task_type as string,
        task_params: payload.task_params as Record<string, unknown>,
        bounty_sats: payload.bounty_sats as number,
        ttl_minutes: payload.ttl_minutes as number,
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
  const normalized = normalizeA2AEnvelope(body);
  const errors = contractErrors(CLAIM_GIG_PAYLOAD_SCHEMA, normalized);
  const obj = isJsonObject(normalized) ? normalized : {};
  const payload = isJsonObject(obj.payload) ? obj.payload : {};
  if (typeof obj.sender === 'string' && obj.sender !== obj.sender.trim()) {
    errors.push({ field: 'sender', message: 'Must be trimmed' });
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
        gig_id: payload.gig_id as string,
      },
    },
    errors: [] as never[],
  };
}

export function validateLifecycleActionPayload(
  body: unknown,
  gigId: string
): { data: LifecycleActionPayload; errors: never[] } | { data: null; errors: ValidationError[] } {
  const normalized = normalizeA2AEnvelope(body);
  const errors = contractErrors(LIFECYCLE_ACTION_PAYLOAD_SCHEMA, normalized);
  const obj = isJsonObject(normalized) ? normalized : {};
  const payload = isJsonObject(obj.payload) ? obj.payload : {};
  if (payload.gig_id !== gigId) {
    errors.push({ field: 'payload.gig_id', message: 'Must match the gig ID in the path' });
  }
  if (errors.length > 0) return { data: null, errors };
  return {
    data: {
      message_id: obj.message_id as string,
      sender: obj.sender as string,
      type: obj.type as LifecycleActionPayload['type'],
      payload: {
        gig_id: payload.gig_id as string,
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      },
    },
    errors: [] as never[],
  };
}

export function validateReconnectPayload(
  body: unknown
):
  | { data: { message_id: string; sender: string; role: 'buyer' | 'worker' }; errors: never[] }
  | { data: null; errors: ValidationError[] } {
  const errors = contractErrors(RECONNECT_PAYLOAD_SCHEMA, body);
  const obj = isJsonObject(body) ? body : {};
  if (typeof obj.sender === 'string' && obj.sender !== obj.sender.trim()) {
    errors.push({ field: 'sender', message: 'Must be trimmed' });
  }
  if (errors.length > 0) return { data: null, errors };
  return {
    data: {
      message_id: obj.message_id as string,
      sender: obj.sender as string,
      role: obj.role as 'buyer' | 'worker',
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
