# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
LendingProtocol v3 (M3) - collateralized lending with deterministic liquidation,
interoperating with the separately-deployed DEX stack (studionet).

What this contract actually does (source of truth):
  - collateral tGEN, debt tUSDC; collateral valued via live cross-contract
    quote from the trusted Pool (quote_a_for_b)
  - PUSH custody (transfer first, then supply()/repay()/fund(); receipt
    verified by balance delta). No approve/allowance exists anywhere.
  - borrow()/withdraw() pay out via async emit().transfer (tokens arrive
    after finalization of the child message)
  - ZERO interest. No LP shares, no yield, no funded-liquidity withdrawal.
  - LIQUIDATION (this version):
      * full-position only (no partial liquidations)
      * permissionless trigger: anyone may call liquidate(user) when
        debt * 10000 > collateral_value * liquidation_bps
      * no liquidation bonus/incentive is paid to the caller
      * liquidate() seizes the entire collateral, emits two child messages:
        (1) transfer of the collateral to the Pool, (2) swap_a_for_b with a
        3% slippage guard (min_out = 97% of the quote at trigger time),
        proceeds addressed back to this contract
      * settlement is a separate, permissionless reconcile step:
        settle_liquidation(liq_id) books the contract's tUSDC balance delta
        as proceeds, repays the borrower's debt with it, and retains ANY
        surplus as protocol liquidity (surplus is NOT refunded to the
        borrower in this version)
      * idempotent: a liquidation id settles at most once
      * only ONE liquidation may be pending at a time (global lock) —
        this keeps the balance-delta settlement unambiguous
  - KNOWN LIMITATIONS (by design, documented, not bugs):
      * the two child messages are assumed to execute in emission order
        (transfer before swap); the swap fails safely if not, and the
        collateral then sits at the pool pending manual recovery
      * a repay() that lands between liquidate() and settle_liquidation()
        would be counted into the settlement delta; the single-pending
        lock plus prompt settlement keeps this window small in practice
Do not claim interest, LP yield, partial liquidations, liquidation bonuses,
or surplus refunds in any README/UI unless that code is added here first.
"""

from genlayer import *


@gl.contract_interface
class Pool:
    class View:
        def quote_a_for_b(self, amount_in: u256) -> u256: ...
    class Write:
        def swap_a_for_b(self, amount_in: u256, min_out: u256, to: Address) -> u256: ...


class LendingProtocol(gl.Contract):
    owner: Address
    trusted_dex: Address
    trusted_pool: Address
    collateral_token: Address       # tGEN
    debt_token: Address             # tUSDC
    ltv_bps: u256                   # 7500 = 75%
    liquidation_bps: u256           # 8000 = 80%
    collateral_of: TreeMap[Address, u256]
    debt_of: TreeMap[Address, u256]
    tracked_collateral: u256
    tracked_liquidity: u256
    # ---- liquidation saga state ----
    next_liq_id: u256
    liq_pending: bool               # global single-pending lock
    liq_user: TreeMap[u256, Address]
    liq_collateral: TreeMap[u256, u256]
    liq_min_out: TreeMap[u256, u256]
    settled: TreeMap[u256, bool]

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

    # ---------------- owner wiring ----------------
    @gl.public.write
    def set_trusted_dex(self, dex: Address) -> None:
        assert gl.message.sender_address == self.owner, "only owner"
        self.trusted_dex = dex

    @gl.public.write
    def set_trusted_pool(self, pool: Address) -> None:
        assert gl.message.sender_address == self.owner, "only owner"
        self.trusted_pool = pool

    # ---------------- views ----------------
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
        return Pool(self.trusted_pool).view().quote_a_for_b(amount)

    @gl.public.view
    def max_borrow(self, user: Address) -> u256:
        collat = self.collateral_of.get(user, u256(0))
        if collat == u256(0):
            return u256(0)
        value = Pool(self.trusted_pool).view().quote_a_for_b(collat)
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
        collat = self.collateral_of.get(user, u256(0))
        value = Pool(self.trusted_pool).view().quote_a_for_b(collat)
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

    # ---------------- borrow (async payout) ----------------
    @gl.public.write
    def borrow(self, amount: u256) -> u256:
        assert amount > u256(0), "amount must be positive"
        user = gl.message.sender_address
        collat = self.collateral_of.get(user, u256(0))
        assert collat > u256(0), "no collateral supplied"
        assert amount <= self.tracked_liquidity, "insufficient protocol liquidity"
        value = Pool(self.trusted_pool).view().quote_a_for_b(collat)
        new_debt = self.debt_of.get(user, u256(0)) + amount
        assert new_debt * u256(10000) <= value * self.ltv_bps, "exceeds LTV limit"
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

    # ---------------- withdraw collateral (async payout) ----------------
    @gl.public.write
    def withdraw(self, amount: u256) -> u256:
        assert amount > u256(0), "amount must be positive"
        user = gl.message.sender_address
        collat = self.collateral_of.get(user, u256(0))
        assert amount <= collat, "amount exceeds supplied collateral"
        remaining = collat - amount
        debt = self.debt_of.get(user, u256(0))
        if debt > u256(0):
            value = Pool(self.trusted_pool).view().quote_a_for_b(remaining)
            assert debt * u256(10000) <= value * self.ltv_bps, "withdrawal would breach LTV"
        self.collateral_of[user] = remaining
        self.tracked_collateral = self.tracked_collateral - amount
        gl.get_contract_at(self.collateral_token).emit().transfer(user, amount)
        return remaining

    # ================= M3: liquidation saga =================
    # Tx1 (this method): verify underwater vs LIVE quote, seize collateral,
    # emit (1) collateral transfer to the pool, (2) the swap with a 3%
    # slippage guard, proceeds addressed back to this contract.
    # Returns the liquidation id to settle later.
    @gl.public.write
    def liquidate(self, user: Address) -> u256:
        assert not self.liq_pending, "another liquidation is pending settlement"
        debt = self.debt_of.get(user, u256(0))
        assert debt > u256(0), "no outstanding debt"
        collat = self.collateral_of.get(user, u256(0))
        assert collat > u256(0), "no collateral"
        quote = Pool(self.trusted_pool).view().quote_a_for_b(collat)
        assert debt * u256(10000) > quote * self.liquidation_bps, "position is healthy"

        min_out = (quote * u256(97)) // u256(100)   # 3% slippage guard
        liq_id = self.next_liq_id
        self.next_liq_id = liq_id + u256(1)
        self.liq_user[liq_id] = user
        self.liq_collateral[liq_id] = collat
        self.liq_min_out[liq_id] = min_out
        self.liq_pending = True

        # seize the full collateral position
        self.collateral_of[user] = u256(0)
        self.tracked_collateral = self.tracked_collateral - collat

        # child messages (assumed to execute in emission order):
        gl.get_contract_at(self.collateral_token).emit().transfer(self.trusted_pool, collat)
        Pool(self.trusted_pool).emit().swap_a_for_b(collat, min_out, self.address)
        return liq_id

    # Tx3 (permissionless reconcile): after the swap's child messages have
    # finalized, book the tUSDC balance delta as proceeds, repay the
    # borrower's debt, retain any surplus as protocol liquidity.
    @gl.public.write
    def settle_liquidation(self, liq_id: u256) -> u256:
        assert self.liq_pending, "no liquidation pending"
        assert not self.settled.get(liq_id, False), "already settled"
        user = self.liq_user.get(liq_id, Address(b"\x00" * 20))
        assert self.liq_user.get(liq_id, None) is not None, "unknown liquidation id"

        proceeds = gl.get_contract_at(self.debt_token).view().balance_of(self.address) - self.tracked_liquidity
        assert proceeds > u256(0), "proceeds not arrived yet - swap not finalized"

        debt = self.debt_of.get(user, u256(0))
        repaid = proceeds if proceeds < debt else debt
        self.debt_of[user] = debt - repaid
        # ALL proceeds (including any surplus beyond the debt) are retained
        # as protocol liquidity; surplus is not refunded in this version.
        self.tracked_liquidity = self.tracked_liquidity + proceeds

        self.settled[liq_id] = True
        self.liq_pending = False
        return repaid
