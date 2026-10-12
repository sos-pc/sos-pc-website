import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { DIAG_STORE, jsonResponse, sanitizeSession } from "../lib/diag-shared.js";

// POST /api/diag/collect — called by public/diag.ps1 on the visitor's PC.
// Body: { session, data }. Stores the report until the widget polls it.

const MAX_BODY_BYTES = 1_000_000;

export default async (req: Request) => {
  const length = Number(req.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return jsonResponse(413, { error: "Rapport trop volumineux" });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "JSON invalide" });
  }

  const session = sanitizeSession(body?.session);
  if (!session || !body?.data) return jsonResponse(400, { error: "session et data requis" });

  try {
    const createdAt = new Date().toISOString();
    await getStore(DIAG_STORE).setJSON(
      `session-${session}`,
      { data: body.data, created_at: createdAt },
      { metadata: { createdAt } },
    );
    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error("diag-collect: store failed", err);
    return jsonResponse(500, { error: "Erreur stockage" });
  }
};

export const config: Config = { path: "/api/diag/collect", method: "POST" };
