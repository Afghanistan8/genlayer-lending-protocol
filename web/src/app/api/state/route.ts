// Server-side reads for the lending protocol.
//
// Why this exists (learned the hard way on the DEX): genlayer-js readContract
// does NOT work reliably from the BROWSER against hosted studionet — gen_call
// returns hex the SDK doesn't decode there, and studionet sends no CORS
// headers. In Node it works exactly like the CLI. So every read happens here
// and the browser just fetches plain JSON.
//
// Address arguments must be CalldataAddress (addr()), never hex strings.

import { NextRequest, NextResponse } from "next/server";
import { getServerClient, addr } from "@/config/genlayer";
import { LENDING, TGEN, TUSDC, POOL } from "@/config/contracts";

export const runtime = "nodejs";        // genlayer-js needs full Node APIs
export const dynamic = "force-dynamic";

const CACHE_MS = 15_000;                // studionet allows 500 requests/hour
const cache = new Map<string, { at: number; body: unknown }>();

type Client = ReturnType<typeof getServerClient>;

/** Normalize whatever shape the SDK hands back into a decimal string. */
function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v.trim() || "0");
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return toBig(o.value);
    if ("result" in o) return toBig(o.result);
  }
  return 0n;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return toBool(o.value);
    if ("result" in o) return toBool(o.result);
  }
  return false;
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  const key = address.toLowerCase();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.body);
  }

  const client = getServerClient();
  const errors: string[] = [];

  async function num(
    contract: string,
    functionName: string,
    args: unknown[] = []
  ): Promise<string> {
    try {
      const v = await (client as Client).readContract({
        address: contract as `0x${string}`,
        functionName,
        args: args as never,
      });
      return toBig(v).toString();
    } catch (e) {
      errors.push(`${functionName}: ${(e as Error).message}`);
      return "0";
    }
  }

  async function bool(
    contract: string,
    functionName: string,
    args: unknown[] = []
  ): Promise<boolean> {
    try {
      const v = await (client as Client).readContract({
        address: contract as `0x${string}`,
        functionName,
        args: args as never,
      });
      return toBool(v);
    } catch (e) {
      errors.push(`${functionName}: ${(e as Error).message}`);
      return false;
    }
  }

  // Protocol-wide state (no wallet needed)
  const trackedLiquidity = await num(LENDING, "get_tracked_liquidity");
  const trackedCollateral = await num(LENDING, "get_tracked_collateral");
  const liqPending = await bool(LENDING, "get_liq_pending");
  // Reference price: what 100 raw units of tGEN is worth in tUSDC, read
  // cross-contract from the pool by the lending contract itself.
  const quoteRef = await num(LENDING, "live_collateral_value", [100n]);
  const reserveA = await num(POOL, "get_reserve_a");
  const reserveB = await num(POOL, "get_reserve_b");

  let collateral = "0";
  let debt = "0";
  let maxBorrow = "0";
  let liquidatable = false;
  let collateralValue = "0";
  let tgenBalance = "0";
  let tusdcBalance = "0";

  if (address) {
    const a = addr(address);
    collateral = await num(LENDING, "get_collateral", [a]);
    debt = await num(LENDING, "get_debt", [a]);
    maxBorrow = await num(LENDING, "max_borrow", [a]);
    liquidatable = await bool(LENDING, "is_liquidatable", [a]);
    tgenBalance = await num(TGEN, "balance_of", [a]);
    tusdcBalance = await num(TUSDC, "balance_of", [a]);
    if (collateral !== "0") {
      collateralValue = await num(LENDING, "live_collateral_value", [
        BigInt(collateral),
      ]);
    }
  }

  const body = {
    collateral,
    debt,
    maxBorrow,
    liquidatable,
    collateralValue,
    tgenBalance,
    tusdcBalance,
    trackedLiquidity,
    trackedCollateral,
    liqPending,
    quoteRef,
    reserveA,
    reserveB,
    errors,
    at: Date.now(),
  };

  if (errors.length === 0) cache.set(key, { at: Date.now(), body });
  return NextResponse.json(body);
}
