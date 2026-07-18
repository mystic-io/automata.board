# Current-state assessment

**Audit date:** 2026-07-18

**Baseline commit:** `7546455` (pre-Milestone 4)

**Assessment:** observable, authenticated testnet lifecycle slice; not mainnet-ready

## What works

- Paid Base Sepolia gig creation, D1/MCP discovery, atomic per-gig claiming,
  two-party authenticated WebSocket relay, delivery, acceptance, cancellation,
  abandonment, expiry, and reconnect-grant rotation run through one testnet slice.
- The per-gig Durable Object enforces the explicit lifecycle state machine and
  is authoritative where lifecycle and tunnel state overlap.
- D1 is a versioned read/discovery projection. Failed projections remain marked
  pending and are retried by alarms and the enabled 15-minute cron.
- Stable message IDs make claim and lifecycle retries safe. Concurrent claimers
  still produce one winner; out-of-order actions return `409`.
- Untouched claims time out back to `DISCOVERABLE`; deadline expiry closes live
  tunnels; cancellation, worker abandonment, completion, and deterministic x402
  settlement failure converge to terminal state without orphaned grants.
- Every HTTP path receives a correlation ID. Structured Workers Logs explain
  lifecycle transitions, projection outcomes, grant decisions, x402 outcomes,
  request status/duration, and readiness failures without recording credentials.
- `/health` checks D1 readiness and reports lifecycle/observability configuration.
- Workerd tests are deterministic, secret-free, local, testnet-only, and cover
  lifecycle edge/failure/idempotency and observability signals.

## Source-of-truth boundaries

| Concern                           | Source of truth             | Projection / evidence                      |
| --------------------------------- | --------------------------- | ------------------------------------------ |
| Lifecycle transition and version  | Per-gig Durable Object      | D1 `lifecycle_state` / `lifecycle_version` |
| Tunnel participants and grant use | Per-gig Durable Object      | Structured accept/reject events            |
| Public discovery                  | D1                          | REST and MCP discovery responses           |
| Legacy public phase               | D1 `status`                 | Derived from detailed lifecycle state      |
| Creation payment outcome          | x402 middleware/facilitator | Structured x402 outcome event              |

## Remaining risks

1. The production request path still embeds a mnemonic-backed local facilitator.
2. Agent identity strings are capability-bound selectors, not standardized signatures.
3. MCP still exposes discovery only; lifecycle parity is the next milestone.
4. Real bounty settlement is intentionally absent; `CLOSED` records buyer acceptance only.
5. D1 remains a central registry, despite the longer-term decentralized vision.
6. Simulator/diagnostic scripts remain outside the normal TypeScript and lint gates.

## Verification contract

`npm run verify` runs Worker and runtime typechecks, lint, unit tests, the full
workerd suite, and a Wrangler dry-run bundle. Release gating additionally
requires `npm ci`, `npm audit`, full secret scans, PR CI, and a green post-merge
run on `main`.
