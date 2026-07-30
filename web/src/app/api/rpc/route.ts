export const runtime = "nodejs";
// Server-side RPC proxy for GenLayer studionet.
//
// Why this exists: the studionet RPC does not send CORS headers, so calling it
// directly from the browser fails with "Failed to fetch". This route runs on
// the Next.js server (no CORS there), forwards the JSON-RPC body to studionet,
// and returns the response. The frontend points genlayer-js at THIS route.

import { studionet } from "genlayer-js/chains";

// Resolve the real studionet RPC URL from the SDK's chain definition, with
// fallbacks. Override with GENLAYER_RPC_URL if `genlayer network info` shows
// a different endpoint for studionet.
function upstreamUrl(): string {
  const fromEnv = process.env.GENLAYER_RPC_URL;
  if (fromEnv) return fromEnv;
  try {
    const http = (studionet as any)?.rpcUrls?.default?.http?.[0];
    if (http) return http;
  } catch { /* ignore */ }
  return "https://studio.genlayer.com/api";
}

export async function POST(req: Request) {
  const body = await req.text();
  try {
    const res = await fetch(upstreamUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: `proxy error: ${message}` }, id: null }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }
}

// Some clients send a GET to probe the endpoint; respond harmlessly.
export async function GET() {
  return new Response(JSON.stringify({ ok: true, upstream: upstreamUrl() }), {
    headers: { "content-type": "application/json" },
  });
}

