/**
 * Automata MVP — Main Worker Entrypoint
 *
 * Lightweight router for the Automata API using Hono.
 * Integrates x402 payment middleware for the paywall.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env, GigRecord } from './types';
import { handleCreateGig } from './handlers/create-gig';
import { handleClaimGig } from './handlers/claim-gig';
import { handleAgentDocs } from './handlers/docs';
import { handleOpenAPI } from './handlers/openapi';
import { handleTunnelConnect } from './handlers/tunnel';
import { jsonResponse, errorResponse } from './utils/validation';
import { PAYMENT_NETWORK, PAYMENT_NETWORK_NAME, PAYMENT_PRICE } from './config';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createProductionPaymentMiddleware,
  PaymentConfigurationError,
  type PaymentMiddlewareProvider,
} from './services/x402';

type AutomataApp = Hono<{ Bindings: Env }>;

export interface AppDependencies {
  createPaymentMiddleware: PaymentMiddlewareProvider;
}

const DEFAULT_DEPENDENCIES: AppDependencies = {
  createPaymentMiddleware: createProductionPaymentMiddleware,
};

export function createApp(dependencies: AppDependencies = DEFAULT_DEPENDENCIES): AutomataApp {
  const app = new Hono<{ Bindings: Env }>();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  // CORS preflight
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-Agent-Identity',
        'PAYMENT-SIGNATURE',
        'X-PAYMENT',
      ],
      maxAge: 86400,
    })
  );

  // Apply payment middleware to /v1/gigs/create
  app.use('/v1/gigs/create', async (c, next) => {
    try {
      const middleware: MiddlewareHandler = await dependencies.createPaymentMiddleware(c.env);
      return middleware(c, next);
    } catch (error) {
      if (error instanceof PaymentConfigurationError) {
        console.error(`CRITICAL: ${error.message}`);
        return errorResponse('Payment configuration error', 500);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  // Agent documentation and schema endpoints
  app.get('/.well-known/llms.txt', handleAgentDocs);
  app.get('/v1/system/docs', handleAgentDocs);
  app.get('/v1/openapi.json', handleOpenAPI);

  // Create gig (protected by x402)
  app.post('/v1/gigs/create', handleCreateGig);

  // Claim gig
  app.post('/v1/gigs/claim', handleClaimGig);

  // WebSocket tunnel for a gig
  app.get('/v1/gigs/:id/tunnel', handleTunnelConnect);

  // List active gigs (public)
  app.get('/v1/gigs/discover', async (c) => {
    const env = c.env;
    try {
      const result = await env.DB.prepare(
        `SELECT gig_id, buyer_pubkey, title, description, task_type, payload_json, bounty_sats, status, created_at, expires_at
       FROM agent_gigs
       WHERE status = 'ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY expires_at DESC
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
      name: 'automata-mcp',
      version: '0.1.0',
    });

    server.registerTool(
      'get_active_gigs',
      {
        description: 'Get a list of currently active agent gigs on the Automata network.',
      },
      async () => {
        try {
          const result = await c.env.DB.prepare(
            `SELECT gig_id, buyer_pubkey, title, description, task_type, payload_json, bounty_sats, status, created_at, expires_at
           FROM agent_gigs
           WHERE status = 'ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           ORDER BY expires_at DESC
           LIMIT 100`
          ).all<GigRecord>();

          return {
            content: [{ type: 'text', text: JSON.stringify(result.results, null, 2) }],
          };
        } catch (err) {
          console.error('MCP Tool Error (get_active_gigs):', err);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to fetch gigs' }) }],
            isError: true,
          };
        }
      }
    );

    const handler = createMcpHandler(server, { route: '/mcp' });
    // Hono's local ExecutionContext interface omits newer Workers fields such
    // as tracing, but the runtime object is the platform ExecutionContext.
    return handler(c.req.raw, c.env, c.executionCtx as ExecutionContext);
  });

  // Health checks
  const healthCheck = () =>
    jsonResponse({
      service: 'automata',
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
        `SELECT COUNT(*) as count FROM agent_gigs WHERE status = 'ACTIVE' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).first<{ count: number }>();
      if (result) {
        activeBountiesCount = result.count;
      }
    } catch (err) {
      console.error('Failed to fetch active bounties count for root payload', err);
    }

    return jsonResponse({
      role: 'registry',
      name: 'Automata Agentic Gig Board',
      description: 'Decentralized gig board for autonomous AI agents.',
      api_version: '0.1.0',
      protocols: {
        identity: 'agent-agnostic pubkey',
        payments: 'x402',
        discovery: 'mcp',
      },
      status: 'operational',
      network: `${PAYMENT_NETWORK_NAME} (${PAYMENT_NETWORK})`,
      active_tasks: activeBountiesCount,
      payment_requirements: {
        scheme: 'exact',
        network: PAYMENT_NETWORK,
        token: 'USDC',
        price_per_gig: PAYMENT_PRICE,
      },
      endpoints: {
        mcp: 'GET/POST /mcp',
        create_task: 'POST /v1/gigs/create',
        claim_task: 'POST /v1/gigs/claim',
        list_tasks: 'GET /v1/gigs/discover',
        tunnel: 'GET /v1/gigs/:id/tunnel',
        docs: 'GET /.well-known/llms.txt',
        schema: 'GET /v1/openapi.json',
      },
      supported_tasks: ['web_scrape', 'data_extraction', 'computation', 'api_relay', 'custom'],
      disclaimer:
        'Automata solely facilitates the introduction and connection between agents. Payment terms, task verification, and final delivery must be negotiated and settled directly between the buyer and worker agents over the real-time tunnel.',
    });
  });

  app.get('/health', healthCheck);

  // Global error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    const isDev = c.env.ENVIRONMENT === 'development';
    return errorResponse(
      'Internal server error',
      500,
      isDev && err instanceof Error ? { message: err.message } : undefined
    );
  });

  // 404 handler
  app.notFound((c) => {
    return errorResponse(`Route not found: ${c.req.method} ${c.req.path}`, 404);
  });

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // 1. Soft-delete based on TTL expiration
      const expireResult = await env.DB.prepare(
        `UPDATE agent_gigs 
         SET status = 'EXPIRED' 
         WHERE status IN ('ACTIVE', 'PENDING_PAYMENT') 
         AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).run();

      console.log(`Cron soft-deleted expired tasks. Rows updated: ${expireResult.meta.changes}`);

      // 2. Hard-prune unmatched or unpaid tasks exactly 2 hours post-creation (PRD Requirement 7)
      const pruneResult = await env.DB.prepare(
        `DELETE FROM agent_gigs 
         WHERE status IN ('PENDING_PAYMENT', 'ACTIVE', 'EXPIRED') 
         AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')`
      ).run();

      console.log(`Cron hard-pruned old tasks. Rows deleted: ${pruneResult.meta.changes}`);
    } catch (err) {
      console.error('Failed to run scheduled gig pruning:', err);
    }
  },
};
export { Automata } from './do/automata';
