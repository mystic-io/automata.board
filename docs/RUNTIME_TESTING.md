# Cloudflare runtime tests

Automata's integration harness uses Vitest with
`@cloudflare/vitest-pool-workers`. The suite runs locally inside workerd with
the D1 and Durable Object bindings from `wrangler.toml`; it does not deploy a
Worker or contact Cloudflare services.

Run the harness with:

```bash
npm run test:runtime
```

`npm run verify` includes the runtime suite after typecheck, lint, and unit
tests and before the Wrangler dry-run bundle. The same checks run in CI.

## Safety and determinism

- `test/runtime/worker.ts` composes the production app with the same explicit
  facilitator interface and the deterministic, secret-free simulator.
- EIP-3009-shaped simulated authorizations exercise the real x402 Hono
  middleware and cover valid, invalid, insufficient, and replayed payments
  without cryptographic verification, funds, secrets, or RPC calls.
- The D1 schema is loaded from `schema.sql` before each test, and fixture rows
  are reset between tests.
- MCP tests use the official Streamable HTTP client with an in-runtime fetch
  adapter, so no request leaves workerd.
- Tunnel tests obtain real opaque grants through the paid-create and atomic-claim
  application paths. Only SHA-256 grant digests enter Durable Object storage;
  tests use no signing secret or external identity provider.
- Base Sepolia (`eip155:84532`) remains the only configured payment network.

## Contract conformance

`test/runtime/contracts.runtime.test.ts` treats the running Worker as the system
under test. It validates real discovery/error payloads against schemas served by
`/v1/openapi.json`, compares MCP tool/resource discovery to `MCP_CONTRACT`, reads
the contract manifest over MCP, verifies the A2A 1.0 Agent Card and Message
profile, and decodes and validates `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
`PAYMENT-RESPONSE` as x402 v2 payloads.

The executable schemas live in `src/contracts.ts`. A contract change that is not
reflected by runtime validation, OpenAPI, or MCP therefore breaks a workerd gate.
The `1.x` compatibility promise is additive; removals, stricter required fields,
or semantic changes require a new major contract version and migration path.

## Facilitator behavior matrix

`test/runtime/payment.runtime.test.ts` covers valid and invalid verification,
replay, unavailable and timed-out verification, failed/unavailable/timed-out
settlement, and settlement that remains pending past the deadline. The official
x402 middleware maps all unverified or unsettled outcomes to `402`:

- verify invalid/unavailable/timeout: handler does not run and no gig exists;
- settle false/unavailable/timeout/pending: the handler-created gig transitions
  to `FAILED`, D1 projects legacy `EXPIRED`, grants are revoked, and the caller
  receives `402`;
- local configuration errors: middleware cannot be constructed and returns
  structured `500` without invoking the handler.

No test contacts a hosted facilitator, RPC endpoint, or funded wallet.
Replay state comes from `facilitator_simulator_nonces`, created by `schema.sql`
for fresh databases and additive migration `0002_facilitator_simulator.sql` for
existing databases.

## Authenticated tunnel lifecycle

`test/runtime/websocket.runtime.test.ts` exercises authorization in workerd at
the Durable Object boundary, not only at the Hono route:

1. Paid creation returns the buyer's opaque, single-use capability and prepares
   the per-gig Durable Object with its digest, buyer identity, and deadline.
2. The winning claim activates that session with the claiming worker identity
   and a separately generated worker capability digest.
3. WebSocket upgrades must send `Authorization: Bearer <token>` and
   `X-Agent-Identity: <exact sender identity>`. The object validates gig, role,
   identity, digest, activation, expiry, revocation, and unused state before it
   accepts and tags the socket.
4. The suite proves valid two-party relay and rejection of missing, malformed,
   identity-swapped, gig-mismatched, expired, replayed, revoked, and third-party
   attempts. It also proves timeout alarms close both authorized peers.

Capabilities are deliberately single-use. A disconnected participant cannot
reuse the consumed token for another upgrade. The reconnect endpoint validates
that token on the control plane, invalidates it, and returns a fresh scoped grant
only after the role's previous socket has disconnected.

## Lifecycle and observability coverage

`test/runtime/lifecycle.runtime.test.ts` proves:

- one atomic concurrent claim winner and safe same-message retries;
- claim timeout release and a later replacement winner;
- `IN_PROGRESS → DELIVERED → COMPLETED → CLOSED` ordering and replay safety;
- rejection of early acceptance and other invalid transitions;
- terminal cancellation and worker abandonment;
- reconnect rotation with rejection of the old consumed grant;
- D1 legacy status plus detailed lifecycle/version convergence; and
- correlation-aware transition and grant-rejection events with no grant token.

`test/runtime/payment.runtime.test.ts` also forces settlement failure after the
create handler has run. The middleware then drives the new gig to `FAILED`,
projects legacy `EXPIRED`, revokes its tunnel, and returns `402`; no real funds,
RPC, signature, or secret is involved.

Deadline tests mutate the persisted test fixture clock and execute the Durable
Object alarm directly. Claim timeout, expiry before join, and expiry with live
sockets therefore remain deterministic instead of waiting on wall-clock TTLs.

Workers Logs are asserted through event payloads where feasible. Tests also
assert the echoed `X-Correlation-ID`; they do not depend on a Cloudflare account,
log retention service, Analytics Engine binding, or remote tail session.

## Adding a runtime test

1. Add a file matching `test/runtime/**/*.runtime.test.ts`.
2. Exercise the Worker through `workerFetch()` when testing an HTTP or MCP
   surface. Use `env` and the helpers from `cloudflare:test` only when direct
   binding or Durable Object inspection is required.
3. Reuse `seedGig()`, `postPaidGig()`, and the payment helpers in
   `test/runtime/helpers.ts`; keep fixtures deterministic and unique.
4. Add any test-only database setup to `test/runtime/setup.ts`. Do not add
   secrets, remote bindings, live RPC calls, or real settlement.
5. Run `npm run typecheck:runtime`, `npm run lint`, and
   `npm run test:runtime` before opening a pull request.

When extending the tunnel, assert authorization from inside the Durable Object
and inspect its persisted state or socket tags where edge-only assertions could
pass trivially.
