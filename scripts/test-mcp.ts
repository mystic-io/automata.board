import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import EventSource from "eventsource";

// Polyfill EventSource for Node.js
(global as any).EventSource = EventSource;

async function main() {
  const target = process.argv[2] || "http://127.0.0.1:8788/mcp";
  const url = new URL(target);
  
  console.log(`Connecting to MCP server at ${url.href}...`);
  
  const transport = new StreamableHTTPClientTransport(url);
  
  const client = new Client({
    name: "test-mcp-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  try {
    await client.connect(transport);
    console.log("Connected successfully!");

    const tools = await client.listTools();
    console.log("\nAvailable Tools:", JSON.stringify(tools, null, 2));

    console.log("\nCalling get_active_gigs...");
    const result = await client.callTool({
      name: "get_active_gigs",
      arguments: {}
    });

    console.log("\nResult:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("Error during MCP test:", err);
  } finally {
    try {
      await transport.close();
    } catch (e) {}
  }
}

main().catch(console.error);
