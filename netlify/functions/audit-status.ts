import type { Handler, HandlerEvent } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Poll endpoint. The client hits this every ~2s with the jobId returned
// by audit.ts. It reads the blob and reports one of three states:
//   pending — background worker still running, keep polling.
//   done    — full audit result is attached.
//   error   — background worker failed; an error message is attached.

const JOB_STORE = "audit-jobs";

const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const jobId = event.queryStringParameters?.id || "";
  if (!JOB_ID_PATTERN.test(jobId)) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "jobId invalide" }),
    };
  }

  const store = getStore(JOB_STORE);
  const job = await store.get(jobId, { type: "json" });

  if (!job) {
    return {
      statusCode: 404,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Job introuvable ou expiré" }),
    };
  }

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(job),
  };
};

export { handler };
