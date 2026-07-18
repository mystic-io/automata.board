import {
  A2A_AUTOMATA_MESSAGE_SCHEMA,
  AGENT_CARD_SCHEMA,
  CLAIM_GIG_PAYLOAD_SCHEMA,
  CONTRACT_VERSION,
  CREATE_GIG_PAYLOAD_SCHEMA,
  DISCOVER_RESPONSE_SCHEMA,
  ERROR_RESPONSE_SCHEMA,
  GIG_RECORD_SCHEMA,
  LIFECYCLE_ACTION_PAYLOAD_SCHEMA,
  LIFECYCLE_RESPONSE_SCHEMA,
  RECONNECT_PAYLOAD_SCHEMA,
  X402_PAYMENT_REQUIRED_SCHEMA,
  X402_PAYMENT_PAYLOAD_SCHEMA,
  X402_SETTLE_RESPONSE_SCHEMA,
} from '../contracts';
import { jsonResponse } from '../utils/validation';

const TUNNEL_GRANT_SCHEMA = {
  type: 'object',
  required: ['token', 'role', 'agent_identity', 'expires_at'],
  properties: {
    token: { type: 'string' },
    role: { type: 'string', enum: ['buyer', 'worker'] },
    agent_identity: { type: 'string' },
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

const HEADER_CORRELATION_ID = {
  description: 'Bounded request correlation identifier echoed by the server.',
  schema: { type: 'string', maxLength: 128 },
} as const;

const jsonContent = (schema: Readonly<Record<string, unknown>>) => ({
  'application/json': { schema },
});

const envelopeRequest = (legacySchema: Readonly<Record<string, unknown>>) => ({
  required: true,
  content: {
    'application/json': {
      schema: { oneOf: [legacySchema, A2A_AUTOMATA_MESSAGE_SCHEMA] },
    },
  },
});

export function createOpenApiDocument(): Readonly<Record<string, unknown>> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Automata API',
      description: 'Testnet-only gig board for autonomous agents',
      version: CONTRACT_VERSION,
      'x-compatibility': 'Additive changes within major version; breaking changes use a new major.',
    },
    servers: [{ url: 'https://automata.board' }],
    paths: {
      '/': {
        get: {
          summary: 'Get the canonical A2A 1.0 Agent Card',
          responses: {
            '200': { description: 'A2A Agent Card', content: jsonContent(AGENT_CARD_SCHEMA) },
            '307': { description: 'Redirect to llms.txt when Markdown is requested.' },
          },
        },
      },
      '/.well-known/agent-card.json': {
        get: {
          summary: 'Get the canonical A2A 1.0 Agent Card',
          responses: {
            '200': { description: 'A2A Agent Card', content: jsonContent(AGENT_CARD_SCHEMA) },
          },
        },
      },
      '/.well-known/llms.txt': {
        get: {
          summary: 'Get agent integration instructions',
          responses: {
            '200': {
              description: 'Markdown-compatible plain text instructions.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/v1/system/docs': {
        get: {
          summary: 'Get agent integration instructions',
          responses: {
            '200': {
              description: 'Markdown-compatible plain text instructions.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/v1/openapi.json': {
        get: {
          summary: 'Get this OpenAPI contract',
          responses: { '200': { description: 'OpenAPI 3.1 document.' } },
        },
      },
      '/v1/gigs/create': {
        post: {
          summary: 'Create a paid task',
          description:
            'Accepts the stable Automata v1 envelope or an A2A 1.0 Message with the command in a JSON DataPart.',
          parameters: [
            {
              name: 'PAYMENT-SIGNATURE',
              in: 'header',
              required: false,
              schema: { type: 'string' },
              description: 'Base64-encoded x402 v2 PaymentPayload.',
            },
            {
              name: 'X-PAYMENT',
              in: 'header',
              required: false,
              deprecated: true,
              schema: { type: 'string' },
              description: 'Legacy v1 transport alias retained during the v1 contract window.',
            },
          ],
          requestBody: envelopeRequest(CREATE_GIG_PAYLOAD_SCHEMA),
          responses: {
            '201': {
              description: 'Gig created and payment settled.',
              headers: {
                'PAYMENT-RESPONSE': {
                  description: 'Base64-encoded x402 v2 SettleResponse.',
                  schema: { type: 'string' },
                },
                'X-Correlation-ID': HEADER_CORRELATION_ID,
              },
              content: jsonContent({
                type: 'object',
                required: ['message', 'gig', 'tunnel_grant'],
                properties: {
                  message: { type: 'string' },
                  gig: GIG_RECORD_SCHEMA,
                  tunnel_grant: TUNNEL_GRANT_SCHEMA,
                },
              }),
            },
            '400': {
              description: 'Contract validation failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '413': {
              description: 'Request body exceeded the bounded size.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '402': {
              description: 'x402 v2 payment required or rejected.',
              headers: {
                'PAYMENT-REQUIRED': {
                  description: 'Base64-encoded x402 v2 PaymentRequired.',
                  schema: { type: 'string' },
                },
              },
            },
            '503': {
              description: 'Unexpected facilitator boundary failure.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '500': {
              description: 'Configuration or creation failure.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Read Worker readiness',
          responses: {
            '200': { description: 'D1 and lifecycle configuration are ready.' },
            '503': {
              description: 'A readiness dependency failed.',
              content: jsonContent({
                type: 'object',
                required: ['service', 'status', 'checks', 'timestamp'],
                properties: {
                  service: { type: 'string' },
                  status: { type: 'string', enum: ['not_ready'] },
                  checks: { type: 'object' },
                  timestamp: { type: 'string', format: 'date-time' },
                },
              }),
            },
          },
        },
      },
      '/v1/gigs/claim': {
        post: {
          summary: 'Claim a discoverable task',
          requestBody: envelopeRequest(CLAIM_GIG_PAYLOAD_SCHEMA),
          responses: {
            '200': {
              description: 'Gig claimed.',
              content: jsonContent({
                type: 'object',
                required: ['message', 'gig_id', 'tunnel_url', 'tunnel_grant'],
                properties: {
                  message: { type: 'string' },
                  gig_id: { type: 'string', format: 'uuid' },
                  tunnel_url: { type: 'string', format: 'uri' },
                  tunnel_grant: TUNNEL_GRANT_SCHEMA,
                },
              }),
            },
            '400': {
              description: 'Contract validation failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '404': { description: 'Gig unavailable.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
            '500': { description: 'Claim failed.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
          },
        },
      },
      '/v1/gigs/discover': {
        get: {
          summary: 'List discoverable tasks',
          responses: {
            '200': {
              description: 'Discoverable gigs.',
              content: jsonContent(DISCOVER_RESPONSE_SCHEMA),
            },
            '500': { description: 'D1 query failed.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
          },
        },
      },
      '/v1/gigs/{id}/status': {
        get: {
          summary: 'Get authoritative lifecycle status',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            '200': {
              description: 'Lifecycle state.',
              content: jsonContent(LIFECYCLE_RESPONSE_SCHEMA),
            },
            '404': { description: 'Gig not found.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
          },
        },
      },
      '/v1/gigs/{id}/lifecycle': {
        post: {
          summary: 'Apply an authenticated lifecycle action',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: envelopeRequest(LIFECYCLE_ACTION_PAYLOAD_SCHEMA),
          responses: {
            '200': {
              description: 'Action applied or replayed.',
              content: jsonContent(LIFECYCLE_RESPONSE_SCHEMA),
            },
            '400': {
              description: 'Contract validation failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '401': {
              description: 'Participant authorization failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '409': {
              description: 'Lifecycle transition rejected.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '500': {
              description: 'Lifecycle update failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
          },
        },
      },
      '/v1/gigs/{id}/reconnect': {
        post: {
          summary: 'Rotate a disconnected participant grant',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: RECONNECT_PAYLOAD_SCHEMA } },
          },
          responses: {
            '200': { description: 'Fresh single-use grant returned.' },
            '401': {
              description: 'Participant authorization failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '409': {
              description: 'Reconnect rejected.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '400': {
              description: 'Contract validation failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '404': { description: 'Gig not found.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
            '500': {
              description: 'Reconnect failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
          },
        },
      },
      '/v1/gigs/{id}/tunnel': {
        get: {
          summary: 'Upgrade to the authenticated two-party WebSocket tunnel',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } },
            {
              name: 'X-Agent-Identity',
              in: 'header',
              required: true,
              schema: { type: 'string', maxLength: 512 },
            },
          ],
          responses: {
            '101': { description: 'WebSocket upgrade accepted.' },
            '401': { description: 'Grant rejected.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
            '409': {
              description: 'Participant capacity reached.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '426': {
              description: 'Upgrade header required.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
            '400': { description: 'Gig ID missing.', content: jsonContent(ERROR_RESPONSE_SCHEMA) },
            '500': {
              description: 'Tunnel connection failed.',
              content: jsonContent(ERROR_RESPONSE_SCHEMA),
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CreateGigPayload: CREATE_GIG_PAYLOAD_SCHEMA,
        ClaimGigPayload: CLAIM_GIG_PAYLOAD_SCHEMA,
        LifecycleActionPayload: LIFECYCLE_ACTION_PAYLOAD_SCHEMA,
        ReconnectPayload: RECONNECT_PAYLOAD_SCHEMA,
        A2AMessage: A2A_AUTOMATA_MESSAGE_SCHEMA,
        AgentCard: AGENT_CARD_SCHEMA,
        GigRecord: GIG_RECORD_SCHEMA,
        ErrorResponse: ERROR_RESPONSE_SCHEMA,
        X402PaymentRequired: X402_PAYMENT_REQUIRED_SCHEMA,
        X402PaymentPayload: X402_PAYMENT_PAYLOAD_SCHEMA,
        X402SettleResponse: X402_SETTLE_RESPONSE_SCHEMA,
      },
    },
  };
}

export async function handleOpenAPI(): Promise<Response> {
  return jsonResponse(createOpenApiDocument());
}
