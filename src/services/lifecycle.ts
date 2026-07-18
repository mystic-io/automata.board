import type { GigLifecycleState, GigStatus, TunnelSessionState } from '../types';

export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
export const PROJECTION_RETRY_MS = 30 * 1000;
export const MAX_PROCESSED_OPERATIONS = 64;

const ALLOWED_TRANSITIONS: Readonly<Record<GigLifecycleState, readonly GigLifecycleState[]>> = {
  POSTED: ['DISCOVERABLE', 'FAILED', 'EXPIRED'],
  DISCOVERABLE: ['CLAIMED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  CLAIMED: ['TUNNEL_GRANTED', 'DISCOVERABLE', 'CANCELLED', 'EXPIRED', 'FAILED'],
  TUNNEL_GRANTED: ['IN_PROGRESS', 'DISCOVERABLE', 'CANCELLED', 'EXPIRED', 'FAILED'],
  IN_PROGRESS: ['DELIVERED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  DELIVERED: ['COMPLETED', 'IN_PROGRESS', 'CANCELLED', 'EXPIRED', 'FAILED'],
  COMPLETED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

export class InvalidLifecycleTransitionError extends Error {
  constructor(from: GigLifecycleState, to: GigLifecycleState) {
    super(`Invalid lifecycle transition: ${from} -> ${to}`);
    this.name = 'InvalidLifecycleTransitionError';
  }
}

export function assertLifecycleTransition(from: GigLifecycleState, to: GigLifecycleState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidLifecycleTransitionError(from, to);
  }
}

export function isTerminalLifecycleState(state: GigLifecycleState): boolean {
  return ALLOWED_TRANSITIONS[state].length === 0;
}

export function legacyStatusForLifecycle(state: GigLifecycleState): GigStatus {
  switch (state) {
    case 'POSTED':
    case 'DISCOVERABLE':
    case 'CLAIMED':
      return 'ACTIVE';
    case 'TUNNEL_GRANTED':
    case 'IN_PROGRESS':
    case 'DELIVERED':
      return 'IN_PROGRESS';
    case 'COMPLETED':
    case 'CLOSED':
      return 'COMPLETED';
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
      return 'EXPIRED';
  }
}

export function rememberOperation(
  session: TunnelSessionState,
  messageId: string,
  state: GigLifecycleState
): void {
  const entries = Object.entries(session.processed_operations);
  if (entries.length >= MAX_PROCESSED_OPERATIONS) {
    delete session.processed_operations[entries[0]?.[0] ?? ''];
  }
  session.processed_operations[messageId] = state;
}
