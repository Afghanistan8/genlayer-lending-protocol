# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
LendingProtocol v6 - collateralized lending whose credit limits and liquidation
threshold are settled by the GenLayer validator committee.

WHAT MAKES THIS A GENLAYER PROTOCOL (not a port of an EVM design):
  assess_risk() runs a NON-DETERMINISTIC block. Validators are each shown the
  same on-chain market facts and must independently judge market stress, then
  reach consensus on ONE verdict: CALM / CAUTION / STRESS / CRISIS.
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
  The committee returns a LABEL only. The haircut for each label is a fixed
  table in deterministic Python, and all arithmetic (health factors, debt,
  proceeds, settlement) is ordinary deterministic code. The LLM decides POLICY;
  it never produces a number that has to reconcile.

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
    liq_min_out: TreeMap[u256, u256]
    settled: TreeMap[u256, bool]
    # ---- validator-settled risk state ----
    risk_tier: str            # "" until first assessment
    risk_haircut_bps: u256    # applied to collateral value
    risk_note: str            # committee's one-line rationale
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
        self.risk_tier = ""
        self.risk_haircut_bps = 0
        self.risk_note = ""
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
    # conditions. The facts shown to validators are gathered deterministically
    # from on-chain state so every validator judges the SAME evidence; what they
    # must agree on is the JUDGEMENT, which is inherently subjective.
    @gl.public.write
    def assess_risk(self) -> str:
        facts = self._market_facts()

        def _judge() -> str:
            return facts

        verdict = gl.eq_principle.prompt_non_comparative(
            _judge,
            task=(
                "You are the risk committee of a lending protocol. From the "
                "market report, classify current conditions for the collateral "
                "asset. Answer with EXACTLY ONE word: CALM, CAUTION, STRESS or "
                "CRISIS."
            ),
            criteria=(
                "CALM: price stable and liquidity deep relative to protocol "
                "exposure. CAUTION: mild price decline or moderate borrowing "
                "against available liquidity. STRESS: clear price decline, or "
                "collateral large relative to pool depth so liquidating it "
                "would move the price against the protocol. CRISIS: severe "
                "price decline or collateral that dwarfs pool liquidity. "
                "Judge conservatively: when the evidence is ambiguous choose "
                "the safer, more cautious tier."
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
        self.risk_note = facts
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
        # Order matters: check the most severe first so a longer answer that
        # mentions several tiers resolves to the most cautious one.
        if "CRISIS" in v:
            return "CRISIS"
        if "STRESS" in v:
            return "STRESS"
        if "CAUTION" in v:
            return "CAUTION"
        if "CALM" in v:
            return "CALM"
        # Unreadable answer must never silently become "safe".
        raise Exception("risk committee returned an unusable verdict")

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

        # Slippage guard is set against the RAW quote, because that is what the
        # pool will actually pay; the haircut governs solvency policy, not
        # execution price.
        min_out = (raw_quote * u256(97)) // u256(100)
        liq_id = self.next_liq_id
        self.next_liq_id = liq_id + u256(1)
        self.liq_user[liq_id] = user
        self.liq_collateral[liq_id] = collat
        self.liq_min_out[liq_id] = min_out
        self.liq_pending = True

        self.collateral_of[user] = u256(0)
        self.tracked_collateral = self.tracked_collateral - collat

        gl.get_contract_at(self.collateral_token).emit().transfer(self.trusted_pool, collat)
        Pool(self.trusted_pool).emit().swap_a_for_b(collat, min_out, self.address)
        return liq_id

    @gl.public.write
    def settle_liquidation(self, liq_id: u256) -> u256:
        assert self.liq_pending, "no liquidation pending"
        assert not self.settled.get(liq_id, False), "already settled"
        user = self.liq_user.get(liq_id, Address(b"\x00" * 20))

        proceeds = gl.get_contract_at(self.debt_token).view().balance_of(self.address) - self.tracked_liquidity
        assert proceeds > u256(0), "proceeds not arrived yet - swap not finalized"

        debt = self.debt_of.get(user, u256(0))
        repaid = proceeds if proceeds < debt else debt
        self.debt_of[user] = debt - repaid
        self.tracked_liquidity = self.tracked_liquidity + proceeds

        self.settled[liq_id] = True
        self.liq_pending = False
        return repaid
