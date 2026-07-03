import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
async function run() {
  const address = "0x383C0d96B887Ceb2A178317bFe53ad5EE1475133";
  const usdcAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const bal = await client.readContract({ address: usdcAddress, abi, functionName: "balanceOf", args: [address] });
  console.log("USDC Balance:", Number(bal) / 1e6);
}
run();
