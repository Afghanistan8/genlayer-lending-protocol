# GenLayer Lending &amp; Borrowing Protocol

I built a collateralized lending protocol on GenLayer where two things are
decided outside my own contract:

1. **What your collateral is worth** — read live, on-chain, from an AMM pool
   deployed in a different repository as part of my DEX project.
2. **How much of that value counts** — settled by GenLayer's validator
   committee, which reads a **live off-chain sentiment feed over the web** and
   weighs it against the on-chain facts, then applies a haircut that governs
   every credit decision the protocol makes.

The second one is the reason this is a GenLayer protocol rather than an EVM
design that happens to be written in Python. Each validator independently
fetches the live crypto Fear &amp; Greed index from inside the consensus block
and judges it — there is no single oracle, no cached price, and the input isn't
identical across validators, so reaching one verdict is a genuine consensus
problem, not arithmetic. A position here can be perfectly healthy at market
price and still be liquidatable, because the committee looked at the evidence
and ruled that conditions are stressed. That ruling isn't advisory — `borrow()`
and `liquidate()` refuse to execute until the committee has spoken.

- **Live app:** https://genlayer-lending-protocol.vercel.app
- **Contract:** `0xDEA63B16f2e76beB68294fb325902E29944dAf1D` (studionet, chain 61999)
- **Stack:** Python Intelligent Contracts · Next.js + genlayer-js frontend

---

## What changed after review

An earlier version of this project was rejected with a fair criticism: the
contract was fully deterministic, so nothing in it required meaningful GenLayer
consensus. Everything it did could have run on any chain.

The earlier fix was close but not enough: it ran a validator vote, but the only
thing the validators judged was on-chain data every one of them read identically,
so consensus was still trivial. This version closes that gap. Each validator now
**independently fetches a live off-chain signal — the crypto Fear &amp; Greed
index — over the web** from inside the equivalence block, then judges it together
with the on-chain facts. The input is genuinely non-deterministic across
validators, the verdict they settle on is subjective, and it is consequential:
it is wired through every credit decision in the protocol. The section below is
that flow. The rest of the protocol — cross-contract pricing, push custody, the
asynchronous liquidation saga — is unchanged and still described honestly further
down.

---

## The validator risk committee

`assess_risk()` is permissionless. Anyone can ask the committee to re-judge the
market. Here is what happens:

**1. The protocol gathers on-chain evidence deterministically.** Current
collateral price from the pool, movement since the last ruling, pool depth on
both sides, and how much collateral and lendable liquidity the protocol itself
holds. These cross-contract reads happen *before* the consensus block, because
GenLayer forbids cross-contract calls inside it.

**2. Each validator independently fetches the live sentiment feed and judges.**
From inside the equivalence block, every validator calls
`gl.nondet.web.get("https://api.alternative.me/fng/?limit=1")` itself — a
keyless, live crypto Fear &amp; Greed reading (0 = extreme fear, 100 = extreme
greed) — and weighs that sentiment against the on-chain facts using its own
model. The question is deliberately subjective: are conditions `CALM`, `CAUTION`,
`STRESS`, or `CRISIS`? Because the feed is live and each validator fetches it
independently, they are *not* guaranteed identical input — settling on one
verdict is real consensus over non-deterministic data, the kind of assessment a
risk officer makes, not a formula. If the feed is unreachable the fetch degrades
to `unavailable` and the committee judges on the on-chain facts alone.

**3. The committee settles on one verdict**, and the protocol converts it to a
haircut through a fixed table:

| verdict | haircut | effect |
|---|---|---|
| `CALM` | 0% | full market value recognized |
| `CAUTION` | 10% | mild discount |
| `STRESS` | 25% | borrowing power visibly cut |
| `CRISIS` | 40% | severe discount |

**4. That haircut governs everything.** Recognized value = market value × (1 −
haircut), and recognized value is what `max_borrow`, `borrow`, `withdraw`,
`is_liquidatable` and `liquidate` all use. A harsher verdict shrinks every
borrower's credit line and can push a position over the liquidation threshold
without the price moving at all.

### Where non-determinism is allowed to touch

The committee returns **one line: a tier and a short reason citing the numbers it
read**. Only the tier is consumed by logic — a deterministic parser extracts it
and refuses to continue if it can't (it never defaults to "safe"), and the
haircut for each tier is a fixed table in deterministic Python. The reason string
is displayed, never computed against. Every number in the protocol — health
factors, debt, LTV arithmetic, liquidation proceeds, settlement — is ordinary
deterministic code. The validators decide *policy*; they never produce a figure
that has to reconcile. That separation is what keeps an LLM in the loop from
becoming an accounting hazard.

### Proof that the ruling is consequential

Two on-chain results, both verifiable. Both were produced by the **v6**
deployment — the version that already ran the validator vote but judged on-chain
facts only. They prove the *wiring* is consequential (a split vote, and a verdict
that flips liquidation); v7 changes only the input the committee reads, adding the
live web fetch, and will be re-proven on redeploy (see [Running it](#running-it)).

**The committee genuinely disagreed.** Transaction
`0x8e443994be618f4000657dc810c8db9330a0465c01dc4894028a919ea5e823ce`:

| | |
|---|---|
| consensus rounds | **3** |
| final round votes | **3 AGREE, 2 DISAGREE** |
| leader | rotated between rounds |
| result | `MAJORITY_AGREE` / `ACCEPTED` |

Every deterministic transaction in this project settled in **one** round at 5/5,
because there was nothing to disagree about. This one took three rounds and a
leader rotation, because judging a market is not arithmetic.

**A healthy position became liquidatable on the verdict alone.** With 100 units
of collateral and 30 of debt, the liquidation floor is 30 × 10000 ÷ 8000 =
**37.5**:

| reading | value | vs floor |
|---|---|---|
| `live_collateral_value(100)` — market price | **39** | above the floor → healthy |
| `recognized_collateral_value(100)` — after the `STRESS` haircut | **29** | below the floor → underwater |
| `is_liquidatable` | **true** | |

Same collateral, same debt, same pool price. The position is liquidatable purely
because the validator committee judged the market stressed.

---

## What the rest of the protocol does

This is the source of truth and it matches `contracts/lending.py`. If a behaviour
isn't described here, it isn't implemented.

### Pricing across repositories

Collateral is tGEN, debt is tUSDC. Raw collateral value comes from a synchronous
cross-contract `view()` call to `quote_a_for_b` on an AMM pool — a live
constant-product quote with the pool's 0.30% fee applied, computed from its
current reserves. No stored price, no oracle, no hardcoded rate.

That pool was deployed as part of my DEX project's earlier multi-contract
iteration and is still live on studionet. My DEX repository has since been
consolidated into a single self-contained contract for security reasons, so the
pool this protocol prices against is that earlier deployment rather than the
current DEX. The point it demonstrates is unchanged: this contract depends on a
contract from another codebase and another deployment, linked by nothing but an
address in a storage slot.

### Custody is push-based

The tokens are **transfer-only** — no `approve`/`transferFrom` exists. So
supplying, repaying and funding each take two transactions: you transfer the
tokens, then call `supply()` / `repay()` / `fund()`, and the contract credits you
only for the balance increase it can observe.

### Payouts are asynchronous

GenLayer has no synchronous cross-contract write. `emit()` queues a message that
runs in a later consensus round and returns nothing. So `borrow()` and
`withdraw()` record the state change immediately and send tokens via
`emit().transfer(...)` — **your debt exists before your money does.**

### Liquidation is a driven multi-transaction saga

Because the swap can only be queued, an Aave-style atomic liquidation is
impossible here. The contract emits exactly **one** message per transaction and
verifies its effect on-chain before emitting the next, so no leg is ever assumed:

```
Tx 1   liquidate(user)
       ├─ confirms the position is underwater at RECOGNIZED value
       ├─ seizes the borrower's entire collateral
       └─ emit() → transfer the collateral to the pool
                   (ONE message only — the swap is not emitted yet)

Tx 2   advance_liquidation(liq_id)   ── aliased settle_liquidation(liq_id)
       ├─ asserts the collateral actually reached the pool (unbooked ≥ seized)
       └─ emit() → swap it, proceeds addressed back to me

Tx 3   advance_liquidation(liq_id)   ── call again
       ├─ if proceeds landed: book them, repay the debt, release the lock
       └─ if not: re-emit the swap if the collateral is still unbooked,
                  else assert "not settled yet" and be retried
```

`advance_liquidation()` is permissionless, idempotent per stage, and re-emits a
swap that didn't take effect — so a stalled leg is recoverable by calling again,
not terminal. Settlement is a **permissionless reconcile, not a callback**. A
callback would have meant editing the DEX repo to teach it about a protocol it
shouldn't know exists — and the decoupling is the point. The DEX repo contains
zero lines about lending and I never touched it.

The swap's proceeds are measured at the **pool's own reserve**, not our
balance: right before emitting the swap, the contract snapshots the pool's
debt-asset reserve, and stage 2 reads how far that reserve has drained since.
That drain is exactly what the pool paid us for this swap, regardless of
anything unrelated moving our own balance in the same window (a stray
transfer, a queued `fund()`/`repay()` landing, an in-flight `borrow()`
payout). Reading our own balance instead — the earlier design — couldn't tell
"the swap's proceeds" apart from "someone else's tokens that happened to
arrive at the same time," so unrelated funds could get counted as liquidation
proceeds and extinguish more of the borrower's debt than the sale actually
raised.

The slippage guard (3%) is set against the **raw** quote, because that's what the
pool will actually pay. The haircut governs solvency policy, not execution price.

### Method reference

| method | type | what it does |
|---|---|---|
| `assess_risk()` | write | **non-deterministic** — each validator fetches the live Fear &amp; Greed index over the web and judges it with on-chain facts; the committee settles one verdict and sets the haircut |
| `get_risk_tier` / `get_risk_haircut_bps` / `get_risk_epoch` / `get_risk_note` | view | the current ruling, its cost, how many rulings have settled, and the on-chain evidence they judged |
| `get_risk_signal` | view | the committee's one-line ruling, citing the live Fear &amp; Greed reading it judged |
| `live_collateral_value(amount)` | view | raw market value, cross-contract from the pool |
| `recognized_collateral_value(amount)` | view | market value after the committee's haircut |
| `max_borrow(user)` | view | 75% of recognized value, minus existing debt |
| `is_liquidatable(user)` | view | true when debt exceeds 80% of recognized value |
| `get_collateral` / `get_debt` | view | per-user position |
| `get_tracked_collateral` / `get_tracked_liquidity` | view | protocol-wide booked balances |
| `get_pending_collateral_out` / `get_pending_liquidity_out` | view | payouts emitted but not yet confirmed gone; excluded from deposit crediting |
| `get_supply_queue_depth` / `get_fund_queue_depth` / `get_repay_queue_depth` | view | registered-but-not-yet-settled credit tickets |
| `get_liq_pending` | view | whether a liquidation awaits settlement |
| `get_pending_liq_id` | view | the id of the pending liquidation (0 when none) — the frontend settles against this |
| `fund(amount)` | write | queues a credit ticket for the transferred tUSDC and drains the queue (permissionless) |
| `settle_fund()` | write | permissionless: drains queued fund tickets without registering a new one |
| `supply(amount)` | write | queues a credit ticket for the transferred tGEN, crediting collateral as the queue drains |
| `settle_supply()` | write | permissionless: drains queued supply tickets without registering a new one |
| `borrow(amount)` | write | **requires a ruling**; records debt, emits payout, enforces LTV on recognized value |
| `repay(amount)` | write | queues a credit ticket for the transferred tUSDC, reducing debt as the queue drains |
| `settle_repay()` | write | permissionless: drains queued repay tickets without registering a new one |
| `withdraw(amount)` | write | emits collateral back; re-checks LTV on recognized value |
| `liquidate(user)` | write | **requires a ruling**; permissionless; seizes collateral, emits the transfer (the swap follows in `advance_liquidation`) |
| `advance_liquidation(liq_id)` / `settle_liquidation(liq_id)` | write | permissionless driver (same function, two names); emits the swap once collateral lands, retries a stalled swap, books proceeds, clears debt — idempotent per stage |
| `set_trusted_dex` / `set_trusted_pool` | write | owner-only; repoint at redeployed contracts |

### Risk parameters, as deployed

- **Loan-to-value: 75%** — of *recognized* value, not market value
- **Liquidation threshold: 80%** — of *recognized* value
- **Slippage guard: 3%** — against the raw quote

---

## What it does *not* do

- **No interest.** Debt repaid equals debt borrowed.
- **No yield, no LP shares.** Funders earn nothing and funded liquidity cannot be
  withdrawn in this version.
- **No liquidator bonus.** Triggering a liquidation pays nothing.
- **Full-position liquidations only.** No partial liquidations.
- **Surplus is not refunded.** If collateral sells for more than the debt, the
  excess stays with the protocol.
- **One live signal, and only into policy.** The committee fetches the Fear &amp;
  Greed index and nothing else — no news, no headlines, no off-chain price feed —
  and it can only move the haircut tier, never a figure the accounting relies on.
  If the feed is unreachable the fetch degrades to `unavailable` and the committee
  rules on the on-chain facts alone.
- **The aggregator address is recorded but never called.** `trusted_dex` is stored
  and owner-updatable, but no method reads it. All pricing and execution go
  through the pool directly.

---

## Verified on-chain

Built in milestones, each deployed and proven before the next began.

**M1 — the cross-contract read.** Before any lending logic, a contract that did
nothing but call the pool returned `68` for `live_collateral_value(100)` — a live
constant-product quote against reserves my own earlier swaps had moved.

**M2 — custody and the async payout.** With collateral worth 68, `max_borrow`
returned exactly **51** (75%). Borrowing 30 succeeded, and the receipt showed the
queued child message paying out:

```json
"messages": [
  { "recipient": "0xa04E…7f07", "data": "…method transfer…", "onAcceptance": false }
]
```

**M3 — the liquidation saga.** I crashed the price by dumping 300 tGEN into the
pool. `is_liquidatable` flipped true, `liquidate()` seized the collateral and
emitted the swap, and the pool returned **44** tUSDC. The first
`settle_liquidation` ran before the swap finalized and **reverted cleanly on its
own guard** — consensus accepted the transaction, the assert fired, no state
changed — and the retry settled it: debt **0**, collateral **0**, protocol
liquidity **56**, lock released.

**M4 — the validator committee (v6).** Covered above: three consensus rounds, a
split vote, and a position that became liquidatable on the ruling alone — proving
the verdict is consequential end-to-end.

**M5 — live external sentiment (v7).** The committee now fetches the crypto Fear
&amp; Greed index over the web from inside the equivalence block, so each
validator judges genuinely non-deterministic input. Once the owner redeploys v7
(see below) and calls `assess_risk()`, `get_risk_signal()` returns the committee's
one-line ruling citing the live reading, and the app renders it. That fetch is the
material non-determinism the earlier review asked for.

Every flow in the frontend has been exercised against studionet: assess, supply,
borrow, repay, withdraw, fund, liquidate and settle.

---

## Running it

### Contract

```bash
genlayer network studionet

genlayer deploy --contract contracts/lending.py \
  --args addr#9D5D33AF40781B6A41E3865df7B9bEF36adc6005 \
         addr#6A732A632972fC3cF8a76b3CfeE3356C549c761C \
         addr#d978F743Ce2Bad27c00A329F44f8F16b401F556C \
         addr#a04E4F945d941eD491C194E2BD29A4da06c37f07 \
         7500 8000
```

Constructor order is `(dex, pool, collateral_token, debt_token, ltv_bps,
liquidation_bps)`. Address arguments **must** use the `addr#` form. After
deploying, call `assess_risk` once — borrowing is disabled until a ruling exists.

### Frontend

```bash
cd web
npm install
npm run build     # always build before deploying — dev skips type-checking
npm run dev
```

On Vercel, set the Root Directory to `web`.

### Addresses

| contract | address |
|---|---|
| LendingProtocol (v7 — live web+LLM risk committee) | `0xDEA63B16f2e76beB68294fb325902E29944dAf1D` |
| AMM pool (tGEN/tUSDC, 30bps) | `0x6A732A632972fC3cF8a76b3CfeE3356C549c761C` |
| tGEN | `0xd978F743Ce2Bad27c00A329F44f8F16b401F556C` |
| tUSDC | `0xa04E4F945d941eD491C194E2BD29A4da06c37f07` |

The lending address above is the v7 deployment: each validator fetches the live
Fear &amp; Greed index via `gl.nondet.web` inside the equivalence block and the
committee settles the verdict on-chain. The previous v6 deployment
(`0xC79d…136f`) judged on-chain facts only.

Earlier milestones remain on-chain: `0xF87A…bb44` (read-only spike),
`0x41Aa…C656` (before liquidation), `0x604A…7eDE` (before the risk committee).

---

## Known limitations

**Committee calibration is untuned.** The verdict depends on how the models read
the criteria I wrote. In testing it held `CALM` through a mild decline and moved
to `STRESS` after a larger one, which is reasonable — but I haven't tuned the
thresholds, and a different phrasing of the criteria would produce different
rulings. I'd rather report that than pretend the calibration is validated.

**A ruling can go stale.** The haircut persists until someone calls
`assess_risk()` again. There is no staleness expiry, so a position can sit under
an old verdict.

**Liquidation is a driven, self-healing saga.** `liquidate()` emits exactly one
message — the collateral transfer — and then `advance_liquidation()` (aliased
`settle_liquidation()`) is called repeatedly to move it forward: it emits the
swap only after confirming the collateral actually reached the pool, re-emits a
swap that didn't take effect, and books the proceeds when they land. Each stage
verifies its own precondition on-chain, so a leg that hasn't settled yet asserts
cleanly and is retried rather than corrupting state — but the saga does need
someone to keep calling the driver until it returns the repaid amount. It does
not self-trigger.

**One liquidation at a time.** Settlement identifies proceeds by balance delta, so
a global lock permits one pending liquidation. `repay()`/`fund()` refuse to run
while a liquidation is awaiting its swap proceeds (`liq_stage == 2`), so those
proceeds can never be counted as someone else's deposit.

**Payout deltas are isolated from deposit deltas.** `borrow()`/`withdraw()`
decrement `tracked_liquidity`/`tracked_collateral` the instant they emit a
payout, but the async transfer settles later — until it does, the balance still
sitting in the contract is earmarked in `pending_liquidity_out` /
`pending_collateral_out` and excluded from what `supply()`/`fund()`/`repay()`
will credit as a fresh deposit. Without this, an in-flight payout (or the same
window race on liquidation proceeds above) could be double-counted and used to
credit debt reduction or collateral to a caller who transferred nothing.

**Credits are bound to whoever registered them, not whoever calls.** A balance
delta alone can't tell WHOSE transfer produced an increase — only that one
happened — so any caller could sweep an already-arrived, not-yet-claimed
transfer just by calling `supply()`/`fund()`/`repay()` first, with zero setup
of their own. Each call instead queues a numbered ticket (registrant, amount);
settlement (the same call, immediately, if nothing is queued ahead of it, or a
later `settle_supply()`/`settle_fund()`/`settle_repay()`) drains the queue in
registration order, crediting the ticket's owner only from excess that clears
everyone queued ahead of it. This is **not** a cryptographic proof of who sent
a specific transfer — that would need an allowance/`transferFrom` the deployed
tGEN/tUSDC tokens don't implement (this protocol has none, by design, per the
custody model above). It's a weaker but real guarantee: nothing queued *later*
can cut in front of a ticket already waiting. A ticket registered before
transferring is protected against a later-registering third party; a transfer
made before anyone has registered anything is first-come-first-served among
tickets that exist once it lands, the same way any shared pool is. `repay()`
tickets cap the credited amount at the registrant's outstanding debt at
settlement time (it may have shrunk via a liquidation in between) rather than
leaving the ticket stuck. Each drain is capped at `MAX_DRAIN` (20) tickets per
call so a long backlog can't make a single call run out of gas.

**studionet simulates consensus.** The appeal window and message re-execution
aren't exercised as a real network would. Settlement is idempotent regardless, but
I can't claim those paths are battle-tested here.

**Amounts are raw u256 units.** The contract is decimal-agnostic and the UI says
so. The pool is seeded at 18-decimal scale, so raw-unit positions are microscopic
next to pool depth — fine for demonstrating mechanics, not realistic sizing.

**The liquidate button targets your own address**, since this is a single-wallet
demo.

**studionet constraints.** 500 RPC requests per hour, and the network can be
reset.

---

## Engineering notes

Things that cost me real time.

**`Depends` must be the pinned GenVM hash.** The documentation's
`py-genlayer:test` gets the contract rejected as `invalid_contract` before the
constructor runs. The header that works:
`py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`.

**Consensus success is not execution success.** A transaction can reach `ACCEPTED`
with all five validators voting `AGREE` while its `execution_result` is `ERROR` —
the committee agreeing the contract *failed*. A deploy script checking only
`status_name` will report a successful deployment of a contract that doesn't
exist. Always read `execution_result`.

**Non-deterministic writes take longer and may take several rounds.** My
`assess_risk` call settled on the third round. Client receipt timeouts sized for
deterministic writes will give up too early.

**Never let an unreadable verdict default to "safe."** If the committee returns
something my parser can't classify, the contract raises. A silent fallback to
`CALM` would mean an LLM hiccup quietly removes every risk control.

**Address arguments are not hex strings.** Passing a string kills the constructor
with `AttributeError: 'str' object has no attribute 'as_bytes'`. The CLI's `addr#`
form handles it; in JavaScript you need a real `CalldataAddress` from 20 raw
bytes.

**The CLI bundles its own genlayer-js.** A `CalldataAddress` built from the
project's `node_modules` is a different class from the CLI's encoder's, rejected
as `invalid calldata input '[object Object]'`. The CLI also caches deploy scripts
as `*.compiled.js` and will re-run a stale compile. Direct CLI deployment with
`addr#` sidesteps both.

**Browser reads don't work against hosted studionet.** `readContract` returns data
the SDK doesn't decode in the browser, and studionet sends no CORS headers. Reads
run server-side in a Node route; only signing happens in the browser.

**`args` needs a cast in TypeScript.** The SDK types it as `CalldataEncodable[]`,
so helpers taking `unknown[]` fail type-checking — and only `npm run build`
catches it, never `npm run dev`.

**.NET file methods ignore PowerShell's working directory.**
`[System.IO.File]::ReadAllText` resolves relative paths against the process's own
directory, not wherever you've `cd`'d.

---

## What's next

- Broaden the committee's live evidence beyond the Fear &amp; Greed index —
  volatility, headlines, reference prices — so the judgement covers more of the
  world outside the pool.
- Expire stale rulings, so credit decisions can't run on an old verdict.
- Interest accrual, partial liquidations, and a liquidator incentive.

---

Built by Alpha — [@Asuzu_a](https://x.com/Asuzu_a) ·
[github.com/Afghanistan8](https://github.com/Afghanistan8)
