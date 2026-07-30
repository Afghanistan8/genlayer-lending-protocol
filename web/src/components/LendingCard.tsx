"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { TransactionStatus } from "genlayer-js/types";
import {
  addr,
  ensureWalletAuthorized,
  getWriteClient,
  type Eip1193Provider,
} from "@/config/genlayer";
import {
  LENDING,
  TGEN,
  TUSDC,
  POOL,
  LTV_BPS,
  LIQUIDATION_BPS,
  short,
} from "@/config/contracts";

type State = {
  collateral: string;
  debt: string;
  maxBorrow: string;
  liquidatable: boolean;
  collateralValue: string;
  tgenBalance: string;
  tusdcBalance: string;
  trackedLiquidity: string;
  trackedCollateral: string;
  liqPending: boolean;
  quoteRef: string;
  reserveA: string;
  reserveB: string;
  errors: string[];
};

type LogLine = { text: string; kind: "info" | "ok" | "err" };

export default function LendingCard() {
  const { address, connector, isConnected } = useAccount();
  const [state, setState] = useState<State | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("100");
  const [log, setLog] = useState<LogLine[]>([]);

  const say = useCallback((text: string, kind: LogLine["kind"] = "info") => {
    setLog((l) => [{ text, kind }, ...l].slice(0, 8));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const q = address ? `?address=${address}` : "";
      const r = await fetch(`/api/state${q}`, { cache: "no-store" });
      const j = (await r.json()) as State;
      setState(j);
      if (j.errors?.length) say(`read issues: ${j.errors[0]}`, "err");
    } catch (e) {
      say(`could not load state: ${(e as Error).message}`, "err");
    } finally {
      setLoading(false);
    }
  }, [address, say]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** One signed write, start to finish. */
  const write = useCallback(
    async (contract: string, fn: string, args: unknown[]) => {
      if (!address) throw new Error("Connect a wallet first.");
      const provider = (await connector?.getProvider()) as
        | Eip1193Provider
        | undefined;
      await ensureWalletAuthorized(address, provider);
      const client = getWriteClient(address, provider);
      const hash = await client.writeContract({
        address: contract as `0x${string}`,
        functionName: fn,
        args: args as never,
        value: 0n, // required by the SDK even when nothing is paid
      });
      await client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.ACCEPTED,
        retries: 120,
        interval: 5000,
      });
      return hash as string;
    },
    [address, connector]
  );

  /** Run a labelled sequence of writes, then refresh. */
  const run = useCallback(
    async (label: string, steps: Array<[string, string, unknown[], string]>) => {
      setBusy(label);
      try {
        for (const [contract, fn, args, note] of steps) {
          say(`${note}…`);
          const hash = await write(contract, fn, args);
          say(`${note} confirmed · ${short(hash)}`, "ok");
        }
        await refresh();
      } catch (e) {
        say((e as Error).message, "err");
      } finally {
        setBusy(null);
      }
    },
    [write, refresh, say]
  );

  const amt = (() => {
    try {
      return BigInt(amount || "0");
    } catch {
      return 0n;
    }
  })();

  const disabled = !isConnected || busy !== null || amt <= 0n;

  // Health: collateral value as a percentage of the liquidation ceiling.
  const debtN = Number(state?.debt ?? "0");
  const valueN = Number(state?.collateralValue ?? "0");
  const ceiling = debtN === 0 ? 0 : (debtN * 10000) / LIQUIDATION_BPS;
  const healthPct =
    debtN === 0 ? 100 : Math.max(0, Math.min(100, (1 - ceiling / (valueN || 1)) * 100 + 0));
  const healthy = !state?.liquidatable;

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <p className="eyebrow">GenLayer · studionet</p>
          <h1 className="title">Lending &amp; Borrowing</h1>
          <p className="lede">
            Borrow tUSDC against tGEN. Your credit line is priced in real time by
            a decentralized exchange deployed from a different repository — the
            two contracts share nothing but an address.
          </p>
        </div>
        <ConnectButton showBalance={false} chainStatus="none" />
      </header>

      {/* ── Signature: the live wire between the two contracts ── */}
      <section className="schematic" aria-label="Cross-contract price link">
        <div className="node">
          <span className="nodeLabel">Lending protocol</span>
          <code className="nodeAddr">{short(LENDING)}</code>
        </div>

        <div className="wire">
          <span className="wireLine" aria-hidden="true">
            <i className="pulse" />
          </span>
          <span className="wireTag">
            <b className="mono">{state?.quoteRef ?? "—"}</b> tUSDC per 100 tGEN
            <em>live view() call</em>
          </span>
        </div>

        <div className="node">
          <span className="nodeLabel">Pool #1 · tGEN/tUSDC</span>
          <code className="nodeAddr">{short(POOL)}</code>
        </div>
      </section>

      <div className="grid">
        {/* ── Position ── */}
        <section className="panel">
          <h2 className="panelTitle">Your position</h2>

          {!isConnected ? (
            <p className="empty">Connect a wallet to open a position.</p>
          ) : (
            <>
              <dl className="stats">
                <div>
                  <dt>Collateral</dt>
                  <dd className="mono">{state?.collateral ?? "—"}</dd>
                  <span className="unit">tGEN</span>
                </div>
                <div>
                  <dt>Worth now</dt>
                  <dd className="mono">{state?.collateralValue ?? "—"}</dd>
                  <span className="unit">tUSDC</span>
                </div>
                <div>
                  <dt>Debt</dt>
                  <dd className="mono">{state?.debt ?? "—"}</dd>
                  <span className="unit">tUSDC</span>
                </div>
                <div>
                  <dt>Still borrowable</dt>
                  <dd className="mono">{state?.maxBorrow ?? "—"}</dd>
                  <span className="unit">tUSDC</span>
                </div>
              </dl>

              <div className={`health ${healthy ? "ok" : "bad"}`}>
                <div className="healthBar">
                  <i style={{ width: `${healthPct}%` }} />
                </div>
                <p>
                  {debtN === 0
                    ? "No debt. Nothing to liquidate."
                    : healthy
                    ? `Safe — liquidation starts if the collateral falls below ${Math.ceil(
                        ceiling
                      )} tUSDC.`
                    : `Underwater — collateral is below the ${Math.ceil(
                        ceiling
                      )} tUSDC floor and can be liquidated by anyone.`}
                </p>
              </div>

              <p className="wallet">
                Wallet · <b className="mono">{state?.tgenBalance ?? "—"}</b> tGEN
                · <b className="mono">{state?.tusdcBalance ?? "—"}</b> tUSDC
              </p>
            </>
          )}
        </section>

        {/* ── Actions ── */}
        <section className="panel">
          <h2 className="panelTitle">Move funds</h2>

          <label className="field">
            <span>Amount</span>
            <input
              className="mono"
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="100"
            />
            <em>raw u256 units — the contract is decimal-agnostic</em>
          </label>

          <div className="actions">
            <button
              disabled={disabled}
              onClick={() =>
                run("supply", [
                  [TGEN, "transfer", [addr(LENDING), amt], "Sending tGEN"],
                  [LENDING, "supply", [amt], "Crediting collateral"],
                ])
              }
            >
              Supply collateral
            </button>

            <button
              disabled={disabled}
              onClick={() => run("borrow", [[LENDING, "borrow", [amt], "Borrowing"]])}
            >
              Borrow tUSDC
            </button>

            <button
              disabled={disabled}
              onClick={() =>
                run("repay", [
                  [TUSDC, "transfer", [addr(LENDING), amt], "Sending tUSDC"],
                  [LENDING, "repay", [amt], "Clearing debt"],
                ])
              }
            >
              Repay debt
            </button>

            <button
              disabled={disabled}
              onClick={() =>
                run("withdraw", [[LENDING, "withdraw", [amt], "Withdrawing"]])
              }
            >
              Withdraw collateral
            </button>

            <button
              className="ghost"
              disabled={disabled}
              onClick={() =>
                run("fund", [
                  [TUSDC, "transfer", [addr(LENDING), amt], "Sending tUSDC"],
                  [LENDING, "fund", [amt], "Adding lendable liquidity"],
                ])
              }
            >
              Fund the pool of lendable tUSDC
            </button>
          </div>

          <p className="note">
            Supplying, repaying and funding each take two transactions: the
            tokens move first, then the protocol books what it received. Borrowed
            and withdrawn tokens arrive one consensus round after the call.
          </p>
        </section>

        {/* ── Liquidation saga ── */}
        <section className="panel span">
          <h2 className="panelTitle">Liquidation</h2>
          <p className="note">
            When a position falls below the {LIQUIDATION_BPS / 100}% floor, anyone
            can liquidate it. The protocol seizes the collateral and instructs
            Pool #1 to sell it — then the proceeds are reconciled against the
            debt. Three separate transactions, because GenLayer has no
            synchronous cross-contract write.
          </p>

          <ol className="saga">
            <li className={state?.liquidatable || state?.liqPending ? "on" : ""}>
              <span className="stage">Trigger</span>
              <p>Live quote confirms the position is underwater.</p>
            </li>
            <li className={state?.liqPending ? "on" : ""}>
              <span className="stage">Sell</span>
              <p>Collateral transfer and swap are emitted to the pool.</p>
            </li>
            <li className={state?.liqPending ? "" : "on"}>
              <span className="stage">Settle</span>
              <p>Proceeds return and clear the borrower&rsquo;s debt.</p>
            </li>
          </ol>

          <div className="actions">
            <button
              className="danger"
              disabled={!isConnected || busy !== null || !state?.liquidatable}
              onClick={() =>
                run("liquidate", [
                  [
                    LENDING,
                    "liquidate",
                    [addr(address ?? LENDING)],
                    "Liquidating position",
                  ],
                ])
              }
            >
              Liquidate this position
            </button>

            <button
              className="ghost"
              disabled={!isConnected || busy !== null || !state?.liqPending}
              onClick={() =>
                run("settle", [
                  [LENDING, "settle_liquidation", [0n], "Settling proceeds"],
                ])
              }
            >
              Settle proceeds
            </button>
          </div>

          {state?.liqPending && (
            <p className="pending">
              A liquidation is awaiting settlement. If settling reports no
              proceeds, the swap has not finalized yet — wait a moment and try
              again.
            </p>
          )}
        </section>

        {/* ── Protocol + activity ── */}
        <section className="panel span">
          <div className="protoRow">
            <div>
              <span className="protoLabel">Lendable tUSDC</span>
              <b className="mono">{state?.trackedLiquidity ?? "—"}</b>
            </div>
            <div>
              <span className="protoLabel">Collateral held</span>
              <b className="mono">{state?.trackedCollateral ?? "—"}</b>
            </div>
            <div>
              <span className="protoLabel">Max loan-to-value</span>
              <b className="mono">{LTV_BPS / 100}%</b>
            </div>
            <div>
              <span className="protoLabel">Pool reserves</span>
              <b className="mono small">
                {state?.reserveA ?? "—"} / {state?.reserveB ?? "—"}
              </b>
            </div>
            <button className="ghost tiny" onClick={refresh} disabled={loading}>
              {loading ? "Reading…" : "Refresh"}
            </button>
          </div>

          <ul className="log">
            {log.length === 0 ? (
              <li className="muted">No activity yet.</li>
            ) : (
              log.map((l, i) => (
                <li key={i} className={l.kind}>
                  {l.text}
                </li>
              ))
            )}
          </ul>
        </section>
      </div>

      <footer className="foot">
        <span>
          Lending {short(LENDING)} · Pool {short(POOL)} · tGEN {short(TGEN)} ·
          tUSDC {short(TUSDC)}
        </span>
        <span>
          Zero interest. No LP yield. Full-position liquidations only, with no
          liquidator bonus.
        </span>
      </footer>
    </div>
  );
}
