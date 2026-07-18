/**
 * Public protocol contracts.
 *
 * These JSON Schema objects are the executable source of truth used by request
 * validation, OpenAPI generation, MCP registration, and workerd conformance
 * tests. Keep compatibility changes additive within a major contract version.
 */

export const CONTRACT_VERSION = '1.0.0' as const;
export const A2A_PROTOCOL_VERSION = '1.0' as const;
export const X402_PROTOCOL_VERSION = 2 as const;
export const MCP_SERVER_VERSION = '1.0.0' as const;

export const TASK_TYPES = [
  'web_scrape',
  'data_extraction',
  'computation',
  'api_relay',
  'custom',
] as const;

const NON_EMPTY_STRING = { type: 'string', minLength: 1 } as const;
const AGENT_IDENTITY = { type: 'string', minLength: 1, maxLength: 512 } as const;
const UUID_PATTERN =
  '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
const GIG_ID = { type: 'string', format: 'uuid', pattern: UUID_PATTERN } as const;

export const CREATE_GIG_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['message_id', 'sender', 'type', 'payload'],
  properties: {
    message_id: NON_EMPTY_STRING,
    sender: AGENT_IDENTITY,
    type: { type: 'string', enum: ['TaskDelegation'] },
    payload: {
      type: 'object',
      required: ['title', 'description', 'task_type', 'task_params', 'bounty_sats', 'ttl_minutes'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 80 },
        description: { type: 'string', minLength: 1, maxLength: 500 },
        task_type: { type: 'string', enum: TASK_TYPES },
        task_params: { type: 'object' },
        bounty_sats: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: 120 },
      },
    },
  },
} as const;

export const CLAIM_GIG_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['message_id', 'sender', 'type', 'payload'],
  properties: {
    message_id: NON_EMPTY_STRING,
    sender: AGENT_IDENTITY,
    type: { type: 'string', enum: ['TaskClaim'] },
    payload: {
      type: 'object',
      required: ['gig_id'],
      properties: { gig_id: GIG_ID },
    },
  },
} as const;

export const LIFECYCLE_ACTION_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['message_id', 'sender', 'type', 'payload'],
  properties: {
    message_id: NON_EMPTY_STRING,
    sender: AGENT_IDENTITY,
    type: {
      type: 'string',
      enum: ['TaskDelivery', 'TaskAcceptance', 'TaskCancellation', 'TaskAbandonment'],
    },
    payload: {
      type: 'object',
      required: ['gig_id'],
      properties: {
        gig_id: GIG_ID,
        reason: { type: 'string', maxLength: 500 },
      },
    },
  },
} as const;

export const RECONNECT_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['message_id', 'sender', 'role'],
  properties: {
    message_id: NON_EMPTY_STRING,
    sender: AGENT_IDENTITY,
    role: { type: 'string', enum: ['buyer', 'worker'] },
  },
} as const;

/** A2A 1.0 Message carrying an Automata command in one DataPart. */
export const A2A_AUTOMATA_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messageId', 'role', 'parts'],
  properties: {
    messageId: NON_EMPTY_STRING,
    contextId: NON_EMPTY_STRING,
    taskId: GIG_ID,
    role: { type: 'string', enum: ['ROLE_USER'] },
    parts: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'mediaType'],
        properties: {
          data: { type: 'object' },
          mediaType: { type: 'string', enum: ['application/json'] },
        },
      },
    },
    metadata: { type: 'object' },
    extensions: { type: 'array', items: { type: 'string' } },
    referenceTaskIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'boolean', enum: [true] },
    message: { type: 'string' },
    details: {},
  },
} as const;

export const GIG_RECORD_SCHEMA = {
  type: 'object',
  required: [
    'gig_id',
    'buyer_pubkey',
    'title',
    'description',
    'task_type',
    'payload_json',
    'bounty_sats',
    'status',
    'lifecycle_state',
    'lifecycle_version',
    'created_at',
    'updated_at',
    'expires_at',
  ],
  properties: {
    gig_id: GIG_ID,
    buyer_pubkey: AGENT_IDENTITY,
    worker_pubkey: { type: ['string', 'null'], maxLength: 512 },
    title: { type: 'string' },
    description: { type: 'string' },
    task_type: { type: 'string', enum: TASK_TYPES },
    payload_json: { type: 'string' },
    bounty_sats: { type: 'integer' },
    status: {
      type: 'string',
      enum: ['PENDING_PAYMENT', 'ACTIVE', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED'],
    },
    lifecycle_state: {
      type: 'string',
      enum: [
        'POSTED',
        'DISCOVERABLE',
        'CLAIMED',
        'TUNNEL_GRANTED',
        'IN_PROGRESS',
        'DELIVERED',
        'COMPLETED',
        'CLOSED',
        'CANCELLED',
        'EXPIRED',
        'FAILED',
      ],
    },
    lifecycle_version: { type: 'integer', minimum: 0 },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const DISCOVER_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['count', 'gigs'],
  properties: {
    count: { type: 'integer', minimum: 0 },
    gigs: { type: 'array', items: GIG_RECORD_SCHEMA },
  },
} as const;

export const LIFECYCLE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['message', 'gig_id', 'lifecycle_state', 'lifecycle_version', 'duplicate'],
  properties: {
    message: { type: 'string' },
    gig_id: GIG_ID,
    lifecycle_state: GIG_RECORD_SCHEMA.properties.lifecycle_state,
    lifecycle_version: { type: 'integer', minimum: 0 },
    duplicate: { type: 'boolean' },
    accepted: { type: 'boolean' },
    rejection_reason: { type: 'string' },
  },
} as const;

export const AGENT_CARD_SCHEMA = {
  type: 'object',
  required: [
    'name',
    'description',
    'supportedInterfaces',
    'version',
    'capabilities',
    'defaultInputModes',
    'defaultOutputModes',
    'skills',
  ],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    supportedInterfaces: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['url', 'protocolBinding', 'protocolVersion'],
        properties: {
          url: { type: 'string', format: 'uri' },
          protocolBinding: { type: 'string', enum: ['HTTP+JSON'] },
          protocolVersion: { type: 'string', enum: [A2A_PROTOCOL_VERSION] },
        },
      },
    },
    version: { type: 'string' },
    documentationUrl: { type: 'string', format: 'uri' },
    capabilities: { type: 'object' },
    defaultInputModes: { type: 'array', items: { type: 'string' } },
    defaultOutputModes: { type: 'array', items: { type: 'string' } },
    skills: { type: 'array', items: { type: 'object' } },
  },
} as const;

export const X402_PAYMENT_REQUIRED_SCHEMA = {
  type: 'object',
  required: ['x402Version', 'resource', 'accepts'],
  properties: {
    x402Version: { type: 'integer', enum: [X402_PROTOCOL_VERSION] },
    error: { type: 'string' },
    resource: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
        description: { type: 'string' },
        mimeType: { type: 'string' },
      },
    },
    accepts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds'],
        properties: {
          scheme: { type: 'string' },
          network: { type: 'string' },
          amount: { type: 'string' },
          asset: { type: 'string' },
          payTo: { type: 'string' },
          maxTimeoutSeconds: { type: 'integer', minimum: 1 },
          extra: { type: 'object' },
        },
      },
    },
    extensions: { type: 'object' },
  },
} as const;

export const X402_SETTLE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['success', 'transaction', 'network'],
  properties: {
    success: { type: 'boolean' },
    errorReason: { type: 'string' },
    errorMessage: { type: 'string' },
    payer: { type: 'string' },
    transaction: { type: 'string' },
    network: { type: 'string' },
    amount: { type: 'string' },
    extensions: { type: 'object' },
  },
} as const;

export const X402_PAYMENT_PAYLOAD_SCHEMA = {
  type: 'object',
  required: ['x402Version', 'accepted', 'payload'],
  properties: {
    x402Version: { type: 'integer', enum: [X402_PROTOCOL_VERSION] },
    resource: X402_PAYMENT_REQUIRED_SCHEMA.properties.resource,
    accepted: X402_PAYMENT_REQUIRED_SCHEMA.properties.accepts.items,
    payload: {
      type: 'object',
      required: ['signature', 'authorization'],
      properties: {
        signature: { type: 'string', pattern: '^0x[0-9a-fA-F]{130}$' },
        authorization: {
          type: 'object',
          required: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'],
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            value: { type: 'string' },
            validAfter: { type: 'string' },
            validBefore: { type: 'string' },
            nonce: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
          },
        },
      },
    },
    extensions: { type: 'object' },
  },
} as const;

export const MCP_CONTRACT = {
  server: { name: 'automata-mcp', version: MCP_SERVER_VERSION },
  tools: {
    get_active_gigs: {
      description: 'Get the currently discoverable Automata gigs.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
    get_gig_status: {
      description: 'Get the authoritative lifecycle state for one Automata gig.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['gig_id'],
        properties: { gig_id: GIG_ID },
      },
    },
  },
  resources: {
    openapi: {
      name: 'automata-openapi',
      uri: 'automata://contracts/openapi',
      description: 'Automata OpenAPI 3.1 contract',
      mimeType: 'application/json',
    },
    manifest: {
      name: 'automata-contract-manifest',
      uri: 'automata://contracts/manifest',
      description: 'Pinned Automata protocol compatibility manifest',
      mimeType: 'application/json',
    },
  },
} as const;

export const CONTRACT_MANIFEST = {
  contractVersion: CONTRACT_VERSION,
  compatibility: 'additive-within-major',
  openapi: '3.1.0',
  a2a: A2A_PROTOCOL_VERSION,
  mcp: MCP_SERVER_VERSION,
  x402: X402_PROTOCOL_VERSION,
  legacyXPaymentHeader: true,
} as const;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ContractViolation {
  path: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal JSON Schema 2020-12 evaluator for the contract keywords used here. */
export function validateContract(
  schema: JsonSchema,
  value: unknown,
  path = '$'
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const expectedType = schema.type;
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  const typeMatches =
    expectedType === undefined ||
    (expectedTypes.includes('null') && value === null) ||
    (expectedTypes.includes('object') && isObject(value)) ||
    (expectedTypes.includes('array') && Array.isArray(value)) ||
    (expectedTypes.includes('string') && typeof value === 'string') ||
    (expectedTypes.includes('boolean') && typeof value === 'boolean') ||
    (expectedTypes.includes('number') && typeof value === 'number' && Number.isFinite(value)) ||
    (expectedTypes.includes('integer') && typeof value === 'number' && Number.isInteger(value));
  if (!typeMatches) return [{ path, message: `must be ${String(expectedType)}` }];

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    violations.push({ path, message: 'must match an allowed value' });
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      violations.push({ path, message: `must contain at least ${schema.minLength} characters` });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      violations.push({ path, message: `must contain at most ${schema.maxLength} characters` });
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      violations.push({ path, message: 'must match the required pattern' });
    if (
      schema.format === 'uuid' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    )
      violations.push({ path, message: 'must be a UUID' });
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value)))
      violations.push({ path, message: 'must be an ISO 8601 date-time' });
    if (schema.format === 'uri') {
      try {
        new URL(value);
      } catch {
        violations.push({ path, message: 'must be an absolute URI' });
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      violations.push({ path, message: `must be at least ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      violations.push({ path, message: `must be at most ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      violations.push({ path, message: `must contain at least ${schema.minItems} items` });
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      violations.push({ path, message: `must contain at most ${schema.maxItems} items` });
    if (isObject(schema.items)) {
      value.forEach((item, index) => {
        violations.push(...validateContract(schema.items as JsonSchema, item, `${path}[${index}]`));
      });
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value))
        violations.push({ path: `${path}.${key}`, message: 'is required' });
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isObject(propertySchema)) {
        violations.push(...validateContract(propertySchema, item, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        violations.push({ path: `${path}.${key}`, message: 'is not allowed' });
      }
    }
  }
  return violations;
}
