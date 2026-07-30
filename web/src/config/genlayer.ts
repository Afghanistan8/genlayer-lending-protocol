// GenLayer client setup for studionet.
//
// Two things here that are easy to get wrong:
//  1. Address ARGUMENTS must be passed as CalldataAddress (20 raw bytes), not
//     as hex strings. A plain string fails with "Missing or invalid parameters
//     / execution failed". This matches what the genlayer CLI sends.
//  2. Browser RPC is proxied through our own /api/rpc route to dodge CORS.

import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { CalldataAddress } from "genlayer-js/types";

/** Convert a 0x hex address into the calldata address type the VM expects. */
export function addr(hex: string): CalldataAddress {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return new CalldataAddress(bytes);
}

/** Minimal EIP-1193 provider shape. */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
};

/**
 * By default genlayer-js signs via the GLOBAL window.ethereum, which with
 * several wallet extensions installed may be a DIFFERENT wallet than the one
 * the user picked in RainbowKit. The SDK's client config accepts a `provider`
 * override (verified in its source: config.provider || window.ethereum), so we
 * pass the ACTIVE wagmi connector's provider through — signing then follows
 * the user's actual choice (MetaMask, OKX, Phantom, ...).
 *
 * Wallet authorization is also per-origin, so before signing we request
 * account access on that same provider and confirm it holds the address.
 */
export async function ensureWalletAuthorized(
  address: string,
  provider?: Eip1193Provider
): Promise<void> {
  const eth =
    provider ??
    (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!eth) throw new Error("No wallet found in this browser.");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const ok = accounts?.some((a) => a.toLowerCase() === address.toLowerCase());
  if (!ok) {
    throw new Error(
      `The selected wallet is not connected as ${address.slice(0, 6)}…${address.slice(-4)}. ` +
      "Switch to that account in your wallet and try again."
    );
  }
}

function proxyEndpoint(): string {
  if (typeof window !== "undefined") return `${window.location.origin}/api/rpc`;
  return "/api/rpc";
}

/** Server-side read client — talks to studionet directly (no CORS in Node). */
export function getServerClient() {
  return createClient({ chain: studionet });
}

/** Browser write client — the chosen wallet signs, RPC goes through our proxy. */
export function getWriteClient(address: string, provider?: Eip1193Provider) {
  // `provider` is honored by the SDK at runtime (config.provider) but is not
  // yet declared in its published types, hence the cast.
  return createClient({
    chain: studionet,
    account: address as `0x${string}`,
    endpoint: proxyEndpoint(),
    ...(provider ? { provider } : {}),
  } as never);
}
