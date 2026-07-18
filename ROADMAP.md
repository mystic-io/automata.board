# Automata roadmap

## North-star

**Ship a secure, reproducible testnet vertical slice that external agents can
integrate with confidently.**

This direction blends production hardening with a deliberately small adoption
surface. Capability expansion waits until one complete buyer-to-worker path is
safe, observable, documented, and repeatable.

## Roadmap at a glance

```mermaid
flowchart LR
  A["Now: Trustworthy testnet slice\n2–4 engineer-weeks"] --> B["Next: Protocol-complete beta\n3–5 engineer-weeks"]
  B --> C["Later: Federated adoption\n4–8+ engineer-weeks"]

  A --> A1["✓ Shipped M1: safety foundation"]
  A --> A2["✓ Shipped M2: workerd runtime harness"]
  A --> A3["✓ Shipped M3: authenticated two-party tunnel grants"]
  A --> A4["✓ Shipped M4: lifecycle correctness + observability"]
  A --> A5["✓ Shipped M5: contract parity + facilitator boundary"]

  B --> B0["M6: external integration kit + staging proof"]
  B --> B1["MCP lifecycle mutation tools"]
  B --> B2["Reference TypeScript client"]
  B --> B3["Staging SLOs + tracing"]

  C --> C1["Federated discovery"]
  C --> C2["Reference agent SDK"]
  C --> C3["Measured ecosystem pilots"]
```

## Now — trustworthy testnet slice

**Outcome:** A contributor can clone the repo, run one command to verify it, and
demonstrate an authenticated buyer → board → worker → tunnel → completion flow
on Base Sepolia without risking real value.

**Effort:** 2–4 engineer-weeks. **Impact:** highest; it converts the prototype
from an attractive demo into a credible integration target.

1. **Safety baseline** — Base Sepolia defaults, explicit mainnet gate, dependency
   advisories resolved, secrets documented, unsafe remote scripts guarded.
2. **Verification baseline (complete)** — unit tests plus workerd integration
   coverage for D1 lifecycle/concurrency, Durable Object WebSockets, simulated
   x402 verification, and MCP; CI runs types, lint, both suites, and dry-run
   bundling.
3. **Tunnel security** — opaque short-lived join grants bound to gig, role, and
   agent identity; enforce exactly one buyer and one worker; validate messages.
4. **Lifecycle correctness** — completion transition, deadline propagated to the
   DO, idempotent expiry, enabled scheduled cleanup with tests.
5. **Operational clarity** — structured logs, useful readiness health, aligned
   OpenAPI/MCP/`llms.txt`, and a no-real-funds testnet walkthrough.

Dependencies: safety and tests precede tunnel/lifecycle changes. Tunnel grants
depend on a settled agent-signature format. Cleanup is enabled only after clock
and lifecycle integration tests exist.

### Shipped milestones

- [x] **Milestone 1 — production-readiness foundation:** Base Sepolia safety
      defaults, stricter validation, executable unit tests, CI, dependency and
      secret hygiene, and reviewed public documentation.
- [x] **Milestone 2 — workerd runtime harness:** deterministic D1 lifecycle and
      concurrency tests, Durable Object WebSocket coverage, simulated x402
      verification/replay tests, MCP discovery, and CI runtime gates.
- [x] **Milestone 3 — authenticated two-party tunnel grants:** role- and
      identity-bound single-use capabilities, Durable Object enforcement,
      expiry/revocation, and deterministic adversarial runtime coverage.
- [x] **Milestone 4 — lifecycle correctness and observability:** an enforced
      Durable Object state machine, versioned D1 projection, idempotent edge
      transitions, reconnect recovery, structured correlation telemetry,
      readiness checks, and enabled scheduled reconciliation.
- [x] **Milestone 5 — protocol contract parity and facilitator boundary:**
      executable versioned contracts shared by OpenAPI, runtime validation and
      MCP registration; workerd conformance coverage for REST, MCP, x402 v2 and
      A2A 1.0; and a timeout-bounded simulator/remote facilitator seam.

### Milestone 3 — authenticated two-party tunnel grants (shipped)

Extend the workerd WebSocket suite before changing the public tunnel contract.

- [x] Define opaque, high-entropy, short-lived capabilities bound in Durable
      Object state to gig ID, role, agent identity, expiry, and consumption.
- [x] Issue distinct buyer and worker grants at the appropriate lifecycle
      transitions without introducing or exposing a signing secret.
- [x] Verify capability digest, expiry, gig, role, identity, and single-use state
      during the WebSocket upgrade.
- [x] Enforce exactly one buyer and one worker and reject third peers.
- [x] Cover expired, replayed, role-swapped, identity-mismatched, gig-mismatched,
      revoked, and third-peer attempts in workerd.

### Milestone 4 — lifecycle correctness and observability (shipped)

- [x] Add authenticated delivery/acceptance transitions and revoke tunnel grants when
      a gig reaches `COMPLETED`.
- [x] Propagate authoritative gig deadlines through D1 and Durable Object state,
      with idempotent expiry and scheduled cleanup.
- [x] Add structured lifecycle/security/payment logs and a useful readiness signal.
- [x] Align OpenAPI, Agent Card, `llms.txt`, simulators, and the testnet walkthrough.

### Follow-on trustworthy-slice work

- [ ] Bring simulator and diagnostic scripts into TypeScript and lint gates.
- [x] Model completion and expiry end to end.
- [x] Add lifecycle observability and enable tested scheduled reconciliation.
- [x] Align machine-readable contracts and public walkthroughs.

### Milestone 5 — protocol contract parity and facilitator boundary (shipped)

- [x] Make `src/contracts.ts` the executable source for request validation,
      OpenAPI components, MCP tool/resource registration, and conformance tests.
- [x] Pin additive compatibility guarantees, A2A 1.0, MCP server 1.0.0, and
      x402 v2 in a machine-readable MCP contract resource.
- [x] Validate running REST responses, MCP discovery/schema output, x402 header
      exchanges, and A2A Agent Card/message envelopes inside workerd.
- [x] Replace the embedded mnemonic-backed facilitator with explicit `verify`
      and `settle` operations, bounded timeouts, a secret-free simulator, and a
      config-selected remote client.
- [x] Prove invalid, unavailable, timeout, failed, and pending settlement paths
      fail closed and converge lifecycle projection/telemetry.

Migration `0002_facilitator_simulator.sql` adds only the nonce table used by the
secret-free local/test simulator; remote production mode never reads it. Mainnet,
real settlement, and a live hosted facilitator remain separate founder decisions.

### Milestone 6 — external integration kit and staging proof

Publish a minimal TypeScript reference client and conformance runner, add MCP
mutation tools for claim/lifecycle operations with payment-safe create guidance,
and prove the versioned contract against a testnet staging deployment with SLOs,
tracing, and an operator runbook.

## Next — protocol-complete beta

**Outcome:** MCP-first agents can perform the full lifecycle through stable,
versioned protocol contracts, with payments isolated behind a replaceable
facilitator boundary.

**Effort:** 3–5 engineer-weeks. **Impact:** high; removes custom integration
work and makes the system usable by real agent frameworks.

- MCP mutation tools for claim and lifecycle actions with shared service logic;
  keep paid creation on the x402-conformant HTTP exchange until MCP payment
  semantics are explicitly standardized.
- Reference TypeScript client and standalone conformance runner.
- Idempotency keys and replay protection across payment and lifecycle writes.
- Staging deployment runbook, SLOs, tracing, and abuse budgets.

Dependency: completes the trustworthy testnet slice first. Mainnet remains a
separate founder decision after a security review.

## Later — federated adoption

**Outcome:** Multiple independent boards can advertise and exchange tasks, and a
small set of ecosystem partners can integrate through a reference client.

**Effort:** 4–8+ engineer-weeks. **Impact:** potentially very high, but only once
trust and protocol stability exist.

- Define federation/discovery semantics that preserve the “no central database”
  ambition instead of overstating the current D1 architecture.
- Publish a minimal TypeScript reference client and conformance suite.
- Run measured pilots with agent framework maintainers; track time-to-first-gig,
  successful claim rate, tunnel completion rate, and payment failure rate.
- Consider capability matching, reputation, and alternative settlement only from
  observed pilot bottlenecks.
