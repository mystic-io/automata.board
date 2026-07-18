import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import EventSource from 'eventsource';
import WebSocket from 'ws';
import { config } from 'dotenv';
import { createWalletClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// Polyfill EventSource for Node.js
(global as any).EventSource = EventSource;

config({ path: '.dev.vars' });

const API_URL = process.env.API_URL || 'http://127.0.0.1:8787';
const MCP_URL = `${API_URL}/mcp`;
const MNEMONIC = process.env.WALLET_MNEMONIC;

interface ClaimGigResponse {
  tunnel_url: string;
  tunnel_grant: {
    token: string;
    agent_identity: string;
  };
}

if (!MNEMONIC) {
  throw new Error('Missing WALLET_MNEMONIC in .dev.vars');
}

// 1. Initialize Viem Wallet on Base Sepolia
const account = mnemonicToAccount(MNEMONIC, { accountIndex: 1 });
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http('https://sepolia.base.org'),
});

async function main() {
  console.log('🚀 Starting Worker Agent Simulation...');
  console.log(`🤖 Worker Account: ${account.address}`);

  // 2. Connect to embedded MCP server for Discovery
  console.log(`\n🔍 Connecting to MCP server at ${MCP_URL} for discovery...`);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'worker-agent', version: '1.0.0' }, { capabilities: {} });

  await client.connect(transport);
  console.log('✅ MCP Connected.');

  // 3. Fetch Active Gigs
  console.log('📡 Polling for active gigs via MCP tool `get_active_gigs`...');
  const result = await client.callTool({
    name: 'get_active_gigs',
    arguments: {},
  });

  if (result.isError) {
    throw new Error(`MCP Tool Error: ${result.content[0].text}`);
  }

  const gigs = JSON.parse(result.content[0].text as string);

  if (gigs.length === 0) {
    console.log('📭 No active gigs found on the network. Exiting.');
    process.exit(0);
  }

  const gig = gigs[0]; // Pick the first available gig
  console.log(`✅ Discovered ${gigs.length} active gig(s).`);
  console.log(`🎯 Selecting Gig ID: ${gig.gig_id} ("${gig.title}")`);

  // Close MCP connection since we found our gig
  try {
    await transport.close();
  } catch (e) {}

  // 4. Claim the Gig via REST API
  console.log(`\\n✋ Claiming gig ${gig.gig_id}...`);
  const claimPayload = {
    message_id: crypto.randomUUID(),
    sender: account.address,
    type: 'TaskClaim',
    payload: {
      gig_id: gig.gig_id,
    },
  };

  const claimRes = await fetch(`${API_URL}/v1/gigs/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(claimPayload),
  });

  if (!claimRes.ok) {
    const err = await claimRes.text();
    throw new Error(`Failed to claim gig: ${claimRes.status} ${err}`);
  }

  const claimData = (await claimRes.json()) as ClaimGigResponse;
  const tunnelUrl = claimData.tunnel_url;
  console.log('✅ Gig claimed successfully!');

  // 5. Connect to the Real-Time Tunnel
  console.log(`\\n🔌 Connecting to real-time tunnel: ${tunnelUrl}`);
  const ws = new WebSocket(tunnelUrl, {
    headers: {
      Authorization: `Bearer ${claimData.tunnel_grant.token}`,
      'X-Agent-Identity': claimData.tunnel_grant.agent_identity,
    },
  });

  ws.on('open', () => {
    console.log('✅ Connected to tunnel.');

    // Start keepalive heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));

    // Identify as worker
    ws.send(
      JSON.stringify({
        message_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sender: account.address,
        type: 'identify',
        payload: { role: 'worker' },
      })
    );
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    // Silently ignore pong responses to our pings
    if (data.type === 'pong') return;

    console.log(`\\n📥 Received message from ${data.sender || 'Unknown'}:`);
    console.log(JSON.stringify(data, null, 2));

    // Simple execution logic
    if (data.type === 'instruction' && data.payload.action === 'start_extraction') {
      console.log('⚙️  Executing task: Extracting data (simulating quick 5-second task)...');

      let seconds = 0;
      const progressInterval = setInterval(() => {
        seconds += 1;
        console.log(`⏳ Still executing... (${seconds} seconds elapsed)`);
      }, 1000);

      setTimeout(async () => {
        clearInterval(progressInterval);
        console.log('✅ Task execution complete! Sending results back to buyer...');

        ws.send(
          JSON.stringify({
            message_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sender: account.address,
            type: 'task_completed',
            payload: {
              status: 'success',
              results: {
                revenue_q3: '$4.2M',
                growth: '+15%',
              },
            },
          })
        );
        const delivery = await fetch(`${API_URL}/v1/gigs/${gig.gig_id}/lifecycle`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${claimData.tunnel_grant.token}`,
          },
          body: JSON.stringify({
            message_id: crypto.randomUUID(),
            sender: account.address,
            type: 'TaskDelivery',
            payload: { gig_id: gig.gig_id },
          }),
        });
        if (!delivery.ok) throw new Error(`Failed to record delivery: ${delivery.status}`);
      }, 5000); // Simulate 5 seconds of work
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err);
  });

  ws.on('close', () => {
    console.log('🔌 Tunnel connection closed.');
    process.exit(0);
  });
}

main().catch(console.error);
