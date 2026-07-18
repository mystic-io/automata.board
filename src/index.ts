/**
 * Automata MVP — Main Worker Entrypoint
 *
 * Lightweight router for the Automata API using Hono.
 * Integrates x402 payment middleware for the paywall.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env, GigRecord, RequestContextVariables } from './types';
import { handleCreateGig } from './handlers/create-gig';
import { handleClaimGig } from './handlers/claim-gig';
import { handleAgentDocs } from './handlers/docs';
import { handleOpenAPI } from './handlers/openapi';
import { handleTunnelConnect } from './handlers/tunnel';
import { handleLifecycleAction, handleLifecycleStatus, handleReconnect } from './handlers/lifecycle';
import { jsonResponse, errorResponse } from './utils/validation';
import { PAYMENT_NETWORK, PAYMENT_NETWORK_NAME, PAYMENT_PRICE } from './config';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createProductionPaymentMiddleware,
  PaymentConfigurationError,
  type PaymentMiddlewareProvider,
} from './services/x402';
import { logEvent, resolveCorrelationId, safeErrorName } from './services/observability';

type AutomataApp = Hono<{ Bindings: Env; Variables: RequestContextVariables }>;

export interface AppDependencies {
  createPaymentMiddleware: PaymentMiddlewareProvider;
}

const DEFAULT_DEPENDENCIES: AppDependencies = {
  createPaymentMiddleware: createProductionPaymentMiddleware,
};

export function createApp(dependencies: AppDependencies = DEFAULT_DEPENDENCIES): AutomataApp {
  const app = new Hono<{ Bindings: Env; Variables: RequestContextVariables }>();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  app.use('*', async (c, next) => {
    const correlationId = resolveCorrelationId(c.req.header('X-Correlation-ID') ?? null);
    const startedAt = Date.now();
    c.set('correlationId', correlationId);
    await next();
    c.header('X-Correlation-ID', correlationId);
    logEvent('info', 'http.request_completed', {
      correlation_id: correlationId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - startedAt,
    });
  });

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
        'X-Correlation-ID',
        'PAYMENT-SIGNATURE',
        'X-PAYMENT',
      ],
      maxAge: 86400,
    })
  );

  // Apply payment middleware to /v1/gigs/create
  app.use('/v1/gigs/create', async (c, next) => {
    const hasPayment = Boolean(c.req.header('PAYMENT-SIGNATURE') || c.req.header('X-PAYMENT'));
    try {
      const middleware: MiddlewareHandler = await dependencies.createPaymentMiddleware(c.env);
      const response = await middleware(c, next);
      const status = response?.status ?? c.res.status;
      const createdGigId = c.get('createdGigId');
      if (status === 402 && createdGigId) {
        await c.env.TUNNEL.getByName(createdGigId).revokeTunnelSession(
          'x402 settlement failed after gig creation',
          c.get('correlationId')
        );
      }
      logEvent(status === 402 ? 'warn' : 'info', 'x402.verification_outcome', {
        correlation_id: c.get('correlationId'),
        gig_id: createdGigId,
        outcome: status === 402 ? (hasPayment ? 'rejected' : 'challenge') : 'verified_and_settled',
        status,
      });
      return response;
    } catch (error) {
      if (error instanceof PaymentConfigurationError) {
        logEvent('error', 'x402.configuration_failed', {
          correlation_id: c.get('correlationId'),
          outcome: 'failed_closed',
          error_name: error.name,
        });
        return errorResponse('Payment configuration error', 500);
      }
      logEvent('error', 'x402.verification_outcome', {
        correlation_id: c.get('correlationId'),
        outcome: 'error',
        error_name: safeErrorName(error),
      });
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

  app.get('/v1/gigs/:id/status', handleLifecycleStatus);
  app.post('/v1/gigs/:id/lifecycle', handleLifecycleAction);
  app.post('/v1/gigs/:id/reconnect', handleReconnect);

  // WebSocket tunnel for a gig
  app.get('/v1/gigs/:id/tunnel', handleTunnelConnect);

  // List active gigs (public)
  app.get('/v1/gigs/discover', async (c) => {
    const env = c.env;
    try {
      const result = await env.DB.prepare(
        `SELECT gig_id, buyer_pubkey, title, description, task_type, payload_json, bounty_sats, status, lifecycle_state, lifecycle_version, created_at, updated_at, expires_at
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
            `SELECT gig_id, buyer_pubkey, title, description, task_type, payload_json, bounty_sats, status, lifecycle_state, lifecycle_version, created_at, updated_at, expires_at
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
  const healthCheck = async (c: Parameters<typeof handleLifecycleStatus>[0]) => {
    try {
      await c.env.DB.prepare('SELECT 1 AS ready').first<{ ready: number }>();
      return jsonResponse({ service: 'automata', version: '0.1.0', status: 'ready', checks: { d1: 'ready', lifecycle_coordinator: 'configured', observability: 'enabled' }, timestamp: new Date().toISOString() });
    } catch (error) {
      logEvent('error', 'health.readiness_failed', { correlation_id: c.get('correlationId'), outcome: 'not_ready', error_name: safeErrorName(error) });
      return jsonResponse({ service: 'automata', status: 'not_ready', checks: { d1: 'failed' }, timestamp: new Date().toISOString() }, 503);
    }
  };

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
        lifecycle: 'GET /v1/gigs/:id/status; POST /v1/gigs/:id/lifecycle',
        reconnect: 'POST /v1/gigs/:id/reconnect',
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
    logEvent('error', 'http.unhandled_error', { correlation_id: c.get('correlationId'), error_name: safeErrorName(err), path: c.req.path });
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
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const correlationId = crypto.randomUUID();
    try {
      const rows = await env.DB.prepare(
        `SELECT gig_id FROM agent_gigs WHERE lifecycle_state NOT IN ('CLOSED', 'CANCELLED', 'EXPIRED', 'FAILED') ORDER BY expires_at ASC LIMIT 100`
      ).all<{ gig_id: string }>();
      const results = await Promise.allSettled(rows.results.map((row) => env.TUNNEL.getByName(row.gig_id).reconcileProjection(correlationId)));
      const rejected = results.filter((result) => result.status === 'rejected').length;
      logEvent(rejected > 0 ? 'warn' : 'info', 'lifecycle.scheduled_reconciliation', { correlation_id: correlationId, outcome: rejected > 0 ? 'partial' : 'success', checked: rows.results.length, rejected });
    } catch (err) {
      logEvent('error', 'lifecycle.scheduled_reconciliation', { correlation_id: correlationId, outcome: 'failed', error_name: safeErrorName(err) });
    }
  },
};
export { Automata } from './do/automata';
