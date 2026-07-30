// deploy/001_deploy_lending.ts  (FIXED)
// Fixes vs v1:
//  1. Address constructor args wrapped as CalldataAddress (hex strings fail —
//     same trap as balance_of(address) in the DEX repo)
//  2. Status check reads BOTH receipt.statusName and receipt.status_name
//     (studionet receipts are snake_case; v1 checked camelCase only and
//     threw "Deployment failed" on a successful deploy)
//  3. Deprecated initializeConsensusSmartContract() removed
// Run with:  genlayer deploy

import { readFileSync } from "fs";
import path from "path";
import { TransactionHash, GenLayerClient, CalldataAddress } from "genlayer-js/types";

// ---- addr(): hex string -> CalldataAddress (mirrors the DEX repo helper) ----
function addr(hex: string): CalldataAddress {
  const clean = hex.toLowerCase().replace(/^0x/, "");
  if (clean.length !== 40) throw new Error(`Bad address length: ${hex}`);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new CalldataAddress(bytes);
}

// ---- Live studionet addresses from the DEX aggregator repo -----------------
const DEX_AGGREGATOR = "0x9D5D33AF40781B6A41E3865df7B9bEF36adc6005";
const POOL_1         = "0x6A732A632972fC3cF8a76b3CfeE3356C549c761C"; // tGEN/tUSDC 30bps
const TGEN_TOKEN     = "0xd978F743Ce2Bad27c00A329F44f8F16b401F556C";
const TUSDC_TOKEN    = "0xa04E4F945d941eD491C194E2BD29A4da06c37f07";

// ---- Protocol parameters ---------------------------------------------------
const LTV_BPS         = 7500;  // 75% max loan-to-value
const LIQUIDATION_BPS = 8000;  // 80% liquidation threshold

export default async function main(client: GenLayerClient<any>) {
  console.log("Deploying GenLayer Lending Protocol to studionet...");
  console.log("  DEX Aggregator   :", DEX_AGGREGATOR);
  console.log("  Pool (tGEN/tUSDC):", POOL_1);
  console.log("  Collateral token :", TGEN_TOKEN, "(tGEN)");
  console.log("  Debt token       :", TUSDC_TOKEN, "(tUSDC)");
  console.log("  LTV / Liq bps    :", LTV_BPS, "/", LIQUIDATION_BPS);

  const filePath = path.resolve(process.cwd(), "contracts/lending.py");
  const contractCode = new Uint8Array(readFileSync(filePath));

  // Constructor: (dex, pool, collateral_token, debt_token, ltv_bps, liquidation_bps)
  // Addresses MUST be CalldataAddress, not hex strings.
  const deployTx = await client.deployContract({
    code: contractCode,
    args: [
      addr(DEX_AGGREGATOR),
      addr(POOL_1),
      addr(TGEN_TOKEN),
      addr(TUSDC_TOKEN),
      LTV_BPS,
      LIQUIDATION_BPS,
    ],
  });

  console.log("Deploy tx submitted:", deployTx);
  console.log("Waiting for consensus (30-90s typical on studionet)...");

  const receipt: any = await client.waitForTransactionReceipt({
    hash: deployTx as TransactionHash,
    retries: 200,
    interval: 5000,
  });

  // Studionet receipts are snake_case; handle both shapes.
  const status = receipt.statusName ?? receipt.status_name ?? receipt.status;
  const ok = status === "ACCEPTED" || status === "FINALIZED";
  if (!ok) {
    console.error("Receipt:", JSON.stringify(receipt, null, 2));
    throw new Error(`Deployment failed with status: ${status}`);
  }

  // Consensus success != execution success: surface the execution result too,
  // so a constructor error can't masquerade as a good deploy again.
  const execResult =
    receipt.data?.execution_result ??
    receipt.execution_result ??
    receipt.data?.result ??
    "(not present in receipt)";
  console.log("Consensus status  :", status);
  console.log("Execution result  :", execResult);

  const contractAddress =
    receipt.data?.contract_address ??
    receipt.contract_address ??
    receipt.recipient;

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
