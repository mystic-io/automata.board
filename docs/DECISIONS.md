# Engineering decisions

## ADR-001: Earn trust before pursuing adoption

**Status:** Accepted — 2026-07-18

**Decision:** Make a secure, reproducible testnet vertical slice the north-star.

The repository has a promising protocol spine, but the payment path holds a hot
mnemonic, tunnels do not authenticate participants, cleanup is inactive, and
the baseline had no tests or CI. Driving traffic now would increase financial,
privacy, and reliability exposure faster than it creates useful learning.

### Accepted trade-offs

- Delay mainnet and traction experiments while the vertical slice is hardened.
- Keep D1 as the pragmatic registry for now instead of attempting premature
  federation; document that this is not yet fully decentralized.
- Preserve the existing REST surface while MCP reaches parity incrementally.
- Prefer a narrow, demonstrable buyer-to-worker lifecycle over adding task types
  or settlement features.

## ADR-002: Mainnet requires a reviewed source change

**Status:** Accepted — 2026-07-18

**Decision:** Pin x402 and simulator defaults to Base Sepolia in source. Do not
offer an environment-only mainnet switch during the hardening phase.

This makes accidental real-value execution substantially harder and keeps
mainnet activation behind the founder-approval guardrail.

## ADR-003: Run integration tests inside workerd

**Status:** Accepted — 2026-07-18

**Decision:** Use Vitest with `@cloudflare/vitest-pool-workers` for the Cloudflare
runtime harness, with a separate test-only Worker entrypoint and deterministic
x402 facilitator.

Cloudflare recommends the Vitest integration for Workers projects, and the
project already uses Vitest. The pool executes test code inside workerd, loads
the D1 and Durable Object bindings from `wrangler.toml`, supports direct Durable
Object inspection and alarm execution, and remains fully local in CI. A separate
Miniflare process would add lifecycle and transport orchestration without
providing a closer runtime for these paths; the Vitest pool already embeds
Miniflare around workerd.

The production app accepts an explicit payment-middleware provider. Production
uses the existing mnemonic-backed Base Sepolia facilitator; only
`test/runtime/worker.ts` injects the simulated facilitator. Simulated nonces are
tracked in test D1 so replay behavior is deterministic and concurrency-safe.

### Accepted trade-offs

- The harness validates x402 challenge, verification, rejection, settlement
  response, and handler gating, but does not claim to validate EVM signatures or
  chain settlement.
- Runtime tests use a separate Vitest config so fast Node unit tests remain a
  distinct CI signal.
- The D1 schema is loaded directly from `schema.sql`, preserving one schema
  source of truth instead of introducing test-only migrations.
- No runtime test may require secrets, remote bindings, live RPC, or real funds.

## ADR-004: Use opaque, single-use tunnel capabilities

**Status:** Accepted — 2026-07-18

**Decision:** Authorize each gig tunnel with two independently generated,
256-bit opaque capabilities: one delivered to the buyer in the paid create
response and one delivered only to the winning worker in the claim response.
The per-gig Durable Object stores SHA-256 digests, binds them to the exact buyer
and worker identities, and activates both sides when the claim succeeds.

The buyer capability is prepared at creation because returning both grants from
the public claim response would allow the worker to impersonate the buyer. It is
not usable until claim activation binds the session to the winning worker. On a
WebSocket upgrade the Durable Object validates the bearer capability, exact
agent identity, gig path, role, activation, expiry, revocation, and unused state
before accepting the socket. Consumption is persisted before the upgrade is
returned. Hibernation tags enforce one `buyer` and one `worker`, and messages
are sent only to the opposite role.

Opaque capabilities were chosen over signed tokens because the Durable Object
already provides the strongly consistent state required for replay prevention,
participant capacity, and revocation. This avoids adding a long-lived tunnel
signing secret, secret rotation procedure, or a second source of truth. It also
fits x402 cleanly: payment gates buyer delivery, while the atomic D1 claim gates
worker delivery.

### Lifecycle

- Buyer grant: created and hashed after payment; inactive until claim.
- Worker grant: created for the atomic claim winner; activation binds both
  identities to the gig and its existing expiry.
- Join: single-use; the digest is marked consumed before socket acceptance.
- Timeout: the gig deadline is the grant deadline; the Durable Object alarm
  revokes the session and closes both sockets with code `4003`.
- Explicit invalidation: `revokeTunnelSession()` persists revocation, deletes
  the alarm, and closes peers. Milestone 4 will call it from completion.
- Replay/reconnect: consumed grants remain invalid even after disconnect. A
  future reconnect flow must issue a fresh scoped grant explicitly.

### Accepted trade-offs

- Capabilities are bearer credentials and must be kept out of URLs, logs, and
  application messages. Clients send them only in the `Authorization` header.
- The identity header is a binding selector, not a second cryptographic proof;
  authorization comes from possession of the separately delivered capability.
- A lost single-use grant currently requires lifecycle recovery not yet exposed
  by the public API; silent token reuse is intentionally rejected.
