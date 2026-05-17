import type { Handler, HandlerEvent } from "@netlify/functions";
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
//
// Defensive design: every external call is caught locally and the whole
// handler is wrapped in a top-level try/catch so the runtime never bubbles
// an unhandled exception (which would surface as an opaque 502).

const JOB_STORE = "audit-jobs";
const JOB_TTL_MS = 15 * 60 * 1000;
const BG_TRIGGER_TIMEOUT_MS = 5 * 1000;

// Netlify Functions v1 does not auto-inject Blobs context — we pass siteID
// and token explicitly. These env vars are configured in the Netlify
// dashboard (Site settings → Environment variables).
const BLOBS_SITE_ID = process.env.BLOBS_SITE_ID;
const BLOBS_TOKEN = process.env.BLOBS_TOKEN;

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
    "Content-Type": "application/json",
  };
}

function jsonResponse(statusCode: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return {
    statusCode,
    headers: { ...corsHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

// Lazy-load the blobs SDK so any module-level error surfaces as a clean
// 500 inside the handler rather than crashing the function at cold start.
async function getJobStore() {
  if (!BLOBS_SITE_ID || !BLOBS_TOKEN) {
    throw new Error("BLOBS_SITE_ID or BLOBS_TOKEN env var is missing");
  }
  const { getStore } = await import("@netlify/blobs");
  return getStore({ name: JOB_STORE, siteID: BLOBS_SITE_ID, token: BLOBS_TOKEN });
}

const handler: Handler = async (event: HandlerEvent) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(), body: "" };
    }

    if (event.httpMethod !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    if (!API_KEY) {
      return jsonResponse(500, { error: "PAGESPEED_API_KEY not configured" });
    }

    const ip = getClientIp(event);
    if (!checkRateLimit(ip)) {
      return jsonResponse(429, { error: "Trop de requêtes. Réessayez dans une heure." });
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
      return jsonResponse(400, { error: e?.message || "URL invalide" });
    }

    // Fast path: in-memory cache hit returns inline (no polling round-trip).
    const cached = getCached(url);
    if (cached) {
      return jsonResponse(200, { status: "done", result: cached }, { "X-Cache": "HIT" });
    }

    // Slow path: spawn the background function and let the client poll.
    let store;
    try {
      store = await getJobStore();
    } catch (err: any) {
      console.error("getStore failed", err);
      const detail = !BLOBS_SITE_ID || !BLOBS_TOKEN
        ? "BLOBS_SITE_ID et BLOBS_TOKEN doivent être configurés dans les variables d'environnement Netlify."
        : "Stockage des jobs indisponible.";
      return jsonResponse(500, { error: detail });
    }

    const jobId = generateJobId();

    try {
      await store.setJSON(jobId, {
        status: "pending",
        url,
        competitorUrl,
        createdAt: Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS,
      });
    } catch (err: any) {
      console.error("blob setJSON (pending) failed", err);
      return jsonResponse(500, {
        error: "Impossible d'enregistrer le job. Réessayez dans un instant.",
      });
    }

    // Trigger the background function. Netlify always returns 202 quickly
    // for *-background.ts routes, so awaiting here is safe and lets us
    // detect dispatch failures before we mislead the client.
    const host = event.headers["host"] || "";
    const proto = (event.headers["x-forwarded-proto"] as string) || "https";
    const bgUrl = `${proto}://${host}/.netlify/functions/audit-background`;

    try {
      const bgRes = await fetch(bgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, url, competitorUrl }),
        signal: AbortSignal.timeout(BG_TRIGGER_TIMEOUT_MS),
      });
      // Netlify replies 202 Accepted for background invocations; anything
      // outside the 2xx range means the worker did not start.
      if (!bgRes.ok && bgRes.status !== 202) {
        throw new Error(`Background function returned ${bgRes.status}`);
      }
    } catch (err: any) {
      console.error("Failed to trigger audit-background", err);
      try {
        await store.setJSON(jobId, {
          status: "error",
          error: "Impossible de démarrer l'analyse en arrière-plan.",
          finishedAt: Date.now(),
        });
      } catch (writeErr) {
        console.error("blob setJSON (error) failed", writeErr);
      }
      return jsonResponse(502, {
        error: "Impossible de démarrer l'analyse. Réessayez dans un instant.",
      });
    }

    return jsonResponse(202, { status: "pending", jobId });
  } catch (err: any) {
    // Top-level safety net — ensures we always return a JSON response with
    // CORS headers even on unexpected failures.
    console.error("audit handler crashed", err);
    return jsonResponse(500, {
      error: err?.message || "Erreur interne inattendue.",
    });
  }
};

export { handler };
