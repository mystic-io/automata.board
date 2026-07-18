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

- `test/runtime/worker.ts` is a test-only Worker entrypoint. It composes the
  production app with a deterministic x402 facilitator instead of the
  mnemonic-backed Base Sepolia facilitator.
- Simulated proofs exercise the real x402 Hono middleware and cover valid,
  invalid, insufficient, and replayed payments without signatures, funds,
  secrets, or RPC calls.
- The D1 schema is loaded from `schema.sql` before each test, and fixture rows
  are reset between tests.
- MCP tests use the official Streamable HTTP client with an in-runtime fetch
  adapter, so no request leaves workerd.
- Tunnel tests obtain real opaque grants through the paid-create and atomic-claim
  application paths. Only SHA-256 grant digests enter Durable Object storage;
  tests use no signing secret or external identity provider.
- Base Sepolia (`eip155:84532`) remains the only configured payment network.

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
reconnect with the consumed token; a later reconnect-grant endpoint belongs to
the lifecycle milestone and must preserve the same two-party scope.

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
