import { env, exports as workerExports } from 'cloudflare:workers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { seedGig } from './helpers';

describe('MCP discovery surface in workerd', () => {
  it('negotiates Streamable HTTP and returns active gigs through the advertised tool', async () => {
    const gigId = await seedGig(env.DB);
    const transport = new StreamableHTTPClientTransport(new URL('http://automata.test/mcp'), {
      fetch: (input, init) => workerExports.default.fetch(input, init),
    });
    const client = new Client({ name: 'automata-runtime-tests', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain('get_active_gigs');

      const result = await client.callTool({ name: 'get_active_gigs', arguments: {} });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((item) => item.type === 'text')?.text;
      expect(text).toBeTruthy();
      expect(JSON.parse(text ?? '[]')).toEqual(
        expect.arrayContaining([expect.objectContaining({ gig_id: gigId, status: 'ACTIVE' })])
      );
    } finally {
      await client.close();
    }
  });
});
