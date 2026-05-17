import type { Handler, HandlerEvent } from "@netlify/functions";

// Poll endpoint. The client hits this every ~2s with the jobId returned
// by audit.ts. It reads the blob and reports one of three states:
//   pending — background worker still running, keep polling.
//   done    — full audit result is attached.
//   error   — background worker failed; an error message is attached.
//
// Defensive design: lazy-load the blobs SDK and wrap everything in
// try/catch so module-level failures never produce an opaque 502.

const JOB_STORE = "audit-jobs";
const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;

const BLOBS_SITE_ID = process.env.BLOBS_SITE_ID;
const BLOBS_TOKEN = process.env.BLOBS_TOKEN;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

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

    if (event.httpMethod !== "GET") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const jobId = event.queryStringParameters?.id || "";
    if (!JOB_ID_PATTERN.test(jobId)) {
      return jsonResponse(400, { error: "jobId invalide" });
    }

    let store;
    try {
      store = await getJobStore();
    } catch (err: any) {
      console.error("getStore failed", err);
      return jsonResponse(500, {
        error: "Stockage des jobs indisponible.",
      });
    }

    let job;
    try {
      job = await store.get(jobId, { type: "json" });
    } catch (err: any) {
      console.error("blob get failed", err);
      return jsonResponse(500, { error: "Lecture du job impossible." });
    }

    if (!job) {
      return jsonResponse(404, { error: "Job introuvable ou expiré" });
    }

    return jsonResponse(200, job);
  } catch (err: any) {
    console.error("audit-status handler crashed", err);
    return jsonResponse(500, {
      error: err?.message || "Erreur interne inattendue.",
    });
  }
};

export { handler };
