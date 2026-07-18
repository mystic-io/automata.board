/**
 * Automata MVP — Shared Type Definitions
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
  TUNNEL: DurableObjectNamespace<import('./do/automata').Automata>;

  /** x402 payment destination address */
  X402_PAY_TO: string;

  /** Facilitator selection. Simulator is forbidden in production. */
  FACILITATOR_MODE: 'simulator' | 'remote';

  /** Remote x402 facilitator base URL (required in remote mode). */
  X402_FACILITATOR_URL?: string;

  /** Per-operation verify/settle timeout in milliseconds. */
  FACILITATOR_TIMEOUT_MS?: string;

  /** Environment string (e.g. 'development' or 'production') */
  ENVIRONMENT: string;
}

export interface RequestContextVariables {
  correlationId: string;
  createdGigId?: string;
}

export type AppContext = import('hono').Context<{
  Bindings: Env;
  Variables: RequestContextVariables;
}>;

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

export interface LifecycleActionPayload {
  message_id: string;
  sender: string;
  type: 'TaskDelivery' | 'TaskAcceptance' | 'TaskCancellation' | 'TaskAbandonment';
  payload: {
    gig_id: string;
    reason?: string;
  };
}

// ---------------------------------------------------------------------------
// Database Records
// ---------------------------------------------------------------------------

export type GigStatus = 'PENDING_PAYMENT' | 'ACTIVE' | 'IN_PROGRESS' | 'COMPLETED' | 'EXPIRED';

export type GigLifecycleState =
  | 'POSTED'
  | 'DISCOVERABLE'
  | 'CLAIMED'
  | 'TUNNEL_GRANTED'
  | 'IN_PROGRESS'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';

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
  lifecycle_state: GigLifecycleState;
  lifecycle_version: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

// ---------------------------------------------------------------------------
// Tunnel Grants
// ---------------------------------------------------------------------------

export type TunnelRole = 'buyer' | 'worker';

/** Opaque, single-use capability returned only to its intended participant. */
export interface TunnelGrant {
  token: string;
  role: TunnelRole;
  agent_identity: string;
  expires_at: string;
}

export interface PrepareTunnelSession {
  gig_id: string;
  buyer_identity: string;
  buyer_grant_hash: string;
  expires_at: string;
  correlation_id: string;
}

export interface ActivateTunnelSession {
  gig_id: string;
  worker_identity: string;
  worker_grant_hash: string;
  message_id: string;
  correlation_id: string;
}

export interface LifecycleCommand {
  message_id: string;
  actor_identity: string;
  correlation_id: string;
  reason?: string;
}

export interface ReconnectTunnelSession extends LifecycleCommand {
  role: TunnelRole;
  current_grant_hash: string;
  replacement_grant_hash: string;
}

export interface TunnelParticipantState {
  identity: string;
  grant_hash: string;
  consumed_at?: string;
}

export interface TunnelSessionState {
  gig_id: string;
  buyer: TunnelParticipantState;
  worker?: TunnelParticipantState;
  expires_at: string;
  activated_at?: string;
  revoked_at?: string;
  revocation_reason?: string;
  lifecycle_state: GigLifecycleState;
  lifecycle_version: number;
  lifecycle_updated_at: string;
  claim_expires_at?: string;
  projection_pending?: boolean;
  processed_operations: Record<string, GigLifecycleState>;
}

export interface LifecycleResult {
  gig_id: string;
  lifecycle_state: GigLifecycleState;
  lifecycle_version: number;
  duplicate: boolean;
  accepted?: boolean;
  rejection_reason?: string;
}
