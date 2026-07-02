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

  /** OpenAI API key for moderation endpoint */
  OPENAI_API_KEY: string;

  /** HMAC secret for signing/verifying L402 macaroons */
  L402_SIGNING_SECRET: string;
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

/** L402 challenge components returned to the client */
export interface L402Challenge {
  /** Base64-encoded mock macaroon */
  macaroon: string;
  /** Mock BOLT11-style invoice string */
  invoice: string;
  /** Formatted WWW-Authenticate header value */
  headerValue: string;
}

/** Decoded macaroon payload for verification */
export interface MacaroonPayload {
  identifier: string;
  paymentHash: string;
  signature: string;
}
