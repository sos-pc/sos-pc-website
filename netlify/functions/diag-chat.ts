import type { Config, Context } from "@netlify/functions";
import { callGemini, isRateLimited, jsonResponse } from "../lib/diag-shared.js";

// POST /api/diag/chat — Body: { messages: [{role, content}], systemData?, report? }
// Returns { message }.

const MAX_MESSAGES = 30;

function systemContext(report: unknown, systemData: unknown): string {
  return `Tu es l'assistant de Talos Int., un service de depannage informatique base a Oraison (04700), en France.
Tu viens de realiser un diagnostic du PC de l'utilisateur.

Rapport de diagnostic :
${JSON.stringify(report ?? null, null, 2)}

Donnees techniques du PC :
${JSON.stringify(systemData ?? null, null, 2)}

Reponds aux questions de l'utilisateur de facon claire et simple.
Tu peux proposer des solutions a faire soi-meme OU recommander Talos Int. (intervention a domicile autour d'Oraison ou a distance) si c'est plus adapte.
Reponds en francais, de facon concise et bienveillante. 2-3 phrases max sauf si l'utilisateur demande plus de details.`;
}

// Gemini expects alternating user/model turns starting with "user";
// the system context is folded into the first user turn.
function toGeminiContents(messages: any[], context: string) {
  const contents: { role: string; parts: { text: string }[] }[] = [];
  let systemInjected = false;

  for (const msg of messages) {
    const role = msg?.role === "user" ? "user" : "model";
    let text = String(msg?.content ?? "");

    if (role === "user" && !systemInjected) {
      text = context + "\n\n---\n\n" + text;
      systemInjected = true;
    }
    if (role === "model" && !systemInjected) {
      contents.push({ role: "user", parts: [{ text: context + "\n\n---\n\nResume le diagnostic effectue." }] });
      systemInjected = true;
    }

    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += "\n" + text;
    else contents.push({ role, parts: [{ text }] });
  }

  if (!contents.length || contents[contents.length - 1].role !== "user") {
    contents.push({ role: "user", parts: [{ text: "Continue." }] });
  }
  return contents;
}

export default async (req: Request, context: Context) => {
  if (isRateLimited(`chat:${context.ip}`, 60, 60 * 60 * 1000)) {
    return jsonResponse(429, { error: "Trop de messages. Réessayez un peu plus tard." });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Corps invalide" });
  }

  const messages = Array.isArray(body?.messages) ? body.messages.slice(-MAX_MESSAGES) : [];
  if (!messages.length) return jsonResponse(400, { error: "Messages manquants" });

  const result = await callGemini(toGeminiContents(messages, systemContext(body.report, body.systemData)), {
    temperature: 0.7,
    maxOutputTokens: 800,
  });
  if (!result.ok) return jsonResponse(result.status, { error: result.error });

  return jsonResponse(200, { message: result.text });
};

export const config: Config = { path: "/api/diag/chat", method: "POST" };
