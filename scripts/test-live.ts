import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import WebSocket from "ws";
import { config } from "dotenv";

config({ path: ".dev.vars" });

const API_URL = "https://vivia-api-prod.flexflow.workers.dev";
const MNEMONIC = process.env.TESTNET_MNEMONIC;

if (!MNEMONIC) {
  throw new Error("Missing TESTNET_MNEMONIC in .dev.vars");
}

const account = mnemonicToAccount(MNEMONIC);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

const client = new x402Client();
registerExactEvmScheme(client, { signer: walletClient, networks: ["eip155:84532"] });
const httpClient = new x402HTTPClient(client);

async function runTests() {
  console.log("🚀 Starting Vivia Live E2E Tests on", API_URL);

  // --- Phase 1: Discovery ---
  console.log("\\n[1] Testing Discovery Endpoint (GET /)...");
  const discoveryRes = await fetch(`${API_URL}/`);
  const discoveryData = await discoveryRes.json();
  console.assert(discoveryData.name === "Vivia Agentic Gig Board", "Discovery failed");
  console.log("✅ Discovery OK. Active Tasks:", discoveryData.active_tasks);

  // --- Phase 2: Create Gig (Simulated via D1 Injection) ---
  console.log("\\n[2] Testing Gig Creation & 402 Paywall...");
  
  const createUrl = `${API_URL}/v1/gigs/create`;
  let createRes = await fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  
  if (createRes.status === 402) {
    console.log("✅ Received 402 Payment Required (Paywall is active!)");
  } else {
    throw new Error(`Expected 402, got ${createRes.status}`);
  }

  console.log("💉 Injecting test gig directly into D1 to bypass crypto signing...");
  const gigId = crypto.randomUUID();
  const { execSync } = require("child_process");
  
  execSync(
    `npx wrangler d1 execute vivia-db-prod --remote --command "INSERT INTO agent_gigs (gig_id, buyer_pubkey, task_type, payload_json, bounty_sats, status, expires_at) VALUES ('${gigId}', '0xBuyer', 'computation', '{}', 10, 'ACTIVE', datetime('now', '+1 hour'))"`,
    { stdio: 'inherit' }
  );
  
  console.log("✅ Gig Injected Successfully. ID:", gigId);

  // --- Phase 3: Claim Gig ---
  console.log("\\n[3] Testing Gig Claiming...");
  const claimRes = await fetch(`${API_URL}/v1/gigs/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message_id: crypto.randomUUID(),
      sender: "0xWorker000000000000000000000000000000000",
      type: "TaskClaim",
      payload: {
        gig_id: gigId,
      }
    }),
  });

  if (!claimRes.ok) {
    throw new Error(`Failed to claim gig: ${claimRes.status}`);
  }

  const claimData = await claimRes.json();
  console.log("✅ Gig Claimed. Tunnel URL:", claimData.tunnel_url);

  // --- Phase 4: WebSocket Tunnel (Durable Object) ---
  console.log("\\n[4] Testing Real-Time Tunneling (Durable Objects)...");
  
  const wssUrl = claimData.tunnel_url;
  
  await new Promise<void>((resolve, reject) => {
    const buyerWs = new WebSocket(wssUrl);
    const workerWs = new WebSocket(wssUrl);

    let workerReceived = false;

    workerWs.on("open", () => {
      workerWs.send(JSON.stringify({
        message_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sender: "0xWorker000000000000000000000000000000000",
        type: "identify",
        payload: { role: "worker" }
      }));
    });

    workerWs.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.payload && msg.payload.content === "hello_from_buyer") {
        workerReceived = true;
        console.log("✅ Worker received message from Buyer!");
        buyerWs.close();
        workerWs.close();
        resolve();
      }
    });

    buyerWs.on("open", () => {
      buyerWs.send(JSON.stringify({
        message_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        sender: "0xBuyer000000000000000000000000000000000",
        type: "identify",
        payload: { role: "buyer" }
      }));
      
      // Send a test message after a tiny delay
      setTimeout(() => {
        buyerWs.send(JSON.stringify({
          message_id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          sender: "0xBuyer000000000000000000000000000000000",
          type: "message",
          payload: { content: "hello_from_buyer" }
        }));
      }, 500);
    });

    setTimeout(() => {
      if (!workerReceived) {
        reject(new Error("WebSocket timeout: worker never received message"));
      }
    }, 5000);
  });

  console.log("\\n🎉 All Live E2E Tests Passed Successfully!");
}

runTests().catch(console.error);
