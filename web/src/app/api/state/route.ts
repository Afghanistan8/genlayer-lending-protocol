// Server-side reads for the lending protocol.
//
// genlayer-js readContract does NOT work reliably from the BROWSER against
// hosted studionet (gen_call returns hex the SDK doesn't decode there, and
// studionet sends no CORS headers). In Node it works like the CLI. So every
// read happens here and the browser just fetches plain JSON.
//
// studionet enforces a hard 30 requests/minute throttle (an anti-spam limit set
// by the GenLayer team, not something we can raise). This route is built around
// that budget so a reviewer never sees a blank committee:
//
//   1. Read count is minimised. Dead reads are gone; the two recognized-value
//      probes are DERIVED from the haircut (`raw * (10000-bps) // 10000`, the
//      contract's exact integer formula) instead of costing extra round-trips.
//   2. The committee/protocol data is identical for every visitor, so it is
//      cached ONCE globally (60s) rather than per-address — connecting a wallet
//      no longer re-reads it.
//   3. Reads are pooled at a modest concurrency instead of fired as one wide
//      burst (a burst is exactly what a per-minute limiter punishes).
//   4. Stale-while-error: if a read is throttled, we serve the last KNOWN-GOOD
//      snapshot instead of blanking the UI. A ruling that already settled keeps
//      showing until a fully-clean read replaces it.

import { NextRequest, NextResponse } from "next/server";
import { getServerClient, addr } from "@/config/genlayer";
import { LENDING, TGEN, TUSDC, POOL } from "@/config/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Pooled reads land in a few seconds; the generous ceiling only guards against a
// single slow round-trip tripping the platform's default serverless timeout.
export const maxDuration = 30;

// Committee/protocol data is the same for everyone and rulings change rarely, so
// hold it a full minute — most visits and refreshes then cost zero round-trips.
const PROTO_TTL = 60_000;
// Per-wallet data changes with the user's own txs, so keep it fresher.
const ACCT_TTL = 15_000;
// Drain reads a few at a time: low latency, but never a ~20-wide burst that trips
// studionet's 30/min limiter.
const CONCURRENCY = 5;

type Proto = {
  riskTier: string;
  riskHaircutBps: string;
  riskEpoch: string;
  riskNote: string;
  riskSignal: string;
  trackedLiquidity: string;
  trackedCollateral: string;
  liqPending: boolean;
  pendingLiqId: string;
  quoteRef: string; // market value of a fixed 100-tGEN probe
  quoteRecognized: string; // ...after the committee's haircut (derived)
};

type Acct = {
  collateral: string;
  debt: string;
  maxBorrow: string;
  liquidatable: boolean;
  collateralValue: string;
  recognizedValue: string;
  tgenBalance: string;
  tusdcBalance: string;
};

const ZERO_ACCT: Acct = {
  collateral: "0",
  debt: "0",
  maxBorrow: "0",
  liquidatable: false,
  collateralValue: "0",
  recognizedValue: "0",
  tgenBalance: "0",
  tusdcBalance: "0",
};

// Last KNOWN-GOOD snapshots (only ever written when a wave read cleanly). These
// survive within a warm serverless instance and are what we fall back to when a
// later read is throttled — so the committee never blanks on a rate limit.
let protoCache: { at: number; data: Proto } | null = null;
const acctCache = new Map<string, { at: number; data: Acct }>();

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

/** The contract's exact recognized-value math: raw * (10000 - haircutBps) // 10000.
 *  Done in BigInt so it matches the on-chain floor division to the integer, which
 *  is why we can derive it instead of spending two more studionet reads. */
function applyHaircut(raw: string, haircutBps: string): string {
  try {
    const r = BigInt(raw || "0");
    const bps = BigInt(haircutBps || "0");
    if (bps <= 0n) return r.toString();
    return ((r * (10000n - bps)) / 10000n).toString();
  } catch {
    return raw || "0";
  }
}

/** Run tasks at most `size` at a time, preserving order. */
async function pooled<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(size, tasks.length) }, worker);
  await Promise.all(workers);
  return out;
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  const key = address.toLowerCase();

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
  // Booleans as strings so a mixed batch stays uniformly typed for the pool.
  const boolStr = async (c: string, f: string, a: unknown[] = []) =>
    (await bool(c, f, a)) ? "true" : "false";

  // ── Protocol / committee data — shared across all visitors, cached hard. ──
  let proto: Proto;
  if (protoCache && Date.now() - protoCache.at < PROTO_TTL) {
    proto = protoCache.data; // fresh cache hit: zero round-trips
  } else {
    const before = errors.length;
    const [
      riskTier,
      riskHaircutBps,
      riskEpoch,
      riskNote,
      riskSignal, // committee's ruling — cites the LIVE Fear & Greed reading it judged
      trackedLiquidity,
      trackedCollateral,
      liqPendingStr,
      pendingLiqId,
      quoteRef, // market value at a fixed probe size; recognized value derived below
    ] = await pooled(
      [
        () => str(LENDING, "get_risk_tier"),
        () => num(LENDING, "get_risk_haircut_bps"),
        () => num(LENDING, "get_risk_epoch"),
        () => str(LENDING, "get_risk_note"),
        () => str(LENDING, "get_risk_signal"),
        () => num(LENDING, "get_tracked_liquidity"),
        () => num(LENDING, "get_tracked_collateral"),
        () => boolStr(LENDING, "get_liq_pending"),
        () => num(LENDING, "get_pending_liq_id"),
        () => num(LENDING, "live_collateral_value", [100n]),
      ],
      CONCURRENCY
    );

    const fresh: Proto = {
      riskTier,
      riskHaircutBps,
      riskEpoch,
      riskNote,
      riskSignal,
      trackedLiquidity,
      trackedCollateral,
      liqPending: liqPendingStr === "true",
      pendingLiqId,
      quoteRef,
      quoteRecognized: applyHaircut(quoteRef, riskHaircutBps),
    };

    if (errors.length === before) {
      // Clean read → this becomes the new known-good snapshot.
      protoCache = { at: Date.now(), data: fresh };
      proto = fresh;
    } else if (protoCache) {
      // Throttled/failed but we have a prior good ruling → serve it (don't blank).
      proto = protoCache.data;
    } else {
      // Cold instance AND throttled: return what we got; the client retries.
      proto = fresh;
    }
  }

  // ── Per-account data — only when a wallet is connected. ──
  let acct: Acct = ZERO_ACCT;
  if (address) {
    const cached = acctCache.get(key);
    if (cached && Date.now() - cached.at < ACCT_TTL) {
      acct = cached.data;
    } else {
      const before = errors.length;
      const a = addr(address);
      const [collateral, debt, maxBorrow, liquidatableStr, tgenBalance, tusdcBalance] =
        await pooled(
          [
            () => num(LENDING, "get_collateral", [a]),
            () => num(LENDING, "get_debt", [a]),
            () => num(LENDING, "max_borrow", [a]),
            () => boolStr(LENDING, "is_liquidatable", [a]),
            () => num(TGEN, "balance_of", [a]),
            () => num(TUSDC, "balance_of", [a]),
          ],
          CONCURRENCY
        );

      // Market value needs the collateral amount, so it follows; recognized value
      // is then derived from it with the committee's haircut (no extra read).
      let collateralValue = "0";
      if (collateral !== "0") {
        collateralValue = await num(LENDING, "live_collateral_value", [BigInt(collateral)]);
      }
      const recognizedValue = applyHaircut(collateralValue, proto.riskHaircutBps);

      const fresh: Acct = {
        collateral,
        debt,
        maxBorrow,
        liquidatable: liquidatableStr === "true",
        collateralValue,
        recognizedValue,
        tgenBalance,
        tusdcBalance,
      };

      if (errors.length === before) {
        acctCache.set(key, { at: Date.now(), data: fresh });
        acct = fresh;
      } else if (cached) {
        acct = cached.data; // stale-while-error
      } else {
        acct = fresh;
      }
    }
  }

  const body = {
    ...proto,
    ...acct,
    errors,
    at: Date.now(),
  };

  return NextResponse.json(body);
}
