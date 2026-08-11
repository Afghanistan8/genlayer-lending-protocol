# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
LendingProtocol v7 - collateralized lending whose credit limits and liquidation
threshold are settled by the GenLayer validator committee.

WHAT MAKES THIS A GENLAYER PROTOCOL (not a port of an EVM design):
  assess_risk() runs a NON-DETERMINISTIC block. Each validator independently
  FETCHES A LIVE OFF-CHAIN SIGNAL - the crypto Fear & Greed index, over the web
  from api.alternative.me - and judges it together with the same on-chain market
  facts, then the committee reaches consensus on ONE verdict:
  CALM / CAUTION / STRESS / CRISIS.
  Because the external reading is live (it moves over time and between fetches)
  and the judgement is subjective, the validators are settling a genuine
  disagreement, not replaying identical inputs. This is meaningful GenLayer
  consensus, and it is impossible to reproduce on a deterministic chain.
  That verdict is CONSEQUENTIAL - it sets a collateral haircut which is applied
  to EVERY credit decision in the contract:
      - how much you may borrow          (max_borrow, borrow)
      - whether you may withdraw         (withdraw)
      - whether you may be liquidated    (is_liquidatable, liquidate)
  A CRISIS verdict cuts recognized collateral value by 40%, which shrinks
  borrowing power and can make an otherwise-healthy position liquidatable.
  Nothing about this is advisory or cosmetic: no credit decision in this
  contract can be made without a committee-settled verdict, and liquidate()
  refuses to run until one exists.

DISCIPLINE - where non-determinism is allowed to touch:
  The web fetch and LLM judgement happen ONLY inside the closure passed to
  gl.eq_principle.prompt_non_comparative. The committee returns a LABEL only.
  The haircut for each label is a fixed table in deterministic Python, and all
  arithmetic (health factors, debt, proceeds, settlement) is ordinary
  deterministic code. Every storage write, cross-contract call and emit() runs
  AFTER the non-deterministic block returns. The LLM decides POLICY; it never
  produces a number that has to reconcile.

Everything else is unchanged from v5 and remains the source of truth:
  - collateral tGEN, debt tUSDC; raw collateral valued by a live cross-contract
    view() quote from the trusted Pool
  - PUSH custody (transfer first, then supply()/repay()/fund(); receipt verified
    by balance delta). No approve/allowance exists.
  - borrow()/withdraw() pay out via async emit().transfer (tokens arrive after
    the child message finalizes)
  - ZERO interest. No LP shares, no yield, no withdrawal of funded liquidity.
  - liquidation: full-position only, no liquidator bonus, 3% slippage guard,
    surplus retained as protocol liquidity, permissionless reconcile settlement,
    single pending liquidation at a time, idempotent settle.
Do not claim interest, LP yield, partial liquidations, liquidation bonuses, or
surplus refunds in any README/UI unless that code is added here first.
"""

from genlayer import *

import json


# ================= LIVE EXTERNAL SENTIMENT (non-deterministic input) =========
# These two module-level helpers gather the off-chain evidence the validator
# committee judges. They are kept OUTSIDE the contract class on purpose: the
# eq_principle closure in assess_risk() captures only a plain string plus these
# module functions, so nothing about contract storage rides into the
# non-deterministic block.
def _parse_fear_greed(text: str) -> str:
    """Pure parser for the alternative.me Fear & Greed payload.

    Reads ONLY two fixed fields, range-checks the 0-100 score, and allowlists
    the classification label - so no free-form text from the feed ever reaches
    the LLM prompt (minimal prompt-injection surface). Returns 'unavailable' on
    any malformed input. Pure (no web, no gl) so it is directly unit-testable.
    """
    try:
        item = json.loads(text)["data"][0]
        value = int(str(item["value"]).strip())
        if value < 0 or value > 100:
            return "unavailable"
        label = str(item["value_classification"]).strip()
        known = ("Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed")
        safe = label if label in known else "Unknown"
        return "Fear & Greed index " + str(value) + "/100 (" + safe + ")"
    except Exception:
        return "unavailable"


def _fetch_fear_greed() -> str:
    """LIVE, NON-DETERMINISTIC external evidence: the crypto Fear & Greed index.

    Only ever invoked from inside the assess_risk() eq_principle closure, where
    EVERY validator fetches it independently - the value moves over time and
    between fetches, which is exactly what makes the committee's agreement a
    real consensus rather than a replay of identical inputs. A feed outage
    degrades to 'unavailable' (the committee then judges on on-chain facts
    alone) rather than bricking assess_risk().
    """
    try:
        resp = gl.nondet.web.get("https://api.alternative.me/fng/?limit=1")
        body = resp.body
        if not body:
            return "unavailable"
        return _parse_fear_greed(bytes(body).decode("utf-8", errors="replace"))
    except Exception:
        return "unavailable"


@gl.contract_interface
class Pool:
    class View:
        def quote_a_for_b(self, amount_in: u256) -> u256: ...
        def get_reserve_a(self) -> u256: ...
        def get_reserve_b(self) -> u256: ...
    class Write:
        def swap_a_for_b(self, amount_in: u256, min_out: u256, to: Address) -> u256: ...


class LendingProtocol(gl.Contract):
    owner: Address
    trusted_dex: Address
    trusted_pool: Address
    collateral_token: Address
    debt_token: Address
    ltv_bps: u256
    liquidation_bps: u256
    collateral_of: TreeMap[Address, u256]
    debt_of: TreeMap[Address, u256]
    tracked_collateral: u256
    tracked_liquidity: u256
    # ---- liquidation saga ----
    next_liq_id: u256
    liq_pending: bool
    liq_user: TreeMap[u256, Address]
    liq_collateral: TreeMap[u256, u256]
    liq_stage: u256                 # 1 transfer emitted, 2 swap emitted, 3 settled
    settled: TreeMap[u256, bool]
    # ---- validator-settled risk state ----
    risk_tier: str            # "" until first assessment
    risk_haircut_bps: u256    # applied to collateral value
    risk_note: str            # deterministic on-chain evidence put to the committee
    risk_signal: str          # committee's one-line ruling; cites the live feed it read
    risk_epoch: u256          # increments on every settled assessment
    risk_ref_price: u256      # quote observed at the last assessment

    # Reference size used to sample the pool price (raw units).
    PRICE_PROBE = u256(100)

    def __init__(
        self,
        dex: Address,
        pool: Address,
        collateral_token: Address,
        debt_token: Address,
        ltv_bps: u256,
        liquidation_bps: u256,
    ):
        self.owner = gl.message.sender_address
        self.trusted_dex = dex
        self.trusted_pool = pool
        self.collateral_token = collateral_token
        self.debt_token = debt_token
        self.ltv_bps = ltv_bps
        self.liquidation_bps = liquidation_bps
        self.tracked_collateral = 0
        self.tracked_liquidity = 0
        self.next_liq_id = 0
        self.liq_pending = False
        self.liq_stage = 0
        self.risk_tier = ""
        self.risk_haircut_bps = 0
        self.risk_note = ""
        self.risk_signal = ""
        self.risk_epoch = 0
        self.risk_ref_price = 0

    # ---------------- owner wiring ----------------
    @gl.public.write
    def set_trusted_dex(self, dex: Address) -> None:
        assert gl.message.sender_address == self.owner, "only owner"
        self.trusted_dex = dex

    @gl.public.write
    def set_trusted_pool(self, pool: Address) -> None:
        assert gl.message.sender_address == self.owner, "only owner"
        self.trusted_pool = pool

    # ================= NON-DETERMINISTIC RISK ASSESSMENT =================
    # Permissionless. Anyone may ask the validator committee to re-judge market
    # conditions. On-chain facts are gathered deterministically BEFORE the
    # non-deterministic block (cross-contract calls are forbidden inside it).
    # Inside the block, every validator independently fetches a LIVE off-chain
    # signal - the crypto Fear & Greed index - and judges it alongside those
    # facts. What they must agree on is the JUDGEMENT, which is subjective and
    # rests on live external data, so the consensus is genuine.
    @gl.public.write
    def assess_risk(self) -> str:
        facts = self._market_facts()          # cross-contract views: BEFORE the nondet block

        def _judge() -> str:
            # The ONLY non-deterministic step: a live web fetch, run
            # independently by the leader and by every validator.
            sentiment = _fetch_fear_greed()
            return "LIVE MARKET SENTIMENT: " + sentiment + "\nON-CHAIN EVIDENCE: " + facts

        verdict = gl.eq_principle.prompt_non_comparative(
            _judge,
            task=(
                "You are the risk committee of a lending protocol. You are given "
                "a LIVE crypto Fear & Greed sentiment reading (0 = extreme fear, "
                "100 = extreme greed) and on-chain market facts for the "
                "collateral asset. Weigh BOTH and classify current conditions. "
                "Answer on a SINGLE line as: <TIER> - <one short sentence citing "
                "the Fear & Greed number and the on-chain evidence>. TIER must be "
                "exactly one of: CALM, CAUTION, STRESS, CRISIS."
            ),
            criteria=(
                "Fear & Greed at or below ~25 (fear / extreme fear) signals a "
                "fragile market and should push toward STRESS or CRISIS, "
                "especially when collateral is large relative to pool depth or "
                "price is falling. Around 45-55 is neutral. High greed (>75) is "
                "NOT automatically calm - it can mask fragility, so do not relax "
                "when on-chain depth is thin. CALM: stable price, deep liquidity, "
                "non-extreme sentiment. CAUTION: mild price decline, moderate "
                "borrowing, or sentiment drifting fearful. STRESS: clear price "
                "decline, collateral large vs pool depth, or fearful sentiment. "
                "CRISIS: severe price decline, collateral dwarfing liquidity, or "
                "extreme-fear sentiment. If the sentiment reading is "
                "'unavailable', judge on the on-chain facts alone. When the "
                "evidence is ambiguous choose the safer, more cautious tier."
            ),
        )

        tier = self._normalize_tier(verdict)

        # Deterministic mapping. The committee chooses the LABEL; the protocol
        # chooses what the label costs.
        if tier == "CALM":
            haircut = u256(0)
        elif tier == "CAUTION":
            haircut = u256(1000)      # 10%
        elif tier == "STRESS":
            haircut = u256(2500)      # 25%
        else:
            haircut = u256(4000)      # 40%

        self.risk_tier = tier
        self.risk_haircut_bps = haircut
        self.risk_note = facts        # deterministic on-chain evidence
        self.risk_signal = verdict    # committee's ruling, cites the live sentiment it read
        self.risk_epoch = self.risk_epoch + u256(1)
        self.risk_ref_price = Pool(self.trusted_pool).view().quote_a_for_b(self.PRICE_PROBE)
        return tier

    def _market_facts(self) -> str:
        """Deterministic on-chain evidence, rendered for the committee."""
        pool = Pool(self.trusted_pool)
        price = pool.view().quote_a_for_b(self.PRICE_PROBE)
        reserve_collateral = pool.view().get_reserve_a()
        reserve_debt = pool.view().get_reserve_b()
        prev = self.risk_ref_price
        if prev == u256(0):
            move = "no previous reading"
        elif price < prev:
            move = "DOWN from " + str(prev) + " to " + str(price)
        elif price > prev:
            move = "UP from " + str(prev) + " to " + str(price)
        else:
            move = "unchanged at " + str(price)
        return (
            "Collateral price (per " + str(self.PRICE_PROBE) + " units): " + str(price)
            + ". Movement since last assessment: " + move
            + ". Pool depth: " + str(reserve_collateral) + " collateral / "
            + str(reserve_debt) + " debt-asset."
            + " Protocol holds " + str(self.tracked_collateral) + " collateral"
            + " and has " + str(self.tracked_liquidity) + " debt-asset lendable."
        )

    def _normalize_tier(self, verdict: str) -> str:
        v = verdict.strip().upper()
        # The committee is asked to LEAD with the tier word, so trust the first
        # token: it avoids mis-reading a rationale that merely mentions another
        # tier (e.g. "CALM - no CRISIS-level thinness").
        head = v.replace("—", " ").replace("-", " ").split()
        if head:
            for t in ("CRISIS", "STRESS", "CAUTION", "CALM"):
                if head[0] == t:
                    return t
        # Fallback: severity-first scan so a longer answer that mentions several
        # tiers still resolves to the most cautious one.
        if "CRISIS" in v:
            return "CRISIS"
        if "STRESS" in v:
            return "STRESS"
        if "CAUTION" in v:
            return "CAUTION"
        if "CALM" in v:
            return "CALM"
        # Unreadable answer must never silently become "safe".
        raise gl.vm.UserError("risk committee returned an unusable verdict")

    # ---------------- views ----------------
    @gl.public.view
    def get_risk_tier(self) -> str:
        return self.risk_tier

    @gl.public.view
    def get_risk_haircut_bps(self) -> u256:
        return self.risk_haircut_bps

    @gl.public.view
    def get_risk_note(self) -> str:
        return self.risk_note

    @gl.public.view
    def get_risk_signal(self) -> str:
        return self.risk_signal

    @gl.public.view
    def get_risk_epoch(self) -> u256:
        return self.risk_epoch

    @gl.public.view
    def get_collateral(self, user: Address) -> u256:
        return self.collateral_of.get(user, u256(0))

    @gl.public.view
    def get_debt(self, user: Address) -> u256:
        return self.debt_of.get(user, u256(0))

    @gl.public.view
    def get_tracked_liquidity(self) -> u256:
        return self.tracked_liquidity

    @gl.public.view
    def get_tracked_collateral(self) -> u256:
        return self.tracked_collateral

    @gl.public.view
    def get_liq_pending(self) -> bool:
        return self.liq_pending

    @gl.public.view
    def live_collateral_value(self, amount: u256) -> u256:
        """RAW market value, before the committee's haircut."""
        return Pool(self.trusted_pool).view().quote_a_for_b(amount)

    @gl.public.view
    def recognized_collateral_value(self, amount: u256) -> u256:
        """Value the protocol will actually lend against: market value reduced
        by the haircut the validator committee settled on."""
        raw = Pool(self.trusted_pool).view().quote_a_for_b(amount)
        return (raw * (u256(10000) - self.risk_haircut_bps)) // u256(10000)

    def _recognized(self, amount: u256) -> u256:
        raw = Pool(self.trusted_pool).view().quote_a_for_b(amount)
        return (raw * (u256(10000) - self.risk_haircut_bps)) // u256(10000)

    @gl.public.view
    def max_borrow(self, user: Address) -> u256:
        collat = self.collateral_of.get(user, u256(0))
        if collat == u256(0):
            return u256(0)
        value = self._recognized(collat)
        cap = (value * self.ltv_bps) // u256(10000)
        debt = self.debt_of.get(user, u256(0))
        if debt >= cap:
            return u256(0)
        return cap - debt

    @gl.public.view
    def is_liquidatable(self, user: Address) -> bool:
        debt = self.debt_of.get(user, u256(0))
        if debt == u256(0):
            return False
        value = self._recognized(self.collateral_of.get(user, u256(0)))
        return debt * u256(10000) > value * self.liquidation_bps

    # ---------------- liquidity provisioning (push) ----------------
    @gl.public.write
    def fund(self, amount: u256) -> u256:
        received = gl.get_contract_at(self.debt_token).view().balance_of(self.address) - self.tracked_liquidity
        assert received >= amount, "tUSDC not received: transfer amount to this contract first"
        self.tracked_liquidity = self.tracked_liquidity + amount
        return self.tracked_liquidity

    # ---------------- supply collateral (push) ----------------
    @gl.public.write
    def supply(self, amount: u256) -> u256:
        assert amount > u256(0), "amount must be positive"
        received = gl.get_contract_at(self.collateral_token).view().balance_of(self.address) - self.tracked_collateral
        assert received >= amount, "tGEN not received: transfer amount to this contract first"
        user = gl.message.sender_address
        self.collateral_of[user] = self.collateral_of.get(user, u256(0)) + amount
        self.tracked_collateral = self.tracked_collateral + amount
        return self.collateral_of[user]

    # ---------------- borrow (async payout, risk-gated) ----------------
    @gl.public.write
    def borrow(self, amount: u256) -> u256:
        assert amount > u256(0), "amount must be positive"
        assert self.risk_epoch > u256(0), "no risk assessment yet: call assess_risk() first"
        user = gl.message.sender_address
        collat = self.collateral_of.get(user, u256(0))
        assert collat > u256(0), "no collateral supplied"
        assert amount <= self.tracked_liquidity, "insufficient protocol liquidity"
        value = self._recognized(collat)          # committee-adjusted
        new_debt = self.debt_of.get(user, u256(0)) + amount
        assert new_debt * u256(10000) <= value * self.ltv_bps, "exceeds LTV limit at the current risk tier"
        self.debt_of[user] = new_debt
        self.tracked_liquidity = self.tracked_liquidity - amount
        gl.get_contract_at(self.debt_token).emit().transfer(user, amount)
        return new_debt

    # ---------------- repay (push) ----------------
    @gl.public.write
    def repay(self, amount: u256) -> u256:
        assert amount > u256(0), "amount must be positive"
        user = gl.message.sender_address
        debt = self.debt_of.get(user, u256(0))
        assert debt > u256(0), "no outstanding debt"
        assert amount <= debt, "amount exceeds outstanding debt"
        received = gl.get_contract_at(self.debt_token).view().balance_of(self.address) - self.tracked_liquidity
        assert received >= amount, "tUSDC not received: transfer amount to this contract first"
        self.debt_of[user] = debt - amount
        self.tracked_liquidity = self.tracked_liquidity + amount
        return self.debt_of[user]

    # ---------------- withdraw collateral (async payout, risk-gated) --------
    @gl.public.write
    def withdraw(self, amount: u256) -> u256:
        assert amount > u256(0), "amount must be positive"
        user = gl.message.sender_address
        collat = self.collateral_of.get(user, u256(0))
        assert amount <= collat, "amount exceeds supplied collateral"
        remaining = collat - amount
        debt = self.debt_of.get(user, u256(0))
        if debt > u256(0):
            assert self.risk_epoch > u256(0), "no risk assessment yet: call assess_risk() first"
            value = self._recognized(remaining)   # committee-adjusted
            assert debt * u256(10000) <= value * self.ltv_bps, "withdrawal would breach LTV at the current risk tier"
        self.collateral_of[user] = remaining
        self.tracked_collateral = self.tracked_collateral - amount
        gl.get_contract_at(self.collateral_token).emit().transfer(user, amount)
        return remaining

    # ================= liquidation saga (risk-gated) =================
    # DESIGN NOTE — why this is a step-at-a-time saga:
    #   GenLayer cross-contract writes are ASYNCHRONOUS messages. Two messages
    #   emitted from the same transaction are NOT guaranteed to execute in the
    #   order they were emitted. An earlier version emitted the collateral
    #   transfer and the swap together; the swap ran first, failed the pool's
    #   "token_a not received" check, and the collateral was left sitting at the
    #   pool while the debt stayed open.
    #   So this version emits exactly ONE message per transaction and VERIFIES
    #   its effect on-chain before emitting the next. advance_liquidation() is
    #   permissionless, idempotent per stage, and RETRIES a swap that did not
    #   take effect — so a failed leg is recoverable rather than terminal.
    #
    # Stages:  1 = collateral transfer emitted   2 = swap emitted   3 = settled

    @gl.public.write
    def liquidate(self, user: Address) -> u256:
        assert not self.liq_pending, "another liquidation is pending settlement"
        # A liquidation may only proceed on a committee-settled view of the
        # market. Without a verdict there is no recognized value, so there is
        # no basis to seize anyone's collateral.
        assert self.risk_epoch > u256(0), "no risk assessment yet: call assess_risk() first"
        debt = self.debt_of.get(user, u256(0))
        assert debt > u256(0), "no outstanding debt"
        collat = self.collateral_of.get(user, u256(0))
        assert collat > u256(0), "no collateral"

        raw_quote = Pool(self.trusted_pool).view().quote_a_for_b(collat)
        recognized = (raw_quote * (u256(10000) - self.risk_haircut_bps)) // u256(10000)
        assert debt * u256(10000) > recognized * self.liquidation_bps, "position is healthy at the current risk tier"

        liq_id = self.next_liq_id
        self.next_liq_id = liq_id + u256(1)
        self.liq_user[liq_id] = user
        self.liq_collateral[liq_id] = collat
        self.liq_stage = u256(1)
        self.liq_pending = True

        self.collateral_of[user] = u256(0)
        self.tracked_collateral = self.tracked_collateral - collat

        # ONE message only. The swap is emitted later, once this has landed.
        gl.get_contract_at(self.collateral_token).emit().transfer(self.trusted_pool, collat)
        return liq_id

    def _pool_unbooked_collateral(self) -> u256:
        """Collateral sitting at the pool that the pool has not yet booked into
        its reserves — i.e. our transfer landed but no swap consumed it."""
        held = gl.get_contract_at(self.collateral_token).view().balance_of(self.trusted_pool)
        booked = Pool(self.trusted_pool).view().get_reserve_a()
        if held <= booked:
            return u256(0)
        return held - booked

    def _advance(self, liq_id: u256) -> u256:
        assert self.liq_pending, "no liquidation pending"
        assert not self.settled.get(liq_id, False), "already settled"
        assert liq_id + u256(1) == self.next_liq_id, "not the pending liquidation id"
        collat = self.liq_collateral.get(liq_id, u256(0))

        # ---- stage 1: the collateral transfer must have landed at the pool ----
        if self.liq_stage == u256(1):
            unbooked = self._pool_unbooked_collateral()
            assert unbooked >= collat, "collateral has not reached the pool yet"
            self._emit_swap(collat)
            self.liq_stage = u256(2)
            return u256(0)

        # ---- stage 2: wait for proceeds; retry the swap if it did not take ----
        proceeds = gl.get_contract_at(self.debt_token).view().balance_of(self.address) - self.tracked_liquidity
        if proceeds == u256(0):
            # No proceeds. If the collateral is still sitting unbooked at the
            # pool, the swap did not take effect - emit it again.
            unbooked = self._pool_unbooked_collateral()
            assert unbooked >= collat, "swap has not settled yet - try again shortly"
            self._emit_swap(collat)
            return u256(0)

        user = self.liq_user.get(liq_id, Address(b"\x00" * 20))
        debt = self.debt_of.get(user, u256(0))
        repaid = proceeds if proceeds < debt else debt
        self.debt_of[user] = debt - repaid
        # ALL proceeds (including any surplus beyond the debt) are retained as
        # protocol liquidity; surplus is not refunded in this version.
        self.tracked_liquidity = self.tracked_liquidity + proceeds
        self.settled[liq_id] = True
        self.liq_stage = u256(3)
        self.liq_pending = False
        return repaid

    def _emit_swap(self, collat: u256) -> None:
        # min_out is recomputed from a FRESH quote each time. Storing it at
        # trigger time would let a stale figure make the swap permanently
        # unfillable after the price moves.
        quote = Pool(self.trusted_pool).view().quote_a_for_b(collat)
        min_out = (quote * u256(97)) // u256(100)
        Pool(self.trusted_pool).emit().swap_a_for_b(collat, min_out, self.address)

    @gl.public.write
    def advance_liquidation(self, liq_id: u256) -> u256:
        """Permissionless driver. Call repeatedly until it returns the repaid
        amount: it emits the swap once the collateral has arrived, retries a
        swap that did not take effect, and books the proceeds when they land."""
        return self._advance(liq_id)

    @gl.public.write
    def settle_liquidation(self, liq_id: u256) -> u256:
        """Kept as the name the app already calls; same self-healing driver."""
        return self._advance(liq_id)

    @gl.public.view
    def get_liq_stage(self) -> u256:
        return self.liq_stage

    @gl.public.view
    def get_pending_liq_id(self) -> u256:
        """The id of the liquidation currently awaiting settlement, or 0 when
        none is pending. The frontend's Settle/Advance buttons pass this so they
        target the right saga past the first-ever liquidation (_advance asserts
        liq_id + 1 == next_liq_id)."""
        if not self.liq_pending:
            return u256(0)
        return self.next_liq_id - u256(1)
