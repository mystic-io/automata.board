import { createPublicClient, http, formatEther } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
async function run() {
  const address = "0x383C0d96B887Ceb2A178317bFe53ad5EE1475133";
  const bal = await client.getBalance({ address });
  console.log("ETH Balance:", formatEther(bal));
}
run();
