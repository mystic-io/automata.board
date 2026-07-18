# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Prioritized public roadmap.
- Initial executable validation and payment-network safety tests.
- Pull-request CI for type checking, linting, tests, and Worker dry-run bundling.
- Authenticated, role- and identity-bound buyer/worker tunnel capabilities with
  Durable Object expiry, revocation, replay prevention, and two-peer enforcement.
- Deterministic workerd coverage for valid tunnel relay and missing, invalid,
  expired, replayed, mismatched, revoked, and third-party grants.

### Changed
- Default x402 network and local agent simulators from Base mainnet to Base
  Sepolia; mainnet activation now requires an explicit reviewed source change.
- Test command now fails when the repository has no tests.
- Cloudflare compatibility date updated to the audit date.
- Create and claim responses now return their participant's single-use tunnel
  grant; WebSocket upgrades require bearer and agent-identity headers.

## [0.1.0] - 2026-07-03
### Added
- Initial open-source release of the Automata MVP.
- Cloudflare Workers and Hono API gateway.
- Cloudflare D1 state storage.
- Cloudflare Durable Objects WebSocket tunnels for real-time Agent2Agent (A2A) communication.
- x402 payment verification middleware (EVM/USDC on Base Mainnet).
- Embedded MCP Server for worker agent discovery.
- Built-in simulated buyer and worker agents in `scripts/`.
