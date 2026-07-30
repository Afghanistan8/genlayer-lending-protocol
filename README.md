# GenLayer Lending &amp; Borrowing Protocol

I built a collateralized lending protocol on GenLayer where you supply tGEN as
collateral and borrow tUSDC against it. The part I actually care about is where
the price comes from: my contract reads it live, on-chain, from an AMM pool that
belongs to a **different project in a different repository**, and when a position
goes bad it instructs that same pool to sell the collateral.

The two codebases share nothing. No imported package, no shared types, no
monorepo. One address stored in one storage slot is the entire integration
surface.

I'd already built and shipped my DEX aggregator on GenLayer — the tokens, the AMM
pools, the routing, the aggregator that picks the best pool. This project asks the
follow-up question: **can something else safely build on top of it?** Not by
forking it, not by vendoring it, but by treating it as live on-chain
infrastructure the way a real protocol would.

The answer is yes — but the mechanics are genuinely different from an EVM chain,
and that difference drove every design decision here.

- **Lending contract:** `0x604A423FB01b5a17D112360C0495685579767eDE`
- **Network:** GenLayer studionet (chain 61999)
- **Stack:** Python Intelligent Contracts · Next.js + genlayer-js frontend

---

## The constraint everything is built around

GenLayer gives a contract two ways to reach another contract, and they are not
symmetric:

| | behaviour | returns a value? |
|---|---|---|
| `view()` | **synchronous** — runs inside my transaction | yes, immediately |
| `emit()` | **asynchronous** — queues a message for a later consensus round | no, never |

There is no synchronous cross-contract **write**. That single fact is the whole
story.

Reading a price is easy: I call `quote_a_for_b` on the pool with `view()` and get
the number back in the same transaction, so my borrowing limits and health checks
are computed against a genuinely live price. But *acting* on another contract —
telling the pool to actually sell something — can only be queued. The swap runs
later, in its own round, and hands nothing back to me.

On Aave, liquidation is one atomic transaction: seize the collateral, swap it,
repay the debt, all or nothing. I can't write that here. So my liquidation is a
**three-transaction saga**:

```
Tx 1   liquidate(user)
       ├─ view()  → live quote from Pool #1 confirms the position is underwater
       ├─ seizes the borrower's entire collateral
       ├─ emit()  → transfer the collateral to the pool
       └─ emit()  → swap it, proceeds addressed back to me
                    (returns nothing — I get no proceeds in this transaction)

Tx 2   the pool's own consensus round
       └─ the swap executes and sends tUSDC to my contract

Tx 3   settle_liquidation(liq_id)
       ├─ books the tUSDC balance increase as the proceeds
       ├─ repays the borrower's debt with them
       └─ marks the id settled, releases the lock
```

I designed it as an explicit saga rather than pretending the swap is instant,
because pretending would produce a contract that silently loses money the first
time a child message is delayed. Which is exactly what happened on my first
settlement attempt — and the guard caught it.

### Why settlement is a reconcile, not a callback

The obvious design is for the pool to call me back when the swap lands. I
deliberately didn't do that, because it would mean editing the DEX repo to teach
it about a protocol it shouldn't know exists — and the decoupling is the entire
point of this build.

So settlement pulls instead of being pushed. Once the swap finalizes, anyone can
call `settle_liquidation(liq_id)`, and the contract measures its own tUSDC balance
against what it has already booked. The difference is the proceeds. The DEX repo
has zero lines of code about lending, and I never touched it.

---

## What the contract does

This is the source of truth and it matches `contracts/lending.py` exactly. If a
behaviour isn't described here, it isn't implemented.

### Collateral, debt, and pricing

Collateral is tGEN. Debt is tUSDC. Collateral is valued by calling
`quote_a_for_b` on Pool #1 — a live constant-product quote with the pool's 0.30%
fee applied, computed from its current reserves. There is no stored price, no
oracle, and no hardcoded rate anywhere in this contract.

### Custody is push-based

The tokens I wrote for the DEX are **transfer-only** — there is no
`approve`/`transferFrom` in them at all. So supplying, repaying and funding each
take two transactions:

1. you transfer the tokens to the lending contract
2. you call `supply()` / `repay()` / `fund()`, and the contract credits you only
   for the balance increase it can actually observe

This mirrors the push model my AMM pool already uses for swaps and liquidity
seeding, so the two protocols behave consistently.

### Payouts are asynchronous

`borrow()` and `withdraw()` record the state change immediately and send tokens
with `emit().transfer(...)`. The tokens arrive after that child message finalizes
— one consensus round later. **Your debt exists before your money does.** That
asymmetry is inherent to the platform, not a shortcut on my part.

### Method reference

| method | type | what it does |
|---|---|---|
| `live_collateral_value(amount)` | view | live tUSDC value of `amount` tGEN, read cross-contract from Pool #1 |
| `max_borrow(user)` | view | remaining borrowing power — 75% of live collateral value, minus existing debt |
| `is_liquidatable(user)` | view | true when debt exceeds 80% of live collateral value |
| `get_collateral` / `get_debt` | view | per-user position |
| `get_tracked_collateral` / `get_tracked_liquidity` | view | protocol-wide booked balances |
| `get_liq_pending` | view | whether a liquidation is awaiting settlement |
| `fund(amount)` | write | books transferred tUSDC as lendable liquidity (permissionless) |
| `supply(amount)` | write | books transferred tGEN as your collateral |
| `borrow(amount)` | write | records debt, emits the tUSDC payout; enforces 75% LTV against a live quote |
| `repay(amount)` | write | books transferred tUSDC against your debt |
| `withdraw(amount)` | write | emits collateral back; re-checks LTV against a fresh quote first |
| `liquidate(user)` | write | permissionless; seizes collateral, emits transfer + swap with a 3% slippage guard |
| `settle_liquidation(liq_id)` | write | permissionless; books proceeds, clears debt, releases the lock — idempotent |
| `set_trusted_dex` / `set_trusted_pool` | write | owner-only; lets me repoint at redeployed DEX contracts without redeploying this one |

### Risk parameters, as deployed

- **Loan-to-value: 75%** (`ltv_bps = 7500`) — the most you can borrow against your
  collateral's live value
- **Liquidation threshold: 80%** (`liquidation_bps = 8000`) — past this, anyone can
  liquidate you
- **Slippage guard: 3%** — a liquidation swap must return at least 97% of the quote
  taken at trigger time, or it fails rather than dumping at any price

---

## What it does *not* do

I'd rather state these than let anyone infer features that aren't there.

- **No interest.** Debt repaid equals debt borrowed. Nothing accrues.
- **No yield and no LP shares.** Whoever funds the protocol earns nothing, and
  funded liquidity cannot be withdrawn in this version.
- **No liquidator bonus.** Triggering a liquidation pays nothing. In a real
  protocol that incentive is what makes liquidations happen at all; here it's out
  of scope.
- **Full-position liquidations only.** No partial liquidations.
- **Surplus is not refunded.** If the collateral sells for more than the debt, the
  excess stays with the protocol as liquidity. The borrower doesn't get it back.
- **The aggregator is recorded but never called.** The contract stores my DEX
  aggregator's address in `trusted_dex` and the owner can update it, but **no
  method in this version reads it**. All pricing and all execution go through
  Pool #1 directly. Routing liquidations through the aggregator's best-pool
  selection is the natural next step — it is not something I'm claiming today.
- **No AI.** GenLayer's `gl.nondet` LLM and web-access features are not used here.
  This protocol is entirely deterministic. I have a design for an AI risk gate that
  would judge market conditions before liquidating, but a design isn't a feature,
  so it isn't in the contract.

---

## How I built it, and what I verified

I built this in three milestones, each one deployed and proven on-chain before I
started the next. Every number below came from a real transaction on studionet.

### M1 — prove the cross-contract read

Before writing a single line of lending logic, I deployed a contract whose only
job was to call the pool. If that didn't work, nothing else was worth building.

```
genlayer call 0xF87A552bEb72ea870CB17732421744E4374Bbb44 live_collateral_value --args 100
→ 68
```

That 68 is Pool #1's live constant-product quote, fee included, against reserves
my own earlier DEX swaps had already moved. Not a mock, not a constant — a
synchronous cross-contract call into a separately deployed protocol.

### M2 — custody, borrowing, and the async payout

With pricing proven, I added supply/borrow/repay/withdraw/fund on the push custody
model. The smoke test:

| step | result |
|---|---|
| supply 100 tGEN | booked |
| `fund(50)` | → 50 |
| `max_borrow` | → **51** (exactly 75% of the live 68 quote) |
| `borrow(30)` | → 30 |
| `get_debt` | → 30 |
| `get_tracked_liquidity` | → 20 |

The borrow receipt is where the async model became visible for the first time —
the queued child message paying out the tokens:

```json
"messages": [
  { "recipient": "0xa04E4F945d941eD491C194E2BD29A4da06c37f07",
    "data": "…method transfer…",
    "onAcceptance": false }
]
```

That's the same machinery the liquidation saga would need, working.

### M3 — the liquidation saga

To test liquidation I had to manufacture a crash, which meant using my own DEX
against my own lending protocol: I dumped 300 tGEN into Pool #1, which moved the
reserves enough to push the collateral's value below the 80% floor.

| step | result |
|---|---|
| `is_liquidatable` after the dump | → **true** |
| `liquidate(user)` | collateral seized (`get_collateral` → 0), transfer + swap emitted |
| the pool's round | swap delivered **44** tUSDC into my contract |
| first `settle_liquidation(0)` | **reverted on its own guard** — the swap hadn't finalized yet |
| retry | → repaid 38 |

Final state:

| after settlement | value |
|---|---|
| borrower debt | **0** |
| borrower collateral | **0** |
| protocol liquidity | **56** |
| liquidation pending | **false** |

The early-settlement revert is my favourite part of this build. Consensus accepted
the transaction, the `proceeds > 0` assert fired, **no state changed**, and the
retry a few minutes later settled cleanly. That's the idempotency and guard
discipline doing exactly what an asynchronous saga needs it to do.

### The frontend

The UI is a Next.js app talking to the deployed contract, and every flow in it has
been exercised against studionet: supply, borrow, repay, withdraw, fund, liquidate
and settle.

The page is laid out as a **schematic**, because the wiring is the story. The
element at the top is a live wire running from my lending contract to Pool #1 with
the current cross-contract quote flowing across it, and the liquidation panel shows
the saga's three real stages — trigger, sell, settle — rather than hiding a
multi-round process behind a spinner.

Reads all happen server-side in a Node API route and are cached for 15 seconds,
with no background polling. That's not an optimization; it's a requirement (see
Engineering notes).

---

## Running it

### Contracts

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
liquidation_bps)`. Address arguments **must** use the `addr#` form.

### Frontend

```bash
cd web
npm install
npm run build     # always build before deploying — dev skips type-checking
npm run dev
```

On Vercel, set the Root Directory to `web`.

### Deployed addresses

| contract | address | repo |
|---|---|---|
| LendingProtocol | `0x604A423FB01b5a17D112360C0495685579767eDE` | this |
| Pool #1 (tGEN/tUSDC, 30bps) | `0x6A732A632972fC3cF8a76b3CfeE3356C549c761C` | DEX |
| DEX aggregator | `0x9D5D33AF40781B6A41E3865df7B9bEF36adc6005` | DEX |
| tGEN | `0xd978F743Ce2Bad27c00A329F44f8F16b401F556C` | DEX |
| tUSDC | `0xa04E4F945d941eD491C194E2BD29A4da06c37f07` | DEX |

Earlier milestone deployments are still on-chain: `0xF87A…bb44` (M1, read-only
spike) and `0x41Aa…C656` (M2, before liquidation).

---

## Known limitations

These are real. I'd rather write them down than have someone find them.

**Child message ordering.** `liquidate()` emits the collateral transfer and the
swap as two separate messages and assumes they execute in that order. If the swap
ran first it would fail its own receipt check and the collateral would sit at the
pool awaiting manual recovery. Ordering has held on every run, but I'm relying on
it rather than enforcing it.

**One liquidation at a time.** Settlement identifies proceeds by measuring the
contract's own balance delta, so a global lock permits only one pending
liquidation. A `repay()` landing in that window would be counted into the
settlement. Prompt settlement keeps the window small; it doesn't eliminate it.

**studionet simulates consensus.** The appeal window and message re-execution
aren't exercised the way a real network would exercise them. I wrote settlement to
be idempotent and to check `gl.message.sender_address` regardless — but I can't
claim those paths are battle-tested on this network.

**Amounts are raw u256 units.** The contract is decimal-agnostic and the UI says so
rather than displaying converted token amounts. Pool #1 is seeded at 18-decimal
scale, so raw-unit positions are microscopic next to pool depth — fine for
demonstrating mechanics, not a realistic position size.

**The liquidate button targets your own address**, since this is a single-wallet
demo.

**studionet constraints.** 500 RPC requests per hour, and the network can be reset.
If reserves or balances look wrong, that's the likeliest cause.

---

## Engineering notes

Seven things that cost me real time on this build. They'd cost anyone else the
same.

**`Depends` must be the pinned GenVM hash.** Using the documentation's
`py-genlayer:test` got my contract rejected as `invalid_contract` before the
constructor ever ran. The header that works is the pinned hash my DEX contracts
already used: `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`.

**Consensus success is not execution success.** A transaction can reach `ACCEPTED`
with all five validators voting `AGREE` while its `execution_result` is `ERROR` —
the committee agreeing that the contract *failed*. A deploy script checking only
`status_name` will report a successful deployment of a contract that doesn't exist.
Always read `execution_result`. Every confusing hour of this build traced back to
this one behaviour.

**Address arguments are not hex strings.** Passing an address as a string kills the
constructor with `AttributeError: 'str' object has no attribute 'as_bytes'`. The
CLI's `addr#` form handles it; in JavaScript you need a real `CalldataAddress` built
from 20 raw bytes.

**The CLI bundles its own copy of genlayer-js.** A `CalldataAddress` constructed
from my project's `node_modules` is a different class from the one the CLI's
encoder expects, and it's rejected with `invalid calldata input '[object Object]'`.
The CLI also caches deploy scripts as `*.compiled.js` and will happily re-run a
stale compile while you edit the `.ts` next to it. Direct CLI deployment with
`addr#` sidesteps both.

**Browser reads don't work against hosted studionet.** `readContract` returns data
the SDK doesn't decode in the browser, and studionet sends no CORS headers. Every
read in this app runs server-side in a Node route; only signing happens in the
browser. Writes go through a same-origin RPC proxy for the same reason.

**`args` needs a cast in TypeScript.** The SDK types `args` as
`CalldataEncodable[]`, so helper functions accepting `unknown[]` fail type-checking
— and only `npm run build` catches it, never `npm run dev`.

**.NET file methods ignore PowerShell's working directory.**
`[System.IO.File]::ReadAllText` resolves relative paths against the process's own
directory, not wherever you've `cd`'d. Use absolute paths or your edit silently
writes nowhere and you debug a file you never changed.

---

## What's next

- Route liquidations through the aggregator's `best_pool` selection instead of a
  single hardcoded pool — the aggregator address is already wired in, it just isn't
  read yet.
- Add the `gl.nondet` risk gate: fetch off-chain volatility and news, let the
  validator committee agree on whether conditions favour liquidating now, and keep
  every number the LLM touches out of the accounting. This is the piece that would
  make the protocol genuinely GenLayer-native rather than a port of an EVM design.
- Interest accrual, partial liquidations, and a liquidator incentive — the three
  things that separate this from a protocol someone could actually use.

---

Built by Alpha — [@Asuzu_a](https://x.com/Asuzu_a) ·
[github.com/Afghanistan8](https://github.com/Afghanistan8)
