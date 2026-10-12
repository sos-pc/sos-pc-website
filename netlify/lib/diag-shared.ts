// Shared helpers for the PC diagnostic API (/api/diag/*), used by the
// diag-* functions. Ported from the former standalone backend
// (sos-pc-diagnostic.netlify.app). The widget calls these endpoints with
// relative URLs from www.talos-int.com, so no CORS headers are sent:
// browsers on other origins cannot use them.

const DIAG_STORE = "diagnostic-sessions";

// Sessions are deleted as soon as the widget fetches them (diag-poll).
// Unclaimed ones are purged by diag-cleanup (hourly) once older than this,
// so nothing stays on the server more than 24 h — see /man/legal.
const SESSION_TTL_MS = 23 * 60 * 60 * 1000;

const GEMINI_MODEL = "gemini-2.5-flash-lite";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sanitizeSession(raw: unknown): string {
  return String(raw ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

// Best-effort, per-instance limiter (same approach as the audit tool):
// it does not survive cold starts but stops naive loops on the AI endpoints.
const hits = new Map<string, number[]>();

function isRateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

type GeminiResult = { ok: true; text: string } | { ok: false; status: number; error: string };

// Netlify AI Gateway injects GEMINI_API_KEY and GOOGLE_GEMINI_BASE_URL.
async function callGemini(
  contents: unknown[],
  generationConfig: Record<string, unknown>,
): Promise<GeminiResult> {
  const apiKey = Netlify.env.get("GEMINI_API_KEY");
  const baseUrl =
    Netlify.env.get("GOOGLE_GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com";
  if (!apiKey) return { ok: false, status: 500, error: "Clé API manquante" };

  try {
    const response = await fetch(`${baseUrl}/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents, generationConfig }),
    });
    if (!response.ok) {
      console.error("Gemini API error:", response.status, await response.text());
      return { ok: false, status: 502, error: "Erreur du service d'analyse" };
    }
    const result = await response.json();
    return { ok: true, text: result?.candidates?.[0]?.content?.parts?.[0]?.text || "" };
  } catch (err) {
    console.error("Gemini fetch error:", err);
    return { ok: false, status: 500, error: "Erreur réseau" };
  }
}

export { DIAG_STORE, SESSION_TTL_MS, jsonResponse, sanitizeSession, isRateLimited, callGemini };
