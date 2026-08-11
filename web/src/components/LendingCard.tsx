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
  TIERS,
  short,
} from "@/config/contracts";

type State = {
  riskTier: string;
  riskHaircutBps: string;
  riskEpoch: string;
  riskNote: string;
  riskSignal: string;
  pendingLiqId: string;
  collateral: string;
  debt: string;
  maxBorrow: string;
  liquidatable: boolean;
  collateralValue: string;
  recognizedValue: string;
  tgenBalance: string;
  tusdcBalance: string;
  trackedLiquidity: string;
  trackedCollateral: string;
  liqPending: boolean;
  quoteRef: string;
  quoteRecognized: string;
  reserveA: string;
  reserveB: string;
  errors: string[];
};

type LogLine = { text: string; kind: "info" | "ok" | "err" };

const TIER_ORDER = ["CALM", "CAUTION", "STRESS", "CRISIS"];

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
        value: 0n,
      });
      await client.waitForTransactionReceipt({
        hash,
        status: TransactionStatus.ACCEPTED,
        retries: 240,      // the risk vote needs longer than a plain write
        interval: 5000,
      });
      return hash as string;
    },
    [address, connector]
  );

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
  const tier = state?.riskTier || "";
  const assessed = (state?.riskEpoch ?? "0") !== "0";
  const haircutPct = Number(state?.riskHaircutBps ?? "0") / 100;

  const rawV = Number(state?.collateralValue ?? "0");
  const recV = Number(state?.recognizedValue ?? "0");
  const debtN = Number(state?.debt ?? "0");
  const floor = debtN === 0 ? 0 : (debtN * 10000) / LIQUIDATION_BPS;
  // The headline case: safe on market price, liquidatable on the verdict.
  const verdictDrivenLiquidation =
    debtN > 0 && rawV > floor && recV < floor && !!state?.liquidatable;

  return (
    <div className="wrap">
      <header className="head">
        <div>
          <p className="eyebrow">GenLayer · studionet</p>
          <h1 className="title">Lending &amp; Borrowing</h1>
          <p className="lede">
            Borrow tUSDC against tGEN. The price comes from an exchange deployed
            in a different repository — and how much of that price counts is
            decided by GenLayer&rsquo;s validator committee, which reads the{" "}
            <em>live</em> crypto Fear &amp; Greed index and weighs it against the
            on-chain evidence. Not a formula.
          </p>
        </div>
        <ConnectButton showBalance={false} chainStatus="none" />
      </header>

      {state?.errors && state.errors.length > 0 && (
        <p className="readerr">
          <b>Live reads are failing.</b> Values below may be stale or blank —
          check the contract address and RPC. First error:{" "}
          <span className="mono small">{state.errors[0]}</span>
        </p>
      )}

      {/* ── The validator committee ── */}
      <section className={`verdict ${tier ? `t-${tier.toLowerCase()}` : ""}`}>
        <div className="verdictMain">
          <span className="verdictLabel">Validator risk committee</span>
          <p className="verdictTier">
            {tier || (loading ? "reading…" : "not yet assessed")}
          </p>
          <p className="verdictBlurb">
            {tier && TIERS[tier]
              ? TIERS[tier].blurb
              : "Credit decisions are locked until the committee rules."}
          </p>
        </div>

        <div className="verdictScale" aria-hidden="true">
          {TIER_ORDER.map((t) => (
            <span key={t} className={t === tier ? "on" : ""}>
              {t}
            </span>
          ))}
        </div>

        <div className="verdictSide">
          <div>
            <span className="protoLabel">Market value · 100 tGEN</span>
            <b className="mono">{state?.quoteRef ?? "—"}</b>
          </div>
          <div>
            <span className="protoLabel">Recognized after haircut</span>
            <b className="mono accent">{state?.quoteRecognized ?? "—"}</b>
          </div>
          <div>
            <span className="protoLabel">Rulings settled</span>
            <b className="mono">{state?.riskEpoch ?? "—"}</b>
          </div>
          <button
            className="assess"
            disabled={!isConnected || busy !== null}
            onClick={() =>
              run("assess", [
                [LENDING, "assess_risk", [], "Validators judging the market"],
              ])
            }
          >
            {busy === "assess" ? "Committee voting…" : "Call a new ruling"}
          </button>
        </div>
      </section>

      <p className="explainer">
        <b>How this works.</b> <code>assess_risk()</code> asks every validator to
        judge the market. Each one <em>independently fetches the live crypto Fear
        &amp; Greed index</em> over the web from inside the consensus block, then
        weighs that sentiment against the same on-chain evidence — price, movement
        since the last ruling, pool depth, protocol exposure — using its own
        model. They must reach consensus on one verdict, and that verdict sets a
        haircut on every borrower&rsquo;s collateral. It is not advice:{" "}
        <code>borrow()</code> and <code>liquidate()</code> refuse to run until the
        committee has ruled.
      </p>

      {state?.riskSignal && (
        <p className="ruling">
          <span className="protoLabel">
            Committee&rsquo;s ruling — weighing the live Fear &amp; Greed feed
          </span>
          <span className="mono small">{state.riskSignal}</span>
        </p>
      )}

      {verdictDrivenLiquidation && (
        <p className="alarm">
          This position is worth <b className="mono">{rawV}</b> tUSDC at market
          price — above the <b className="mono">{Math.ceil(floor)}</b> floor, so
          it would be healthy on price alone. The committee&rsquo;s{" "}
          <b>{tier}</b> ruling discounts it to <b className="mono">{recV}</b>,
          which puts it below the floor. It is liquidatable because the
          validators said so.
        </p>
      )}

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
                  <dt>Market value</dt>
                  <dd className="mono">{state?.collateralValue ?? "—"}</dd>
                  <span className="unit">tUSDC</span>
                </div>
                <div>
                  <dt>Recognized value</dt>
                  <dd className="mono accent">{state?.recognizedValue ?? "—"}</dd>
                  <span className="unit">after {haircutPct}% haircut</span>
                </div>
                <div>
                  <dt>Debt</dt>
                  <dd className="mono">{state?.debt ?? "—"}</dd>
                  <span className="unit">tUSDC</span>
                </div>
              </dl>

              <div className={`health ${state?.liquidatable ? "bad" : "ok"}`}>
                <p>
                  {debtN === 0
                    ? "No debt. Nothing to liquidate."
                    : state?.liquidatable
                    ? `Liquidatable — recognized value is below the ${Math.ceil(
                        floor
                      )} tUSDC floor.`
                    : `Safe — liquidation begins if recognized value falls below ${Math.ceil(
                        floor
                      )} tUSDC.`}
                </p>
                <p className="sub">
                  Still borrowable: <b className="mono">{state?.maxBorrow ?? "—"}</b>{" "}
                  tUSDC — {LTV_BPS / 100}% of recognized value, minus debt.
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
              disabled={disabled || !assessed}
              title={assessed ? "" : "Needs a committee ruling first"}
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
            A position is liquidatable when its debt exceeds{" "}
            {LIQUIDATION_BPS / 100}% of its <em>recognized</em> value — market
            price after the committee&rsquo;s haircut. Anyone can then trigger
            it. The protocol seizes the collateral and instructs the pool to sell
            it; the proceeds are reconciled against the debt afterwards. Three
            transactions, because GenLayer has no synchronous cross-contract
            write.
          </p>

          <ol className="saga">
            <li className={state?.liquidatable || state?.liqPending ? "on" : ""}>
              <span className="stage">Trigger</span>
              <p>Committee-adjusted value confirms the position is underwater.</p>
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
                  [
                    LENDING,
                    "settle_liquidation",
                    [BigInt(state?.pendingLiqId ?? "0")],
                    "Settling proceeds",
                  ],
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
              <span className="protoLabel">Priced by</span>
              <b className="mono small">{short(POOL)}</b>
            </div>
            <button className="ghost tiny" onClick={refresh} disabled={loading}>
              {loading ? "Reading…" : "Refresh"}
            </button>
          </div>

          {state?.riskNote && (
            <p className="evidence">
              <span className="protoLabel">Evidence put to the committee</span>
              <span className="mono small">{state.riskNote}</span>
            </p>
          )}

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
