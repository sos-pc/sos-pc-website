import type { Handler, HandlerEvent } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import {
  API_KEY,
  normalizeUrl,
  isPrivateUrl,
  checkRateLimit,
  getCached,
} from "./_audit-core.js";

// Sync entry point. Responsibilities:
//   1. Validate input (HTTP method, URL, private hosts).
//   2. Rate-limit by IP.
//   3. Return cached result inline when available (fast path).
//   4. Otherwise mint a jobId, mark it pending in the blob store, kick off
//      the background function asynchronously, and return 202 + jobId.
//
// All long-running work happens in audit-background.ts. The client polls
// audit-status.ts with the jobId until it sees "done" or "error".

const JOB_STORE = "audit-jobs";
const JOB_TTL_MS = 15 * 60 * 1000;

function getClientIp(event: HandlerEvent): string {
  const headers = event.headers || {};
  return (
    (headers["x-nf-client-connection-ip"] as string) ||
    ((headers["x-forwarded-for"] as string) || "").split(",")[0].trim() ||
    "unknown"
  );
}

function generateJobId(): string {
  // 16 bytes of randomness, encoded as 32 hex chars. Server-side only,
  // so we don't need crypto.subtle here — the ID is just an opaque
  // correlation key (not a security boundary).
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "PAGESPEED_API_KEY not configured" }),
    };
  }

  const ip = getClientIp(event);
  if (!checkRateLimit(ip)) {
    return {
      statusCode: 429,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Trop de requêtes. Réessayez dans une heure." }),
    };
  }

  let url: string;
  let competitorUrl: string | null = null;
  try {
    const body = JSON.parse(event.body || "{}");
    url = normalizeUrl(body.url || "");
    if (!url || url.length < 8) throw new Error("URL invalide");
    if (isPrivateUrl(url)) throw new Error("URL privée non autorisée");
    if (body.competitorUrl) {
      const raw = normalizeUrl(String(body.competitorUrl));
      if (!isPrivateUrl(raw) && raw.length >= 8) competitorUrl = raw;
    }
  } catch (e: any) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: e.message || "URL invalide" }),
    };
  }

  // Fast path: in-memory cache hit returns inline (no polling round-trip).
  const cached = getCached(url);
  if (cached) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json", "X-Cache": "HIT" },
      body: JSON.stringify({ status: "done", result: cached }),
    };
  }

  // Slow path: spawn the background function and let the client poll.
  const jobId = generateJobId();
  const store = getStore(JOB_STORE);

  await store.setJSON(jobId, {
    status: "pending",
    url,
    competitorUrl,
    createdAt: Date.now(),
    expiresAt: Date.now() + JOB_TTL_MS,
  });

  // Fire-and-forget the background invocation. Netlify routes any function
  // suffixed with -background asynchronously, so this fetch returns 202
  // almost immediately while the worker keeps running for up to 15 min.
  const host = event.headers["host"] || "";
  const proto = (event.headers["x-forwarded-proto"] as string) || "https";
  const bgUrl = `${proto}://${host}/.netlify/functions/audit-background`;

  // We intentionally do not await the body — only the connection setup.
  // Awaiting the response would defeat the point of a background function.
  fetch(bgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, url, competitorUrl }),
  }).catch((err) => {
    // Background trigger failures are written to the blob so the poller
    // can surface a useful error to the user instead of timing out.
    console.error("Failed to trigger audit-background", err);
    void store.setJSON(jobId, {
      status: "error",
      error: "Impossible de démarrer l'analyse en arrière-plan.",
      finishedAt: Date.now(),
    });
  });

  return {
    statusCode: 202,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ status: "pending", jobId }),
  };
};

export { handler };
