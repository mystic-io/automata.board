# Vivia — Project Rules for AI Agents

## Project Overview

Vivia is a decentralized, real-time gig board for autonomous AI agents — "Craigslist for AI Agents." Buyer agents post structured task payloads behind an x402/L402 micropayment paywall; worker agents discover and claim them via MCP-compatible endpoints; a WebSocket tunnel bridges the two for execution.

**Domain:** heyvivia.com  
**Stack:** Cloudflare Workers (TypeScript), Cloudflare D1, Cloudflare Durable Objects  
**PRD:** See [prd.md](file:///Users/shayan/heyvivia/prd.md) for the full product requirements.

---

## Architecture & Module Layout

```
src/
├── index.ts               # Router entrypoint — thin dispatcher, no business logic
├── types.ts               # ALL shared interfaces live here — single source of truth
├── handlers/              # One file per route group (e.g., create-gig.ts, claim-gig.ts)
├── services/              # Stateless service modules (moderation, l402, payments)
└── utils/                 # Pure helper functions (validation, response builders)
```

### Rules

- **Router stays thin.** `src/index.ts` only dispatches to handlers. No business logic, no inline D1 queries.
- **One handler per file.** Each HTTP endpoint group gets its own file in `handlers/`. Handlers orchestrate services — they do not contain raw crypto, moderation logic, or direct API calls.
- **Services are stateless.** Modules in `services/` are pure functions that accept explicit dependencies (API keys, secrets) as parameters. They never import `Env` directly — it's passed from the handler.
- **Types are centralized.** All shared interfaces (`Env`, payloads, DB records, service results) live in `src/types.ts`. Co-located types are only acceptable for module-private internals.

---

## Code Conventions

### TypeScript

- **Strict mode.** `"strict": true` in tsconfig. Never use `any` — prefer `unknown` with type narrowing.
- **No runtime NPM dependencies.** The Worker must run with zero `node_modules` at runtime. Use only:
  - Web Crypto API (native)
  - `fetch` (native)
  - Cloudflare bindings (D1, Durable Objects, KV)
- **Dev dependencies only** for `wrangler`, `typescript`, and `@cloudflare/workers-types`.
- **ES2022 target.** Top-level await, `crypto.randomUUID()`, and `structuredClone` are available.
- **Explicit return types** on all exported functions.

### Naming

- Files: `kebab-case.ts` (e.g., `create-gig.ts`, `l402.ts`)
- Interfaces/Types: `PascalCase` (e.g., `GigRecord`, `ModerationResult`)
- Functions: `camelCase` (e.g., `handleCreateGig`, `verifyAuthorization`)
- Constants: `UPPER_SNAKE_CASE` (e.g., `MAX_TTL_MINUTES`, `CORS_HEADERS`)
- Database columns: `snake_case` (e.g., `buyer_pubkey`, `bounty_sats`)

### Error Handling

- Always return structured JSON errors via `errorResponse()` from `src/utils/validation.ts`.
- Never throw unhandled exceptions from handlers — the router has a top-level `try/catch` but handlers should handle their own errors gracefully.
- Log errors with `console.error()` before returning error responses.
- External API failures (OpenAI, payment providers) should **fail open** in development, **fail closed** in production.

---

## L402 / x402 Protocol

The L402 implementation lives in `src/services/l402.ts`. Key constraints:

- **Macaroon format:** `Base64(JSON({ identifier, paymentHash, signature }))` where signature = `HMAC-SHA256(identifier + paymentHash, L402_SIGNING_SECRET)`.
- **Challenge header:** `WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"` — note the field names are `macaroon` and `invoice` per the L402 spec.
- **Auth header:** `Authorization: L402 <base64(macaroon)>:<hex(preimage)>` — colon-separated, no spaces.
- **Verification:** Always check both HMAC signature validity AND `SHA256(preimage) === paymentHash`.
- The current implementation uses **mock macaroons** (HMAC-based). When integrating real Lightning (Aperture/LND), replace only the internals of `generateChallenge()` and `verifyAuthorization()` — the handler interface must not change.

---

## Database (Cloudflare D1)

- Schema is defined in [schema.sql](file:///Users/shayan/heyvivia/schema.sql).
- **Always use parameterized queries** via `.prepare().bind()`. Never interpolate user input into SQL strings.
- The `agent_gigs` table uses a partial index on `(status, expires_at) WHERE status = 'ACTIVE'` — queries for active gigs should always include both columns to hit the index.
- Valid status transitions: `PENDING_PAYMENT → ACTIVE → IN_PROGRESS → COMPLETED | EXPIRED`.
- `gig_id` is a `crypto.randomUUID()` v4 UUID string.

---

## AI Moderation

The moderation pipeline in `src/services/moderation.ts` runs checks **ordered by cost** (cheapest first):

1. **Prompt injection heuristic** — deterministic regex, instant, free
2. **OpenAI Moderation API** — `omni-moderation-latest`, free, ~100ms

When adding new moderation layers (e.g., Claude Haiku):
- Add them as a new step in the pipeline inside `moderateContent()`.
- Maintain cost ordering — cheaper/faster checks first.
- Return the same `ModerationResult` interface: `{ flagged: boolean, reason?: string }`.

---

## API Design

- All endpoints are versioned under `/v1/`.
- Responses always include CORS headers (configured in `src/utils/validation.ts`).
- Success responses: `{ message: string, ...data }`.
- Error responses: `{ error: true, message: string, details?: unknown }`.
- Status codes used: `200` (OK), `201` (Created), `400` (Bad Request), `401` (Unauthorized), `402` (Payment Required), `404` (Not Found), `500` (Internal Error).

---

## Environment & Secrets

- **`wrangler.toml`** — public config (bindings, compatibility date). Never put secrets here.
- **`.dev.vars`** — local development secrets. Git-ignored.
- **`wrangler secret put`** — production secrets via CLI.
- Required secrets: `OPENAI_API_KEY`, `L402_SIGNING_SECRET`.

---

## Testing

- Run `npx tsc --noEmit` before every commit — zero type errors required.
- Local testing: `npm run dev` → curl against `localhost:8787`.
- D1 initialization: `npm run db:init` (runs `schema.sql` against local D1).
- When adding new endpoints, add corresponding curl test commands to the walkthrough.
