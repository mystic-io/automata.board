/**
 * Vivia MVP — Main Worker Entrypoint
 *
 * Lightweight router for the Vivia API. Dispatches requests
 * to modular handlers and provides top-level error handling.
 *
 * Routes:
 *   POST   /v1/gigs/create  → Create a new gig (L402 paywall)
 *   GET    /v1/gigs/active   → List active gigs (MCP-compatible)
 *   OPTIONS *                → CORS preflight
 */

import type { Env, GigRecord } from './types';
import { handleCreateGig } from './handlers/create-gig';
import { jsonResponse, errorResponse } from './utils/validation';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      // ─── POST /v1/gigs/create ───────────────────────────────────────
      if (method === 'POST' && pathname === '/v1/gigs/create') {
        return await handleCreateGig(request, env);
      }

      // ─── GET /v1/gigs/active ────────────────────────────────────────
      if (method === 'GET' && pathname === '/v1/gigs/active') {
        return await handleListActiveGigs(env);
      }

      // ─── Health check ───────────────────────────────────────────────
      if (method === 'GET' && (pathname === '/' || pathname === '/health')) {
        return jsonResponse({
          service: 'vivia-api',
          version: '0.1.0',
          status: 'operational',
          timestamp: new Date().toISOString(),
        });
      }

      // ─── 404 ───────────────────────────────────────────────────────
      return errorResponse(`Route not found: ${method} ${pathname}`, 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse(
        'Internal server error',
        500,
        err instanceof Error ? { message: err.message } : undefined
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// GET /v1/gigs/active — Public board for MCP-compatible agent polling
// ---------------------------------------------------------------------------

async function handleListActiveGigs(env: Env): Promise<Response> {
  try {
    const result = await env.DB.prepare(
      `SELECT gig_id, buyer_pubkey, task_type, payload_json, bounty_sats, status, created_at, expires_at
       FROM agent_gigs
       WHERE status = 'ACTIVE' AND expires_at > datetime('now')
       ORDER BY created_at DESC
       LIMIT 100`
    ).all<GigRecord>();

    return jsonResponse({
      count: result.results.length,
      gigs: result.results,
    });
  } catch (err) {
    console.error('D1 query error:', err);
    return errorResponse('Failed to fetch active gigs', 500);
  }
}
