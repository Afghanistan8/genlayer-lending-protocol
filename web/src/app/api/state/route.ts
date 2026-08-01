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

  // ---- validator-settled risk state ----
  const riskTier = await str(LENDING, "get_risk_tier");
  const riskHaircutBps = await num(LENDING, "get_risk_haircut_bps");
  const riskEpoch = await num(LENDING, "get_risk_epoch");
  const riskNote = await str(LENDING, "get_risk_note");

  // ---- protocol-wide ----
  const trackedLiquidity = await num(LENDING, "get_tracked_liquidity");
  const trackedCollateral = await num(LENDING, "get_tracked_collateral");
  const liqPending = await bool(LENDING, "get_liq_pending");
  // Reference price at a fixed probe size: raw vs committee-recognized.
  const quoteRef = await num(LENDING, "live_collateral_value", [100n]);
  const quoteRecognized = await num(LENDING, "recognized_collateral_value", [100n]);
  const reserveA = await num(POOL, "get_reserve_a");
  const reserveB = await num(POOL, "get_reserve_b");

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
    collateral = await num(LENDING, "get_collateral", [a]);
    debt = await num(LENDING, "get_debt", [a]);
    maxBorrow = await num(LENDING, "max_borrow", [a]);
    liquidatable = await bool(LENDING, "is_liquidatable", [a]);
    tgenBalance = await num(TGEN, "balance_of", [a]);
    tusdcBalance = await num(TUSDC, "balance_of", [a]);
    if (collateral !== "0") {
      const c = BigInt(collateral);
      collateralValue = await num(LENDING, "live_collateral_value", [c]);
      recognizedValue = await num(LENDING, "recognized_collateral_value", [c]);
    }
  }

  const body = {
    riskTier,
    riskHaircutBps,
    riskEpoch,
    riskNote,
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
