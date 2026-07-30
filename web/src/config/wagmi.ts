// Wagmi + RainbowKit configuration.
//
// Two deliberate choices here:
//
// 1. NO WalletConnect. RainbowKit's getDefaultConfig always wires up the
//    WalletConnect connector, which calls the WalletConnect Explorer API and
//    needs a real projectId from WalletConnect Cloud. Without one those
//    requests fail and surface as "Failed to fetch" in the console. This app
//    is used with browser-extension wallets, so we build the connector list
//    ourselves with injected wallets only — no external service, no error.
//
// 2. The chain RPC points at our own same-origin /api/rpc proxy. Wagmi does
//    background chain polling, and hitting studionet directly from the browser
//    is blocked by CORS.

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  phantomWallet,
  rabbyWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { defineChain } from "viem";

// In the browser this is always same-origin. The server-side value is only a
// placeholder (this app never makes wagmi RPC calls during SSR), but we keep it
// correct for production anyway.
const SSR_ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

const RPC_URL =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/rpc`
    : `${SSR_ORIGIN}/api/rpc`;

export const genlayerStudionet = defineChain({
  id: 61999,
  name: "GenLayer Studionet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: {
      name: "GenLayer Explorer",
      url: "https://genlayer-explorer.vercel.app",
    },
  },
  testnet: true,
});

// Injected/extension wallets only — no WalletConnect connector is created,
// so no WalletConnect network requests are ever made.
const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      // Extension wallets are detected via EIP-6963 and each exposes its own
      // provider, so signing follows the wallet the user actually picks.
      wallets: [metaMaskWallet, okxWallet, phantomWallet, rabbyWallet, injectedWallet],
    },
  ],
  { appName: "GenLayer DEX Aggregator", projectId: "unused" }
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [genlayerStudionet],
  transports: { [genlayerStudionet.id]: http(RPC_URL) },
  ssr: true,
  pollingInterval: 60_000,
});
