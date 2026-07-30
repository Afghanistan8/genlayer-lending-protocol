// Deployed studionet addresses.
//
// The lending protocol and the DEX live in SEPARATE repos and deployments.
// This file is the only link between them: addresses, nothing imported.

/** LendingProtocol (M3 — supply/borrow/repay/withdraw + liquidation saga). */
export const LENDING = "0x604A423FB01b5a17D112360C0495685579767eDE";

/** Collateral token (tGEN). */
export const TGEN = "0xd978F743Ce2Bad27c00A329F44f8F16b401F556C";

/** Debt token (tUSDC). */
export const TUSDC = "0xa04E4F945d941eD491C194E2BD29A4da06c37f07";

/** Pool #1 (tGEN/tUSDC, 30bps) — prices the collateral. */
export const POOL = "0x6A732A632972fC3cF8a76b3CfeE3356C549c761C";

/** DEX aggregator — wired into the lending contract as trusted_dex. */
export const AGGREGATOR = "0x9D5D33AF40781B6A41E3865df7B9bEF36adc6005";

/** Risk parameters, as deployed in the contract's constructor. */
export const LTV_BPS = 7500;          // 75% max loan-to-value
export const LIQUIDATION_BPS = 8000;  // 80% liquidation threshold

export const EXPLORER = "https://genlayer-explorer.vercel.app";

export function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
