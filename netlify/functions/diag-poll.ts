import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { DIAG_STORE, SESSION_TTL_MS, jsonResponse, sanitizeSession } from "../lib/diag-shared.js";

// GET /api/diag/poll?s=SESSION — polled every 2 s by the widget.
// Returns the report once and deletes it from the store.

export default async (req: Request) => {
  const session = sanitizeSession(new URL(req.url).searchParams.get("s"));
  if (!session) return jsonResponse(400, { ready: false });

  try {
    const store = getStore(DIAG_STORE);
    const key = `session-${session}`;
    const entry: any = await store.get(key, { type: "json" });
    if (!entry) return jsonResponse(200, { ready: false });

    await store.delete(key);
    const age = Date.now() - Date.parse(entry.created_at || "");
    if (!(age < SESSION_TTL_MS)) return jsonResponse(200, { ready: false });

    return jsonResponse(200, { ready: true, data: entry.data });
  } catch (err) {
    console.error("diag-poll: store failed", err);
    return jsonResponse(200, { ready: false });
  }
};

export const config: Config = { path: "/api/diag/poll", method: "GET" };
