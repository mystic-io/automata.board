/**
 * Vivia MVP — Shared Type Definitions
 *
 * Central type registry for Cloudflare bindings, API payloads,
 * database records, and service interfaces.
 */

// ---------------------------------------------------------------------------
// Cloudflare Environment Bindings
// ---------------------------------------------------------------------------

export interface Env {
  /** Cloudflare D1 database binding */
  DB: D1Database;

  /** Durable Object binding for real-time tunneling */
  TUNNEL: DurableObjectNamespace;

  /** OpenAI API key for moderation endpoint */
  OPENAI_API_KEY: string;

  /** x402 payment destination address */
  X402_PAY_TO: string;
}

// ---------------------------------------------------------------------------
// API Payloads
// ---------------------------------------------------------------------------

/** Inbound JSON body for POST /v1/gigs/create */
export interface CreateGigPayload {
  buyer_pubkey: string;
  task_type: string;
  payload_json: string;
  bounty_sats: number;
  ttl_minutes: number;
}

/** Inbound JSON body for POST /v1/gigs/claim */
export interface ClaimGigPayload {
  gig_id: string;
  worker_pubkey: string;
}

// ---------------------------------------------------------------------------
// Database Records
// ---------------------------------------------------------------------------

export type GigStatus =
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'EXPIRED';

/** Row shape from the `agent_gigs` D1 table */
export interface GigRecord {
  gig_id: string;
  buyer_pubkey: string;
  worker_pubkey?: string;
  task_type: string;
  payload_json: string;
  bounty_sats: number;
  status: GigStatus;
  created_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Service Interfaces
// ---------------------------------------------------------------------------

/** Result from the AI moderation pipeline */
export interface ModerationResult {
  flagged: boolean;
  reason?: string;
}
