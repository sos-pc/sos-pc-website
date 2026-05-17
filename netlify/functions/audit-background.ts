import type { Handler, HandlerEvent } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { runFullAudit, setCached } from "./_audit-core.js";

// Background function — runs up to 15 minutes on the credit-based plan.
// Triggered by audit.ts via an internal fetch. Reads the jobId from the
// body, executes the full audit, and writes the result back into the
// blob store under the same jobId. The poll endpoint reads from there.

const JOB_STORE = "audit-jobs";

interface JobPayload {
  jobId: string;
  url: string;
  competitorUrl: string | null;
}

function isJobPayload(value: unknown): value is JobPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.jobId === "string" && typeof v.url === "string";
}

const handler: Handler = async (event: HandlerEvent) => {
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

  const { jobId, url, competitorUrl } = payload;
  const store = getStore(JOB_STORE);

  try {
    const result = await runFullAudit(url, competitorUrl);
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
        ? "Le site met trop de temps à répondre (timeout 45s)"
        : err?.message || "Erreur interne pendant l'analyse";
    await store.setJSON(jobId, {
      status: "error",
      error: message,
      finishedAt: Date.now(),
    });
  }

  // Background functions ignore the response body but Netlify expects 200.
  return { statusCode: 200, body: "" };
};

export { handler };
