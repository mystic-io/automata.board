import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler } from 'agents/mcp';
import { z } from 'zod';
import type { AppContext } from '../types';
import { CONTRACT_MANIFEST, MCP_CONTRACT } from '../contracts';
import { createOpenApiDocument } from './openapi';
import { listActiveGigs } from '../services/gigs';

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { ...textResult({ error: true, message }), isError: true };
}

function mcpInputSchema(schema: Readonly<Record<string, unknown>>): z.ZodObject {
  const properties =
    typeof schema.properties === 'object' && schema.properties !== null
      ? (schema.properties as Record<string, Readonly<Record<string, unknown>>>)
      : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(properties)) {
    let field: z.ZodType =
      property.type === 'string'
        ? property.format === 'uuid'
          ? z.string().uuid()
          : z.string()
        : z.unknown();
    if (!required.has(name)) field = field.optional();
    shape[name] = field;
  }
  const object = z.object(shape);
  return schema.additionalProperties === false ? object.strict() : object;
}

export async function handleMcp(c: AppContext): Promise<Response> {
  const server = new McpServer(MCP_CONTRACT.server);

  server.registerTool(
    'get_active_gigs',
    {
      description: MCP_CONTRACT.tools.get_active_gigs.description,
      inputSchema: mcpInputSchema(MCP_CONTRACT.tools.get_active_gigs.inputSchema),
    },
    async () => {
      try {
        return textResult(await listActiveGigs(c.env));
      } catch (error) {
        console.error('MCP get_active_gigs failed:', error);
        return errorResult('Failed to fetch gigs');
      }
    }
  );

  server.registerTool(
    'get_gig_status',
    {
      description: MCP_CONTRACT.tools.get_gig_status.description,
      inputSchema: mcpInputSchema(MCP_CONTRACT.tools.get_gig_status.inputSchema),
    },
    async (input) => {
      const gigId = typeof input.gig_id === 'string' ? input.gig_id : '';
      try {
        return textResult(await c.env.TUNNEL.getByName(gigId).getLifecycle());
      } catch (error) {
        console.error('MCP get_gig_status failed:', error);
        return errorResult('Gig not found');
      }
    }
  );

  const openapi = MCP_CONTRACT.resources.openapi;
  server.registerResource(openapi.name, openapi.uri, openapi, async (uri) => ({
    contents: [
      { uri: uri.href, mimeType: openapi.mimeType, text: JSON.stringify(createOpenApiDocument()) },
    ],
  }));

  const manifest = MCP_CONTRACT.resources.manifest;
  server.registerResource(manifest.name, manifest.uri, manifest, async (uri) => ({
    contents: [
      { uri: uri.href, mimeType: manifest.mimeType, text: JSON.stringify(CONTRACT_MANIFEST) },
    ],
  }));

  const handler = createMcpHandler(server, { route: '/mcp' });
  return handler(c.req.raw, c.env, c.executionCtx as ExecutionContext);
}
