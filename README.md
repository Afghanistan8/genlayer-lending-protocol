# GenLayer Lending &amp; Borrowing Protocol

I built a collateralized lending protocol on GenLayer where two things are
decided outside my own contract:

1. **What your collateral is worth** — read live, on-chain, from an AMM pool
   deployed in a different repository as part of my DEX project.
2. **How much of that value counts** — settled by GenLayer's validator
   committee, which judges market conditions and applies a haircut that governs
   every credit decision the protocol makes.

The second one is the reason this is a GenLayer protocol rather than an EVM
design that happens to be written in Python. A position here can be perfectly
healthy at market price and still be liquidatable, because the validators looked
at the evidence and ruled that conditions are stressed. That ruling isn't
advisory — `borrow()` and `liquidate()` refuse to execute until the committee has
spoken.

- **Live app:** https://genlayer-lending-protocol.vercel.app
- **Contract:** `0xC79dD0D2e1e557269922Ff4D1A18F730740f136f` (studionet, chain 61999)
- **Stack:** Python Intelligent Contracts · Next.js + genlayer-js frontend

---

## What changed after review

An earlier version of this project was rejected with a fair criticism: the
contract was fully deterministic, so nothing in it required meaningful GenLayer
consensus. Everything it did could have run on any chain.

This version adds a non-deterministic flow whose result is consequential, and
wires it through every credit decision in the protocol. The section below is
that flow. The rest of the protocol — cross-contract pricing, push custody, the
asynchronous liquidation saga — is unchanged and still described honestly further
down.

---

## The validator risk committee

`assess_risk()` is permissionless. Anyone can ask the committee to re-judge the
market. Here is what happens:

**1. The protocol gathers evidence deterministically.** Current collateral price
from the pool, movement since the last ruling, pool depth on both sides, and how
much collateral and lendable liquidity the protocol itself holds. Every validator
is shown the *same* facts, so what they're being asked to agree on is the
judgement, not the data.

**2. Each validator judges independently, using its own model.** The question is
deliberately subjective: are conditions `CALM`, `CAUTION`, `STRESS`, or `CRISIS`?
The criteria talk about whether liquidity is deep enough to absorb the
protocol's collateral, whether price is falling, and how exposure compares to
pool depth — the kind of assessment a risk officer makes, not a formula.

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

The committee returns **a label and nothing else**. The haircut for each label is
a fixed table in deterministic Python, and every number in the protocol — health
factors, debt, LTV arithmetic, liquidation proceeds, settlement — is ordinary
deterministic code. The validators decide *policy*; they never produce a figure
that has to reconcile. That separation is what keeps an LLM in the loop from
becoming an accounting hazard.

### Proof that the ruling is consequential

Two on-chain results, both verifiable.

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

### Liquidation is a three-transaction saga

Because the swap can only be queued, an Aave-style atomic liquidation is
impossible here:

```
Tx 1   liquidate(user)
       ├─ confirms the position is underwater at RECOGNIZED value
       ├─ seizes the borrower's entire collateral
       ├─ emit() → transfer the collateral to the pool
       └─ emit() → swap it, proceeds addressed back to me
                   (returns nothing — no proceeds in this transaction)

Tx 2   the pool's own consensus round
       └─ the swap executes and sends tUSDC to my contract

Tx 3   settle_liquidation(liq_id)
       ├─ books the tUSDC balance increase as the proceeds
       ├─ repays the borrower's debt
       └─ marks the id settled, releases the lock
```

Settlement is a **permissionless reconcile, not a callback**. A callback would
have meant editing the DEX repo to teach it about a protocol it shouldn't know
exists — and the decoupling is the point. So the contract measures its own
balance delta instead. The DEX repo contains zero lines about lending and I never
touched it.

The slippage guard (3%) is set against the **raw** quote, because that's what the
pool will actually pay. The haircut governs solvency policy, not execution price.

### Method reference

| method | type | what it does |
|---|---|---|
| `assess_risk()` | write | **non-deterministic** — validator committee settles a market verdict and sets the haircut |
| `get_risk_tier` / `get_risk_haircut_bps` / `get_risk_epoch` / `get_risk_note` | view | the current ruling, its cost, how many rulings have settled, and the evidence they judged |
| `live_collateral_value(amount)` | view | raw market value, cross-contract from the pool |
| `recognized_collateral_value(amount)` | view | market value after the committee's haircut |
| `max_borrow(user)` | view | 75% of recognized value, minus existing debt |
| `is_liquidatable(user)` | view | true when debt exceeds 80% of recognized value |
| `get_collateral` / `get_debt` | view | per-user position |
| `get_tracked_collateral` / `get_tracked_liquidity` | view | protocol-wide booked balances |
| `get_liq_pending` | view | whether a liquidation awaits settlement |
| `fund(amount)` | write | books transferred tUSDC as lendable liquidity (permissionless) |
| `supply(amount)` | write | books transferred tGEN as collateral |
| `borrow(amount)` | write | **requires a ruling**; records debt, emits payout, enforces LTV on recognized value |
| `repay(amount)` | write | books transferred tUSDC against your debt |
| `withdraw(amount)` | write | emits collateral back; re-checks LTV on recognized value |
| `liquidate(user)` | write | **requires a ruling**; permissionless; seizes collateral, emits transfer + swap |
| `settle_liquidation(liq_id)` | write | permissionless; books proceeds, clears debt — idempotent |
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
- **No web access.** The committee judges on-chain evidence and its own knowledge.
  It does not fetch news or off-chain price feeds. Adding `gl.nondet.web` to the
  evidence gathering is the obvious next step and is not claimed here.
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

**M4 — the validator committee.** Covered above: three consensus rounds, a split
vote, and a position that became liquidatable on the ruling alone.

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
| LendingProtocol (current) | `0xC79dD0D2e1e557269922Ff4D1A18F730740f136f` |
| AMM pool (tGEN/tUSDC, 30bps) | `0x6A732A632972fC3cF8a76b3CfeE3356C549c761C` |
| tGEN | `0xd978F743Ce2Bad27c00A329F44f8F16b401F556C` |
| tUSDC | `0xa04E4F945d941eD491C194E2BD29A4da06c37f07` |

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

**Child message ordering.** `liquidate()` emits the transfer and the swap and
assumes they execute in that order. If the swap ran first it would fail its own
receipt check and the collateral would sit at the pool awaiting manual recovery.

**One liquidation at a time.** Settlement identifies proceeds by balance delta, so
a global lock permits one pending liquidation. A `repay()` landing in that window
would be counted into the settlement.

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

- Feed real off-chain signals into the committee's evidence via `gl.nondet.web` —
  volatility, headlines, reference prices — so the judgement covers the world
  outside the pool.
- Expire stale rulings, so credit decisions can't run on an old verdict.
- Interest accrual, partial liquidations, and a liquidator incentive.

---

Built by Alpha — [@Asuzu_a](https://x.com/Asuzu_a) ·
[github.com/Afghanistan8](https://github.com/Afghanistan8)
