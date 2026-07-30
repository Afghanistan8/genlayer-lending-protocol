import { readFileSync } from "fs";
import path from "path";
import { CalldataAddress } from "genlayer-js/types";
function addr(hex) {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  if (clean.length !== 40) throw new Error(`Bad address length: ${hex}`);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new CalldataAddress(bytes);
}
const DEX_AGGREGATOR = "0x9D5D33AF40781B6A41E3865df7B9bEF36adc6005";
const POOL_1 = "0x6A732A632972fC3cF8a76b3CfeE3356C549c761C";
const TGEN_TOKEN = "0xd978F743Ce2Bad27c00A329F44f8F16b401F556C";
const TUSDC_TOKEN = "0xa04E4F945d941eD491C194E2BD29A4da06c37f07";
const LTV_BPS = 7500;
const LIQUIDATION_BPS = 8e3;
async function main(client) {
  console.log("Deploying GenLayer Lending Protocol to studionet...");
  console.log("  DEX Aggregator   :", DEX_AGGREGATOR);
  console.log("  Pool (tGEN/tUSDC):", POOL_1);
  console.log("  Collateral token :", TGEN_TOKEN, "(tGEN)");
  console.log("  Debt token       :", TUSDC_TOKEN, "(tUSDC)");
  console.log("  LTV / Liq bps    :", LTV_BPS, "/", LIQUIDATION_BPS);
  const filePath = path.resolve(process.cwd(), "contracts/lending.py");
  const contractCode = new Uint8Array(readFileSync(filePath));
  const deployTx = await client.deployContract({
    code: contractCode,
    args: [
      addr(DEX_AGGREGATOR),
      addr(POOL_1),
      addr(TGEN_TOKEN),
      addr(TUSDC_TOKEN),
      LTV_BPS,
      LIQUIDATION_BPS
    ]
  });
  console.log("Deploy tx submitted:", deployTx);
  console.log("Waiting for consensus (30-90s typical on studionet)...");
  const receipt = await client.waitForTransactionReceipt({
    hash: deployTx,
    retries: 200,
    interval: 5e3
  });
  const status = receipt.statusName ?? receipt.status_name ?? receipt.status;
  const ok = status === "ACCEPTED" || status === "FINALIZED";
  if (!ok) {
    console.error("Receipt:", JSON.stringify(receipt, null, 2));
    throw new Error(`Deployment failed with status: ${status}`);
  }
  const execResult = receipt.data?.execution_result ?? receipt.execution_result ?? receipt.data?.result ?? "(not present in receipt)";
  console.log("Consensus status  :", status);
  console.log("Execution result  :", execResult);
  const contractAddress = receipt.data?.contract_address ?? receipt.contract_address ?? receipt.recipient;
  console.log("");
  console.log("=================================================");
  console.log("  Lending Protocol deployed");
  console.log("  Address:", contractAddress);
  console.log("  Tx hash:", deployTx);
  console.log("=================================================");
  console.log("");
  console.log("Verify the cross-contract spike:");
  console.log(`  genlayer call ${contractAddress} live_collateral_value --args 100`);
  return contractAddress;
}
export {
  main as default
};
