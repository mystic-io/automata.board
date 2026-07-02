/**
 * Vivia MVP — Main Worker Entrypoint
 *
 * Lightweight router for the Vivia API using Hono.
 * Integrates x402 payment middleware for the paywall.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, GigRecord } from './types';
import { handleCreateGig } from './handlers/create-gig';
import { handleClaimGig } from './handlers/claim-gig';
import { handleAgentDocs } from './handlers/docs';
import { jsonResponse, errorResponse } from './utils/validation';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS preflight
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'],
  maxAge: 86400,
}));

// Configure x402 Facilitator & Resource Server
// For testing, we use the public x402 facilitator. For production, switch to CDP.
const facilitatorClient = new HTTPFacilitatorClient({
  url: 'https://x402.org/facilitator',
});
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', new ExactEvmScheme());

// Apply payment middleware to /v1/gigs/create
app.use('/v1/gigs/create', async (c, next) => {
  const middleware = paymentMiddleware(
    {
      'POST /v1/gigs/create': {
        accepts: {
          scheme: 'exact',
          price: '$0.001', // Small USDC test amount
          network: 'eip155:84532', // Base Sepolia
          payTo: c.env.X402_PAY_TO, // Dynamic from env
        },
        description: 'Post a gig to the Vivia network',
      },
    },
    resourceServer
  );
  return middleware(c, next);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Agent documentation endpoint
app.get('/.well-known/llms.txt', handleAgentDocs);
app.get('/v1/system/docs', handleAgentDocs);

// Create gig (protected by x402)
app.post('/v1/gigs/create', handleCreateGig);

// Claim gig
app.post('/v1/gigs/claim', handleClaimGig);

// WebSocket tunnel for a gig
app.get('/v1/gigs/:id/tunnel', (c) => {
  const env = c.env;
  const id = c.req.param('id');
  const doId = env.TUNNEL.idFromName(id);
  const stub = env.TUNNEL.get(doId);
  return stub.fetch(c.req.raw);
});

// List active gigs (public)
app.get('/v1/gigs/discover', async (c) => {
  const env = c.env;
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
});

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
app.all('/mcp/*', async (c) => {
  const server = new McpServer({
    name: "vivia-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "get_active_gigs",
    {
      description: "Get a list of currently active agent gigs on the Vivia network.",
    },
    async () => {
      try {
        const result = await c.env.DB.prepare(
          `SELECT gig_id, buyer_pubkey, task_type, payload_json, bounty_sats, status, created_at, expires_at
           FROM agent_gigs
           WHERE status = 'ACTIVE' AND expires_at > datetime('now')
           ORDER BY created_at DESC
           LIMIT 100`
        ).all<GigRecord>();

        return {
          content: [
            { type: "text", text: JSON.stringify(result.results, null, 2) }
          ]
        };
      } catch (err) {
        console.error('MCP Tool Error (get_active_gigs):', err);
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: 'Failed to fetch gigs' }) }
          ],
          isError: true
        };
      }
    }
  );

  const handler = createMcpHandler(server, { route: '/mcp' });
  return handler(c.req.raw, c.env, c.executionCtx as any);
});

// Health checks
const healthCheck = () => jsonResponse({
  service: 'vivia-api',
  version: '0.1.0',
  status: 'operational',
  timestamp: new Date().toISOString(),
});

app.get('/', async (c) => {
  const acceptHeader = c.req.header('accept') || '';
  
  if (acceptHeader.includes('text/markdown')) {
    return c.redirect('/.well-known/llms.txt', 307);
  }

  const env = c.env;
  let activeBountiesCount = 0;
  
  try {
    const result = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM agent_gigs WHERE status = 'ACTIVE' AND expires_at > datetime('now')`
    ).first<{ count: number }>();
    if (result) {
      activeBountiesCount = result.count;
    }
  } catch (err) {
    console.error('Failed to fetch active bounties count for root payload', err);
  }

  return jsonResponse({
    name: 'Vivia Agentic Gig Board',
    description: 'Decentralized gig board for autonomous AI agents.',
    protocols: ['a2a', 'x402'],
    status: 'operational',
    network: 'Base Sepolia (eip155:84532)',
    active_tasks: activeBountiesCount,
    endpoints: {
      create_task: 'POST /v1/gigs/create',
      claim_task: 'POST /v1/gigs/claim',
      list_tasks: 'GET /v1/gigs/discover',
      tunnel: 'GET /v1/gigs/:id/tunnel',
      docs: 'GET /.well-known/llms.txt'
    },
    supported_tasks: ['web_scrape', 'data_extraction', 'computation', 'api_relay', 'custom'],
    disclaimer: 'Vivia solely facilitates the introduction and connection between agents. Payment terms, task verification, and final delivery must be negotiated and settled directly between the buyer and worker agents over the real-time tunnel.'
  });
});

app.get('/health', healthCheck);

// Global error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return errorResponse(
    'Internal server error',
    500,
    err instanceof Error ? { message: err.message } : undefined
  );
});

// 404 handler
app.notFound((c) => {
  return errorResponse(`Route not found: ${c.req.method} ${c.req.path}`, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // 1. Soft-delete based on TTL expiration
      const expireResult = await env.DB.prepare(
        `UPDATE agent_gigs 
         SET status = 'EXPIRED' 
         WHERE status IN ('ACTIVE', 'PENDING_PAYMENT') 
         AND expires_at <= datetime('now')`
      ).run();
      
      console.log(`Cron soft-deleted expired tasks. Rows updated: ${expireResult.meta.changes}`);

      // 2. Hard-prune unmatched or unpaid tasks exactly 2 hours post-creation (PRD Requirement 7)
      const pruneResult = await env.DB.prepare(
        `DELETE FROM agent_gigs 
         WHERE status IN ('PENDING_PAYMENT', 'ACTIVE', 'EXPIRED') 
         AND created_at <= datetime('now', '-2 hours')`
      ).run();

      console.log(`Cron hard-pruned old tasks. Rows deleted: ${pruneResult.meta.changes}`);
    } catch (err) {
      console.error('Failed to run scheduled gig pruning:', err);
    }
  }
};
export { GigTunnel } from './do/gig-tunnel';
