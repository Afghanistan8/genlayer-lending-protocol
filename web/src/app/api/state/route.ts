// Server-side reads for the lending protocol.
//
// genlayer-js readContract does NOT work reliably from the BROWSER against
// hosted studionet (gen_call returns hex the SDK doesn't decode there, and
// studionet sends no CORS headers). In Node it works like the CLI. So every
// read happens here and the browser just fetches plain JSON.

import { NextRequest, NextResponse } from "next/server";
import { getServerClient, addr } from "@/config/genlayer";
import { LENDING, TGEN, TUSDC, POOL } from "@/config/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Studionet reads are ~1-1.5s each. Even fanned out (below) give the function
// generous headroom so a slow round-trip can't trip the platform's default
// serverless timeout and 504 the whole page.
export const maxDuration = 30;

const CACHE_MS = 15_000;                // studionet allows 500 requests/hour
const cache = new Map<string, { at: number; body: unknown }>();

type Client = ReturnType<typeof getServerClient>;

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

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("value" in o) return toStr(o.value);
    if ("result" in o) return toStr(o.result);
  }
  return "";
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

  async function read(
    contract: string,
    functionName: string,
    args: unknown[] = []
  ): Promise<unknown> {
    try {
      return await (client as Client).readContract({
        address: contract as `0x${string}`,
        functionName,
        args: args as never,
      });
    } catch (e) {
      errors.push(`${functionName}: ${(e as Error).message}`);
      return null;
    }
  }

  const num = async (c: string, f: string, a: unknown[] = []) =>
    toBig(await read(c, f, a)).toString();
  const bool = async (c: string, f: string, a: unknown[] = []) =>
    toBool(await read(c, f, a));
  const str = async (c: string, f: string, a: unknown[] = []) =>
    toStr(await read(c, f, a));

  // Every read below is independent, so fan them out concurrently rather than
  // awaiting one-by-one. Serialized, this route made ~13 studionet round-trips
  // and took ~18s cold — past Vercel's serverless timeout, so the deployed
  // page's fetch was killed and every value rendered as "—"/"not yet assessed".
  // In parallel it lands in a couple of seconds. studionet's 500 req/hour budget
  // is untouched (same number of reads, just not serialized) and the 15s cache
  // still absorbs repeat loads.

  // ---- validator-settled risk state + protocol-wide (one concurrent wave) ----
  const [
    riskTier,
    riskHaircutBps,
    riskEpoch,
    riskNote,
    riskSignal, // committee's ruling — cites the LIVE Fear & Greed reading it judged
    trackedLiquidity,
    trackedCollateral,
    liqPending,
    pendingLiqId,
    quoteRef, // reference price at a fixed probe size: raw ...
    quoteRecognized, // ... vs committee-recognized
    reserveA,
    reserveB,
  ] = await Promise.all([
    str(LENDING, "get_risk_tier"),
    num(LENDING, "get_risk_haircut_bps"),
    num(LENDING, "get_risk_epoch"),
    str(LENDING, "get_risk_note"),
    str(LENDING, "get_risk_signal"),
    num(LENDING, "get_tracked_liquidity"),
    num(LENDING, "get_tracked_collateral"),
    bool(LENDING, "get_liq_pending"),
    num(LENDING, "get_pending_liq_id"),
    num(LENDING, "live_collateral_value", [100n]),
    num(LENDING, "recognized_collateral_value", [100n]),
    num(POOL, "get_reserve_a"),
    num(POOL, "get_reserve_b"),
  ]);

  let collateral = "0";
  let debt = "0";
  let maxBorrow = "0";
  let liquidatable = false;
  let collateralValue = "0";       // raw market value
  let recognizedValue = "0";       // after the committee's haircut
  let tgenBalance = "0";
  let tusdcBalance = "0";

  if (address) {
    const a = addr(address);
    // Per-account reads — another concurrent wave.
    [collateral, debt, maxBorrow, liquidatable, tgenBalance, tusdcBalance] =
      await Promise.all([
        num(LENDING, "get_collateral", [a]),
        num(LENDING, "get_debt", [a]),
        num(LENDING, "max_borrow", [a]),
        bool(LENDING, "is_liquidatable", [a]),
        num(TGEN, "balance_of", [a]),
        num(TUSDC, "balance_of", [a]),
      ]);
    // These two depend on the collateral amount, so they follow — but together.
    if (collateral !== "0") {
      const c = BigInt(collateral);
      [collateralValue, recognizedValue] = await Promise.all([
        num(LENDING, "live_collateral_value", [c]),
        num(LENDING, "recognized_collateral_value", [c]),
      ]);
    }
  }

  const body = {
    riskTier,
    riskHaircutBps,
    riskEpoch,
    riskNote,
    riskSignal,
    pendingLiqId,
    collateral,
    debt,
    maxBorrow,
    liquidatable,
    collateralValue,
    recognizedValue,
    tgenBalance,
    tusdcBalance,
    trackedLiquidity,
    trackedCollateral,
    liqPending,
    quoteRef,
    quoteRecognized,
    reserveA,
    reserveB,
    errors,
    at: Date.now(),
  };

  if (errors.length === 0) cache.set(key, { at: Date.now(), body });
  return NextResponse.json(body);
}
