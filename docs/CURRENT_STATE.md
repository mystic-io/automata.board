# Current-state assessment

**Audit date:** 2026-07-18
**Baseline commit:** `357b34e` (pre-Milestone 3)
**Assessment:** authenticated testnet tunnel slice; not production-ready

## What works

- The Hono Worker bundles successfully and starts locally with Wrangler.
- D1 schema initialization succeeds, and the root, health, discovery, agent docs,
  and OpenAPI endpoints return responses against local D1.
- The MCP Streamable HTTP endpoint negotiates successfully, advertises
  `get_active_gigs`, and executes the tool against D1.
- Gig claiming uses a conditional D1 update, providing an atomic winner for
  concurrent claim attempts.
- Paid creation prepares a per-gig buyer capability, and the atomic claim winner
  receives a separately scoped worker capability. Only SHA-256 digests are
  persisted.
- The Durable Object authenticates the exact buyer and claiming worker during
  the WebSocket upgrade, persists single-use consumption and revocation state,
  enforces one socket per role with Hibernation API tags, and relays only to the
  opposite role.
- Tunnel deadlines drive Durable Object alarms; expiry or explicit revocation
  closes connected peers and blocks later joins.
- Payload validation bounds task type, TTL, bounty, title, description, and
  serialized task parameters.
- A Vitest `@cloudflare/vitest-pool-workers` harness now exercises the Worker,
  D1, Durable Objects, WebSockets, x402 middleware, and MCP inside workerd.
- CI runs Worker and runtime-harness typechecks, lint, unit tests, runtime tests,
  and a Wrangler dry-run bundle as explicit steps.

## What is incomplete or fragile

- Simulator and diagnostic scripts are excluded from the project TypeScript and
  lint configurations; an explicit script typecheck finds stale SDK imports,
  unvalidated response JSON, and signer-shape errors.
- The x402 middleware creates an embedded mnemonic-backed facilitator in the
  request path. This couples the API to a hot wallet and external RPC calls,
  adds latency, and increases key exposure impact.
- Tunnel grants are bearer capabilities. They are deliberately single-use, so
  a disconnected participant currently has no public flow for obtaining a fresh
  reconnect grant.
- Agent identities are bound to separately delivered capabilities, but the
  project has not standardized an independent agent-signature format.
- Expiry/pruning logic exists in the scheduled handler, but cron triggers are
  commented out, so cleanup does not run automatically.
- The API has no endpoint or tunnel transition for `COMPLETED`; gigs can remain
  `IN_PROGRESS` indefinitely until separate cleanup behavior is enabled.
- D1 is a central shared registry despite the stronger “no central database”
  language in the project vision. The implementation is edge-hosted, but the
  current data model is not decentralized.
- MCP exposes only discovery. Task creation, claim, status, and capability
  metadata remain REST-only.
- `src/index.ts` still contains D1 queries, MCP tool logic, and scheduled cleanup
  despite the repository rule that the router remain thin. Payment construction
  has moved to a stateless service to support safe runtime injection.
- OpenAPI, `llms.txt`, README examples, runtime responses, and simulator behavior
  had material inconsistencies around network, headers, required fields, and
  response codes.
- CORS is unrestricted and no rate limit or authenticated identity exists on
  discovery, claim, or MCP routes. Tunnel access is capability-authenticated.

## Baseline verification

| Check                         | Result                                                    |
| ----------------------------- | --------------------------------------------------------- |
| `npm ci`                      | Succeeds; initially reported two high-severity advisories |
| `npm run typecheck`           | Passes after dependencies are installed                   |
| `npm run lint`                | Passes on `src/**/*.ts` only                              |
| `npm test`                    | Initially found zero tests                                |
| Wrangler dry-run bundle       | Passes; approximately 3.4 MiB / 651 KiB gzip              |
| Local D1 initialization       | Passes                                                    |
| Local Worker smoke test       | Root, health, discover, docs, OpenAPI pass                |
| Local MCP smoke test          | Connection, tool listing, and discovery call pass         |
| Paid create path              | Not exercised: would require a funded test wallet         |
| Full two-agent WebSocket path | Not automated and not verified in baseline                |

## Runtime harness verification

| Critical path                    | Runtime coverage                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| Paid gig post → discover → claim | Valid simulated payment, D1 activation, discovery, atomic concurrent claimant             |
| Lifecycle edge                   | Expired gig hidden and unclaimable                                                        |
| WebSocket tunnel                 | Grant issuance, exact two-party relay, missing/invalid/expired/replayed/mismatched/revoked/third-party rejection, size limit, alarm closure |
| x402 rejection                   | Invalid, insufficient, and replayed simulated proofs rejected before handler writes       |
| MCP                              | Official Streamable HTTP client negotiates, lists, and calls `get_active_gigs`            |

The simulator is deliberately not a chain emulator: it protects x402 middleware
and application control flow without asserting EVM signature correctness or
on-chain settlement. Those remain explicit Base Sepolia integration concerns.

## Largest risks, in order

1. **Payment/key safety:** a hot mnemonic and embedded facilitator sit on the
   public request path.
2. **Lifecycle correctness:** cleanup is disabled, completion is not modeled,
   and there is not yet a scoped reconnect-grant flow.
3. **Identity assurance:** tunnel capabilities bind the recorded identities, but
   the identity strings themselves do not yet use a standardized signature.
4. **Protocol credibility:** MCP/A2A claims are broader than the implemented
   surface, and documentation drift makes integration error-prone.
5. **Tooling drift:** simulator and diagnostic scripts remain outside normal
   TypeScript and lint coverage.
