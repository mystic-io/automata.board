import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { toClientEvmSigner } from '@x402/evm';
import { createWalletClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { PAYMENT_NETWORK } from '../src/config';
import WebSocket from 'ws';
import { config } from 'dotenv';

// Load environment variables from .dev.vars
config({ path: '.dev.vars' });

const API_URL = process.env.API_URL || 'http://127.0.0.1:8787';
const MNEMONIC = process.env.WALLET_MNEMONIC;

interface TunnelGrant {
  token: string;
  agent_identity: string;
  expires_at: string;
}

interface CreateGigResponse {
  gig: { gig_id: string };
  tunnel_grant: TunnelGrant;
}

if (!MNEMONIC) {
  throw new Error('Missing WALLET_MNEMONIC in .dev.vars');
}

// 1. Initialize Viem Wallet on Base Sepolia
const account = mnemonicToAccount(MNEMONIC);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http('https://sepolia.base.org'),
});

// 2. Initialize x402 Client with EVM Scheme
const client = new x402Client();
registerExactEvmScheme(client, { signer: toClientEvmSigner(account), networks: [PAYMENT_NETWORK] });
const httpClient = new x402HTTPClient(client);

async function main() {
  console.log('🚀 Starting Buyer Agent Simulation...');
  console.log(`👤 Buyer Account: ${account.address}`);

  // 3. Construct A2A Message Envelope for Gig Creation
  const createPayload = {
    message_id: crypto.randomUUID(),
    sender: account.address,
    type: 'TaskDelegation',
    payload: {
      title: 'Analyze Market Data',
      description: 'Extract and summarize key trends from provided CSV data.',
      task_type: 'data_extraction',
      task_params: {
        target_url: 'https://example.com/data.csv',
        focus: 'Q3 revenue',
      },
      bounty_sats: 50,
      ttl_minutes: 60,
    },
  };

  console.log('\\n📦 Posting task to Automata network (expecting x402 paywall)...');

  // 4. POST the task. Handle the 402 Payment Required manually.
  let response = await fetch(`${API_URL}/v1/gigs/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createPayload),
  });

  if (response.status === 402) {
    console.log('💰 402 Payment Required! Solving EVM challenge...');

    const paymentRequired = httpClient.getPaymentRequiredResponse((h) => response.headers.get(h));

    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

    // Wait for the transaction to be mined on Base (2s block time, wait 4s)
    console.log('⏳ Waiting 4 seconds for transaction to be mined...');
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    console.log('🚀 Resubmitting task with EVM payment signature...');
    response = await fetch(`${API_URL}/v1/gigs/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...paymentHeaders,
      },
      body: JSON.stringify(createPayload),
    });
  }

  if (!response.ok) {
    const err = await response.text();
    console.error(`Error details: ${err}`);
    throw new Error(`Failed to create gig: ${response.status} ${err}`);
  }

  const data = (await response.json()) as CreateGigResponse;
  const gigId = data.gig.gig_id;
  console.log('✅ Task posted successfully!');
  console.log('🆔 Gig ID:', gigId);

  // 5. Connect to the real-time tunnel
  // The worker receives the tunnel_url in the claim response, which is wss://<host>/v1/gigs/<id>/tunnel
  // We'll construct it directly for the buyer.
  const wsUrl = API_URL.replace('http://', 'ws://').replace('https://', 'wss://');
  const tunnelUrl = `${wsUrl}/v1/gigs/${gigId}/tunnel`;
  console.log(`\\n🔌 Connecting to real-time tunnel: ${tunnelUrl}`);

  const connect = () => {
    const ws = new WebSocket(tunnelUrl, {
      headers: {
        Authorization: `Bearer ${data.tunnel_grant.token}`,
        'X-Agent-Identity': data.tunnel_grant.agent_identity,
      },
    });

    ws.on('open', () => {
      console.log('✅ Connected to authenticated tunnel. Waiting for worker messages...');

      // Start keepalive heartbeat
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);

      ws.on('close', () => clearInterval(pingInterval));

      // Identify as buyer
      ws.send(
        JSON.stringify({
          message_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sender: account.address,
          type: 'identify',
          payload: { role: 'buyer' },
        })
      );
    });

    ws.on('message', async (msg) => {
      const message = JSON.parse(msg.toString());

      // Silently ignore pong responses to our pings
      if (message.type === 'pong') return;

      console.log(`\\n📥 Received message from ${message.sender || 'Unknown'}:`);
      console.log(JSON.stringify(message, null, 2));

      // Simple orchestration logic
      if (message.type === 'identify' && message.payload.role === 'worker') {
        console.log('🤝 Worker joined! Sending instructions...');
        ws.send(
          JSON.stringify({
            message_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            sender: account.address,
            type: 'instruction',
            payload: {
              action: 'start_extraction',
              dataset_id: 'ds_12345',
            },
          })
        );
      } else if (message.type === 'task_completed') {
        console.log('🎉 Worker completed the task!');
        console.log('Results:', message.payload.results);
        const acceptance = await fetch(`${API_URL}/v1/gigs/${gigId}/lifecycle`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${data.tunnel_grant.token}`,
          },
          body: JSON.stringify({
            message_id: crypto.randomUUID(),
            sender: account.address,
            type: 'TaskAcceptance',
            payload: { gig_id: gigId },
          }),
        });
        if (!acceptance.ok) throw new Error(`Failed to accept delivery: ${acceptance.status}`);
        console.log('Closing connection.');
        ws.close();
        process.exit(0);
      }
    });

    ws.on('unexpected-response', (_request, upgradeResponse) => {
      upgradeResponse.resume();
      if (
        (upgradeResponse.statusCode === 401 || upgradeResponse.statusCode === 404) &&
        Date.now() < Date.parse(data.tunnel_grant.expires_at)
      ) {
        console.log('⏳ Tunnel is waiting for a worker claim; retrying in 1 second...');
        setTimeout(connect, 1000);
        return;
      }
      console.error(`❌ Tunnel upgrade rejected with status ${upgradeResponse.statusCode}`);
    });

    ws.on('error', (err) => {
      console.error('❌ WebSocket error:', err);
    });

    ws.on('close', () => {
      console.log('🔌 Tunnel connection closed.');
    });
  };

  connect();
}

main().catch(console.error);
