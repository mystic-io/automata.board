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

**Supersession note:** ADR-008 replaces the production embedded-facilitator
choice below; the workerd harness and simulator decisions remain accepted.

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
- Replay/reconnect: consumed grants remain invalid for WebSocket upgrades. The
  authenticated reconnect flow rotates one into a fresh scoped grant only after
  that role disconnects.

### Accepted trade-offs

- Capabilities are bearer credentials and must be kept out of URLs, logs, and
  application messages. Clients send them only in the `Authorization` header.
- The identity header is a binding selector, not a second cryptographic proof;
  authorization comes from possession of the separately delivered capability.
- A lost grant cannot be recovered because the server stores only its digest;
  clients that retain the consumed grant may rotate it after disconnect.

## ADR-005: Durable Objects own lifecycle; D1 is a versioned projection

**Status:** Accepted — 2026-07-18

**Decision:** The per-gig `Automata` Durable Object is the authoritative source
for lifecycle state and transition validation. D1 remains the public discovery
and reporting projection, with `lifecycle_state`, a monotonic
`lifecycle_version`, and the backwards-compatible `status` field.

The enforced path is `POSTED → DISCOVERABLE → CLAIMED → TUNNEL_GRANTED →
IN_PROGRESS → DELIVERED → COMPLETED → CLOSED`. `CANCELLED`, `EXPIRED`, and
`FAILED` are terminal. The Object rejects out-of-order transitions, records a
bounded set of processed message IDs, and rotates the worker grant on an
idempotent claim retry. Claim timeouts release untouched claims; gig deadlines,
cancellation, abandonment, completion, and x402 post-handler settlement failure
all revoke tunnel access and converge D1.

Projection writes happen after durable state writes. A failed D1 update marks
the projection pending and schedules a retry on the Object alarm; the enabled
cron also requests bounded reconciliation. This deliberately favors a correct
coordination decision over temporarily stale discovery data.

### Accepted trade-offs

- Existing `status` consumers continue to see `ACTIVE`, `IN_PROGRESS`,
  `COMPLETED`, or `EXPIRED`; detailed state is additive.
- A D1 migration must be applied before deploying this source revision.
- Real bounty settlement is not modeled. `CLOSED` means the buyer accepted the
  delivery, not that Automata transferred bounty funds.

## ADR-006: Use Workers Logs and structured application events

**Status:** Accepted — 2026-07-18

**Decision:** Enable Cloudflare Workers observability and persistent Workers
Logs at full sampling for the testnet slice. Emit JSON events for HTTP requests,
lifecycle transitions/projection sync, tunnel grant accept/reject reasons,
WebSocket failures, scheduled reconciliation, health failures, and x402
verification/settlement outcomes.

Every request accepts or generates a bounded `X-Correlation-ID`, returns it in
the response, and passes it to Durable Object commands and upgrades. Events may
include gig ID, role, state, version, reason code, status, and duration. They
must never include bearer grants, authorization/payment headers, mnemonics,
private keys, full payment credentials, or raw task payloads.

Workers Logs was chosen because it fits the existing `wrangler.toml`
observability configuration and needs no new binding. Analytics Engine is not
added: the current event volume and query needs do not justify another
account-level resource. If retained telemetry volume later requires aggregate
analytics, that is a separately reviewed infrastructure decision.

## ADR-007: Executable schemas own public protocol compatibility

**Status:** Accepted — 2026-07-18

**Decision:** Version the Automata contract as `1.0.0`, pin A2A `1.0`, MCP server
`1.0.0`, and x402 `2`, and keep their executable JSON Schemas and MCP registry in
`src/contracts.ts`. Runtime request validation, OpenAPI components, MCP
registration, and workerd conformance tests consume those objects.

The original Automata v1 command envelope remains accepted. A2A 1.0 Messages are
an additive representation: one JSON DataPart carries the same `sender`, `type`,
and `payload`, and is normalized only after the A2A envelope validates. Root and
`/.well-known/agent-card.json` serve the same conformant Agent Card while legacy
root discovery fields remain additive for existing clients.

Within contract major `1`, changes may add optional fields, tools, resources, or
response variants without changing existing semantics. Removing or renaming a
field, making an optional field required, tightening accepted valid input, or
changing lifecycle/payment meaning requires a new major version and documented
migration path.

### Accepted trade-offs

- The small in-repository schema evaluator implements only keywords used by the
  contracts; conformance tests exercise every supported keyword path.
- MCP exposes discovery and authoritative status in this milestone. Mutation
  tools and a reference client remain Milestone 6 work.
- The A2A integration is an Automata HTTP+JSON profile, not a claim that every
  optional A2A service operation or transport is implemented.

## ADR-008: Resource servers depend on a timeout-bounded facilitator interface

**Status:** Accepted — 2026-07-18

**Decision:** The public Worker depends only on the x402 facilitator operations
`verify`, `settle`, and `getSupported`. `FACILITATOR_MODE=simulator` selects the
secret-free deterministic implementation outside production; `remote` selects
the official SDK HTTP client and requires `X402_FACILITATOR_URL`. Production
rejects simulator mode. Every operation has a 10–30000 ms bounded timeout.

The facilitator is trusted to validate authorization correctness, prevent
replay according to its scheme, submit only the declared Base Sepolia transfer,
and report final settlement honestly. The resource server still owns route
policy, challenge construction, handler gating, lifecycle failure, projection,
grant revocation, and telemetry. It never sends task payloads, tunnel grants, or
participant authorization headers to the facilitator.

The official x402 middleware maps invalid, unavailable, timed-out, failed, and
pending facilitator outcomes to `402`. Verification failures run no handler.
Any non-final settlement after creation transitions the Durable Object to
`FAILED`, projects D1 legacy `EXPIRED`, and revokes grants. Local configuration
errors return structured `500`. Real settlement, a hosted facilitator, and
mainnet activation remain out of scope.

### Accepted trade-offs

- Pending settlement is not exposed as a public intermediate lifecycle state;
  it fails closed because this resource server has no settlement-reconciliation
  protocol yet.
- The SDK HTTP client owns remote wire details. Automata owns the interface,
  timeout, configuration gate, lifecycle consequences, and observability.
- No account-level service, paid resource, RPC, or real funds are used here.
