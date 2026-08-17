# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
LendingVault - per-user personal token escrow deployed via CREATE2 by the
LendingProtocol contract, one per user.

Why this exists (the steward-driven attribution fix):
  When every user's tokens go to the SAME shared contract address (as they did
  in every earlier version of the lending protocol), the contract sees "the
  balance went up by X" and cannot tell whose transfer produced the increase.
  Every commit-reveal / ticket-queue / balance-delta variant is vulnerable to
  the same class of race: an earlier registrant can consume a later
  transfer that a different sender pushed in the same window, because the
  contract has no way to bind a specific transfer to its originator.

  The fix has to be architectural, not a heuristic on top of a shared address:
  each user's incoming tokens go to their OWN vault, deployed at a
  deterministic (CREATE2) address that only that user is ever expected to
  transfer into. Then "a transfer to Alice's vault" is Alice's, by definition,
  and no accounting on the lending side has to guess or race.

Custody model:
  - tokens intended as collateral, or as tUSDC to repay/fund, are transferred
    by the user into their vault (not into the lending contract's address)
  - lending READS the vault's balance to know what belongs to that user
  - lending is the ONLY caller allowed to instruct the vault to move tokens
    out (to the user's wallet on withdraw, to the pool on liquidation, to
    itself on repay/fund)
  - the vault has no per-caller state, no queues, no reconciliation - it just
    holds tokens for its owner and does exactly what lending tells it to do

Nothing else in the vault. Small on purpose so it stays cheap to deploy
per-user and easy to audit.
"""

from genlayer import *


class LendingVault(gl.Contract):
    owner: Address     # the user this vault holds tokens for
    lending: Address   # the LendingProtocol that deployed this vault

    def __init__(self, owner: Address, lending: Address):
        self.owner = owner
        self.lending = lending

    @gl.public.view
    def get_owner(self) -> Address:
        return self.owner

    @gl.public.view
    def get_lending(self) -> Address:
        return self.lending

    @gl.public.write
    def forward(self, token: Address, to: Address, amount: u256) -> None:
        """Send `amount` of `token` from this vault to `to`. Only the lending
        contract may call this - the vault will not move its owner's tokens
        for anyone else. Lending's own logic decides the destination (the
        owner's wallet on withdraw, the pool on liquidation, itself on
        repay/fund) - the vault does not police the destination beyond
        trusting lending."""
        assert gl.message.sender_address == self.lending, "only lending"
        gl.get_contract_at(token).emit().transfer(to, amount)
