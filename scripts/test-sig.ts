import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { config } from "dotenv";

config({ path: ".dev.vars" });
const account = mnemonicToAccount(process.env.WALLET_MNEMONIC!);
const combinedClient = createWalletClient({
  account,
  chain: base,
  transport: http("https://base.drpc.org"),
});
const signer = toFacilitatorEvmSigner(combinedClient);

async function run() {
  const scheme = new ExactEvmScheme();
  // Provide the payload from the previous failure
  const payload = {
    authorization: {
      from: '0x383C0d96B887Ceb2A178317bFe53ad5EE1475133',
      to: '0x1111111111111111111111111111111111111111',
      value: '10000',
      validAfter: '0',
      validBefore: '1783019416',
      nonce: '0xe4deff470a9ced5bab27dec6469a4c5aedcfcdde199cb2cdcb087b1f4678b4de'
    },
    signature: '0xf364988fc792ab81a6c9eec994d5ca0ee9e84cf2993ce1d828c8a0f47575b97d7bdcb20f56fa84aab5c6aa9e444f79ae10bf77a1c6afb6c62bfd55b39bb3d4cd1c'
  };
  
  try {
    // Actually the server doesn't use the Scheme directly, it uses the facilitator module
    // The ExactEvmScheme just parses the header. The x402Facilitator executes it.
    // Let's use viem to call transferWithAuthorization directly and see what reverts!
    
    const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const v = parseInt(payload.signature.slice(-2), 16);
    const r = payload.signature.slice(0, 66);
    const s = "0x" + payload.signature.slice(66, 130);
    
    console.log("Simulating transferWithAuthorization...");
    const abi = [{
      type: "function",
      name: "transferWithAuthorization",
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "v", type: "uint8" },
        { name: "r", type: "bytes32" },
        { name: "s", type: "bytes32" },
      ],
      outputs: []
    }];
    
    // Simulate transaction
    // Note: We need publicClient to simulate
    const { createPublicClient } = require("viem");
    const pc = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com") });
    
    const result = await pc.simulateContract({
      address: usdcAddress,
      abi,
      functionName: "transferWithAuthorization",
      args: [
        payload.authorization.from,
        payload.authorization.to,
        BigInt(payload.authorization.value),
        BigInt(payload.authorization.validAfter),
        BigInt(payload.authorization.validBefore),
        payload.authorization.nonce,
        v,
        r,
        s
      ],
      account
    });
    console.log("Simulation SUCCESS!", result);
  } catch (err) {
    console.error("Simulation FAILED!", err);
  }
}
run();
