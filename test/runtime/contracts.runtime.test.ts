import { env, exports as workerExports } from 'cloudflare:workers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CARD_SCHEMA,
  CONTRACT_MANIFEST,
  MCP_CONTRACT,
  validateContract,
  X402_PAYMENT_PAYLOAD_SCHEMA,
  X402_PAYMENT_REQUIRED_SCHEMA,
  X402_SETTLE_RESPONSE_SCHEMA,
} from '../../src/contracts';
import {
  VALID_CREATE_PAYLOAD,
  encodePaymentSignature,
  getPaymentRequirements,
  postPaidGig,
  seedGig,
  workerFetch,
} from './helpers';

function expectConformant(schema: Readonly<Record<string, unknown>>, value: unknown): void {
  expect(validateContract(schema, value)).toEqual([]);
}

function schemaAt(root: unknown, path: readonly string[]): Readonly<Record<string, unknown>> {
  let current = root;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(`OpenAPI path is missing at ${segment}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error('OpenAPI schema path did not resolve to an object');
  }
  return current as Readonly<Record<string, unknown>>;
}

describe('public protocol contracts in workerd', () => {
  it('validates real REST responses against the served OpenAPI schemas', async () => {
    const openapiResponse = await workerFetch('http://automata.test/v1/openapi.json');
    expect(openapiResponse.status).toBe(200);
    const openapi = await openapiResponse.json();
    expect((openapi as Record<string, unknown>).openapi).toBe('3.1.0');

    await seedGig(env.DB);
    const discovery = await workerFetch('http://automata.test/v1/gigs/discover');
    expectConformant(
      schemaAt(openapi, [
        'paths',
        '/v1/gigs/discover',
        'get',
        'responses',
        '200',
        'content',
        'application/json',
        'schema',
      ]),
      await discovery.json()
    );

    const invalid = await workerFetch('http://automata.test/v1/gigs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(invalid.status).toBe(400);
    expectConformant(
      schemaAt(openapi, [
        'paths',
        '/v1/gigs/claim',
        'post',
        'responses',
        '400',
        'content',
        'application/json',
        'schema',
      ]),
      await invalid.json()
    );

    const created = await postPaidGig('openapi-create-response');
    expect(created.status).toBe(201);
    expectConformant(
      schemaAt(openapi, [
        'paths',
        '/v1/gigs/create',
        'post',
        'responses',
        '201',
        'content',
        'application/json',
        'schema',
      ]),
      await created.json()
    );
  });

  it('serves an A2A 1.0 Agent Card and accepts an A2A Message envelope', async () => {
    const cardResponse = await workerFetch('http://automata.test/.well-known/agent-card.json');
    expect(cardResponse.status).toBe(200);
    expectConformant(AGENT_CARD_SCHEMA, await cardResponse.json());

    const a2aMessage = {
      messageId: 'a2a-create-message',
      role: 'ROLE_USER',
      parts: [
        {
          mediaType: 'application/json',
          data: {
            sender: VALID_CREATE_PAYLOAD.sender,
            type: VALID_CREATE_PAYLOAD.type,
            payload: VALID_CREATE_PAYLOAD.payload,
          },
        },
      ],
    };
    const response = await postPaidGig('a2a-create-payment', a2aMessage);
    expect(response.status).toBe(201);
  });

  it('matches MCP tool and resource discovery to the shared registry', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://automata.test/mcp'), {
      fetch: (input, init) => workerExports.default.fetch(input, init),
    });
    const client = new Client({ name: 'contract-tests', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual(
        Object.keys(MCP_CONTRACT.tools).sort()
      );
      for (const tool of tools.tools) {
        const declared = MCP_CONTRACT.tools[tool.name as keyof typeof MCP_CONTRACT.tools];
        expect(tool.description).toBe(declared.description);
        expect(tool.inputSchema.type).toBe(declared.inputSchema.type);
        expect(tool.inputSchema.properties).toEqual(declared.inputSchema.properties);
      }

      const resources = await client.listResources();
      expect(resources.resources.map(({ uri }) => uri).sort()).toEqual(
        Object.values(MCP_CONTRACT.resources)
          .map(({ uri }) => uri)
          .sort()
      );
      const manifest = await client.readResource({ uri: MCP_CONTRACT.resources.manifest.uri });
      const firstContent = manifest.contents[0];
      const manifestText = firstContent && 'text' in firstContent ? firstContent.text : undefined;
      expect(JSON.parse(typeof manifestText === 'string' ? manifestText : '{}')).toEqual(
        CONTRACT_MANIFEST
      );
    } finally {
      await client.close();
    }
  });

  it('conforms to x402 v2 challenge, signature, and settlement headers', async () => {
    const challengeResponse = await workerFetch('http://automata.test/v1/gigs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_CREATE_PAYLOAD),
    });
    const encodedChallenge = challengeResponse.headers.get('PAYMENT-REQUIRED');
    expect(challengeResponse.status).toBe(402);
    expect(encodedChallenge).toBeTruthy();
    expectConformant(X402_PAYMENT_REQUIRED_SCHEMA, JSON.parse(atob(encodedChallenge ?? '')));

    const accepted = await getPaymentRequirements(VALID_CREATE_PAYLOAD);
    const signature = encodePaymentSignature(accepted, { nonce: 'contract-x402' });
    expectConformant(X402_PAYMENT_PAYLOAD_SCHEMA, JSON.parse(atob(signature)));
    const settled = await workerFetch('http://automata.test/v1/gigs/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': signature },
      body: JSON.stringify(VALID_CREATE_PAYLOAD),
    });
    expect(settled.status).toBe(201);
    const encodedSettlement = settled.headers.get('PAYMENT-RESPONSE');
    expect(encodedSettlement).toBeTruthy();
    expectConformant(X402_SETTLE_RESPONSE_SCHEMA, JSON.parse(atob(encodedSettlement ?? '')));
  });
});
