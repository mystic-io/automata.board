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

  /** x402 payment destination address */
  X402_PAY_TO: string;

  /** Mnemonic for the local embedded facilitator */
  WALLET_MNEMONIC: string;

  /** Environment string (e.g. 'development' or 'production') */
  ENVIRONMENT: string;
}

// ---------------------------------------------------------------------------
// API Payloads
// ---------------------------------------------------------------------------

/** Inbound JSON body for POST /v1/gigs/create (A2A Message Envelope) */
export interface CreateGigPayload {
  message_id: string;
  sender: string; // The buyer's public key
  type: 'TaskDelegation';
  payload: {
    title: string;
    description: string;
    task_type: string;
    task_params: Record<string, unknown>; // Replaces payload_json
    bounty_sats: number;
    ttl_minutes: number;
  };
}

/** Inbound JSON body for POST /v1/gigs/claim (A2A Message Envelope) */
export interface ClaimGigPayload {
  message_id: string;
  sender: string; // The worker's public key
  type: 'TaskClaim';
  payload: {
    gig_id: string;
  };
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
  title: string;
  description: string;
  task_type: string;
  payload_json: string;
  bounty_sats: number;
  status: GigStatus;
  created_at: string;
  expires_at: string;
}
