/**
 * Automata MVP — Main Worker Entrypoint
 *
 * Lightweight router for the Automata API using Hono.
 * Integrates x402 payment middleware for the paywall.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Env, RequestContextVariables } from './types';
import { handleCreateGig } from './handlers/create-gig';
import { handleClaimGig } from './handlers/claim-gig';
import { handleAgentDocs } from './handlers/docs';
import { handleOpenAPI } from './handlers/openapi';
import { handleTunnelConnect } from './handlers/tunnel';
import { handleDiscoverGigs } from './handlers/discover-gigs';
import { handleMcp } from './handlers/mcp';
import {
  handleLifecycleAction,
  handleLifecycleStatus,
  handleReconnect,
} from './handlers/lifecycle';
import { jsonResponse, errorResponse } from './utils/validation';
import { PAYMENT_NETWORK, PAYMENT_NETWORK_NAME, PAYMENT_PRICE } from './config';
import {
  createProductionPaymentMiddleware,
  PaymentConfigurationError,
  type PaymentMiddlewareProvider,
} from './services/x402';
import { logEvent, resolveCorrelationId, safeErrorName } from './services/observability';
import { runScheduledReconciliation } from './services/reconciliation';
import { A2A_PROTOCOL_VERSION, CONTRACT_VERSION } from './contracts';

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
      const middleware: MiddlewareHandler = await dependencies.createPaymentMiddleware(
        c.env,
        c.get('correlationId')
      );
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
      const createdGigId = c.get('createdGigId');
      if (createdGigId) {
        await c.env.TUNNEL.getByName(createdGigId).revokeTunnelSession(
          'x402 facilitator unavailable after gig creation',
          c.get('correlationId')
        );
      }
      logEvent('error', 'x402.verification_outcome', {
        correlation_id: c.get('correlationId'),
        gig_id: createdGigId,
        outcome: 'facilitator_unavailable',
        error_name: safeErrorName(error),
        status: 503,
      });
      return errorResponse('Payment facilitator unavailable', 503);
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
  app.get('/v1/gigs/discover', handleDiscoverGigs);

  // ---------------------------------------------------------------------------
  // MCP Server
  // ---------------------------------------------------------------------------

  app.all('/mcp/*', handleMcp);

  // Health checks
  const healthCheck = async (c: Parameters<typeof handleLifecycleStatus>[0]) => {
    try {
      await c.env.DB.prepare('SELECT 1 AS ready').first<{ ready: number }>();
      return jsonResponse({
        service: 'automata',
        version: CONTRACT_VERSION,
        status: 'ready',
        checks: {
          d1: 'ready',
          lifecycle_coordinator: 'configured',
          facilitator: c.env.FACILITATOR_MODE,
          observability: 'enabled',
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logEvent('error', 'health.readiness_failed', {
        correlation_id: c.get('correlationId'),
        outcome: 'not_ready',
        error_name: safeErrorName(error),
      });
      return jsonResponse(
        {
          service: 'automata',
          status: 'not_ready',
          checks: { d1: 'failed' },
          timestamp: new Date().toISOString(),
        },
        503
      );
    }
  };

  const agentCard = async (c: Parameters<typeof handleLifecycleStatus>[0]) => {
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
      name: 'Automata Agentic Gig Board',
      description: 'Testnet-only gig board and lifecycle coordinator for autonomous agents.',
      supportedInterfaces: [
        {
          url: 'https://automata.board/v1',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: A2A_PROTOCOL_VERSION,
        },
      ],
      version: CONTRACT_VERSION,
      documentationUrl: 'https://automata.board/.well-known/llms.txt',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [
        {
          id: 'automata-gig-lifecycle',
          name: 'Automata gig lifecycle',
          description: 'Create, discover, claim, coordinate, and complete testnet agent gigs.',
          tags: ['gig-board', 'x402', 'mcp', 'a2a', 'testnet'],
          inputModes: ['application/json'],
          outputModes: ['application/json'],
        },
      ],
      // Additive legacy discovery fields retained for pre-Milestone-5 clients.
      role: 'registry',
      api_version: CONTRACT_VERSION,
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
  };

  app.get('/', agentCard);
  app.get('/.well-known/agent-card.json', agentCard);

  app.get('/health', healthCheck);

  // Global error handler
  app.onError((err, c) => {
    logEvent('error', 'http.unhandled_error', {
      correlation_id: c.get('correlationId'),
      error_name: safeErrorName(err),
      path: c.req.path,
    });
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
    await runScheduledReconciliation(env, crypto.randomUUID());
  },
};
export { Automata } from './do/automata';
