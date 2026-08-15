// Deployed studionet addresses.
//
// The lending protocol and the DEX live in SEPARATE repos and deployments.
// This file is the only link between them: addresses, nothing imported.

// LendingProtocol v7 — the risk committee now judges LIVE external sentiment
// (crypto Fear & Greed index, fetched via gl.nondet.web inside the eq_principle
// closure by each validator) alongside the on-chain evidence.
export const LENDING = "0xd46c828bDeB732cB1F3C1da9DEE61FA52eD74534";

/** Collateral token (tGEN). */
export const TGEN = "0xd978F743Ce2Bad27c00A329F44f8F16b401F556C";

/** Debt token (tUSDC). */
export const TUSDC = "0xa04E4F945d941eD491C194E2BD29A4da06c37f07";

/** AMM pool (tGEN/tUSDC, 30bps) — prices the collateral. */
export const POOL = "0x6A732A632972fC3cF8a76b3CfeE3356C549c761C";

/** Risk parameters, as deployed in the contract's constructor. */
export const LTV_BPS = 7500;          // 75% max loan-to-value
export const LIQUIDATION_BPS = 8000;  // 80% liquidation threshold

export function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Haircut applied at each verdict the validator committee can settle on. */
export const TIERS: Record<string, { haircut: number; blurb: string }> = {
  CALM: { haircut: 0, blurb: "Full market value recognized." },
  CAUTION: { haircut: 10, blurb: "10% of collateral value discounted." },
  STRESS: { haircut: 25, blurb: "25% discounted — borrowing power cut." },
  CRISIS: { haircut: 40, blurb: "40% discounted — severe conditions." },
};
