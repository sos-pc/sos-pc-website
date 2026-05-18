import type { Handler, HandlerEvent } from "@netlify/functions";
import { runFullAudit, setCached } from "./_audit-core.js";

// Background function — runs up to 15 minutes on the credit-based plan.
// Triggered by audit.ts via an internal fetch. Reads the jobId from the
// body, executes the full audit, and writes the result back into the
// blob store under the same jobId. The poll endpoint reads from there.
//
// Defensive design: lazy-load blobs SDK; never throw out of the handler.

const JOB_STORE = "audit-jobs";

const BLOBS_SITE_ID = process.env.BLOBS_SITE_ID;
const BLOBS_TOKEN = process.env.BLOBS_TOKEN;

interface JobPayload {
  jobId: string;
  url: string;
}

function isJobPayload(value: unknown): value is JobPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.jobId === "string" && typeof v.url === "string";
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
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

    if (!isJobPayload(payload)) {
      return { statusCode: 400, body: "Invalid payload" };
    }

    const { jobId, url } = payload;

    let store;
    try {
      store = await getJobStore();
    } catch (err) {
      // No blob store means we cannot communicate the result back. Log and
      // exit; the client will eventually time out.
      console.error("audit-background: getStore failed", err);
      return { statusCode: 500, body: "Blob store unavailable" };
    }

    try {
      const result = await runFullAudit(url);
      // Mirror successful results into the in-memory hot cache so subsequent
      // requests for the same URL skip the polling round-trip entirely.
      setCached(url, result);

      await store.setJSON(jobId, {
        status: "done",
        result,
        finishedAt: Date.now(),
      });
    } catch (err: any) {
      const message =
        err?.name === "TimeoutError"
          ? "Le site met trop de temps à répondre (timeout 90s)"
          : err?.message || "Erreur interne pendant l'analyse";
      try {
        await store.setJSON(jobId, {
          status: "error",
          error: message,
          finishedAt: Date.now(),
        });
      } catch (writeErr) {
        console.error("audit-background: failed to record error", writeErr);
      }
    }

    // Background functions ignore the response body but Netlify expects 200.
    return { statusCode: 200, body: "" };
  } catch (err: any) {
    console.error("audit-background handler crashed", err);
    return { statusCode: 500, body: "Internal error" };
  }
};

export { handler };
