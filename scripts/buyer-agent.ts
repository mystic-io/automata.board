import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import WebSocket from "ws";
import { config } from "dotenv";

// Load environment variables from .dev.vars
config({ path: ".dev.vars" });

const API_URL = process.env.API_URL || "http://127.0.0.1:8787";
const MNEMONIC = process.env.TESTNET_MNEMONIC;

if (!MNEMONIC) {
  throw new Error("Missing TESTNET_MNEMONIC in .dev.vars");
}

// 1. Initialize Viem Wallet on Base Sepolia
const account = mnemonicToAccount(MNEMONIC);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

// 2. Initialize x402 Client with EVM Scheme
const client = new x402Client();
registerExactEvmScheme(client, { signer: account, networks: ["eip155:84532"] });
const httpClient = new x402HTTPClient(client);

async function main() {
  console.log("🚀 Starting Buyer Agent Simulation...");
  console.log(`👤 Buyer Account: ${account.address}`);

  // 3. Construct A2A Message Envelope for Gig Creation
  const createPayload = {
    message_id: crypto.randomUUID(),
    sender: account.address,
    type: "TaskDelegation",
    payload: {
      title: "Analyze Market Data",
      description: "Extract and summarize key trends from provided CSV data.",
      task_type: "data_extraction",
      task_params: {
        target_url: "https://example.com/data.csv",
        focus: "Q3 revenue",
      },
      bounty_sats: 50,
      ttl_minutes: 60,
    },
  };

  console.log("\\n📦 Posting task to Vivia network (expecting x402 paywall)...");
  
  // 4. POST the task. Handle the 402 Payment Required manually.
  let response = await fetch(`${API_URL}/v1/gigs/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createPayload),
  });

  if (response.status === 402) {
    console.log("💰 402 Payment Required! Solving EVM challenge...");
    console.log("Response headers:");
    response.headers.forEach((val, key) => console.log(`${key}: ${val}`));

    const paymentRequired = httpClient.getPaymentRequiredResponse(h => response.headers.get(h));
    console.log("Parsed Payment Required:", JSON.stringify(paymentRequired, null, 2));

    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    console.log("🚀 Resubmitting task with EVM payment signature...");
    response = await fetch(`${API_URL}/v1/gigs/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...paymentHeaders,
      },
      body: JSON.stringify(createPayload),
    });
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Failed to create gig: ${response.status} ${err}`);
  }

  const data = await response.json();
  const gigId = data.gig.gig_id;
  console.log("✅ Task posted successfully!");
  console.log("🆔 Gig ID:", gigId);

  // 5. Connect to the real-time tunnel
  // The worker receives the tunnel_url in the claim response, which is wss://<host>/v1/gigs/<id>/tunnel
  // We'll construct it directly for the buyer.
  const wsUrl = API_URL.replace("http://", "ws://").replace("https://", "wss://");
  const tunnelUrl = `${wsUrl}/v1/gigs/${gigId}/tunnel`;
  console.log(`\\n🔌 Connecting to real-time tunnel: ${tunnelUrl}`);

  const ws = new WebSocket(tunnelUrl);

  ws.on("open", () => {
    console.log("✅ Connected to tunnel. Waiting for worker to join...");
    
    // Start keepalive heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);

    ws.on("close", () => clearInterval(pingInterval));
    
    // Identify as buyer
    ws.send(JSON.stringify({
      message_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sender: account.address,
      type: "identify",
      payload: { role: "buyer" }
    }));
  });

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    
    // Silently ignore pong responses to our pings
    if (data.type === "pong") return;
    
    console.log(`\\n📥 Received message from ${data.sender || 'Unknown'}:`);
    console.log(JSON.stringify(data, null, 2));

    // Simple orchestration logic
    if (data.type === "identify" && data.payload.role === "worker") {
      console.log("🤝 Worker joined! Sending instructions...");
      ws.send(JSON.stringify({
        message_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sender: account.address,
        type: "instruction",
        payload: {
          action: "start_extraction",
          dataset_id: "ds_12345"
        }
      }));
    } else if (data.type === "task_completed") {
      console.log("🎉 Worker completed the task!");
      console.log("Results:", data.payload.results);
      console.log("Closing connection.");
      ws.close();
      process.exit(0);
    }
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err);
  });

  ws.on("close", () => {
    console.log("🔌 Tunnel connection closed.");
  });
}

main().catch(console.error);
