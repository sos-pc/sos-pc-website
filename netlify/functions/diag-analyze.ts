import type { Config, Context } from "@netlify/functions";
import { callGemini, isRateLimited, jsonResponse } from "../lib/diag-shared.js";

// POST /api/diag/analyze — Body: { data: <payload from diag.ps1>, problem?: string }
// Returns { report } (JSON produced by Gemini, see schema in the prompt).

const REPORT_SCHEMA =
  '{"summary":"...","score":85,"issues":[{"level":"critical|warning|ok","category":"RAM|CPU|Stockage|Temperature|Demarrage|Systeme|Securite","title":"...","description":"...","action":"..."}],"quick_wins":["..."],"needs_professional":true,"professional_reason":"..."}';

const v = (value: unknown, fallback = "?") =>
  value === undefined || value === null || value === "" ? fallback : String(value);

function buildPrompt(d: any, problem: string): string {
  const lines: string[] = [];
  lines.push(
    "Tu es un expert en depannage PC Windows pour Talos Int., service de depannage informatique base a Oraison (04700), en France.",
    "Analyse les donnees systeme et reponds UNIQUEMENT en JSON valide (sans markdown ni backticks) avec cette structure :",
    REPORT_SCHEMA,
    "score = sante du PC de 0 a 100. Sois honnete mais rassurant.",
    "N'invente aucune donnee absente ci-dessous.",
    "---",
    "Probleme decrit : " + (problem || "Non precise"),
    "",
    `OS : ${v(d.os?.name, "inconnu")} build ${v(d.os?.build)}`,
    `Arch : ${v(d.os?.arch)} | Uptime : ${v(d.os?.uptime)}h`,
  );

  const ramTotal = parseFloat(d.os?.ram_total_gb) || 0;
  const ramFree = parseFloat(d.os?.ram_free_gb) || 0;
  const ramPct = ramTotal > 0 ? Math.round((1 - ramFree / ramTotal) * 100) : "?";
  lines.push(`RAM : ${ramTotal} Go total | ${ramFree} Go libre | ${ramPct}% utilisee`);
  lines.push(`CPU : ${v(d.cpu?.name)} | ${v(d.cpu?.cores)} coeurs | charge ${v(d.cpu?.load)}%`);

  const gpus: any[] = Array.isArray(d.gpus) ? d.gpus : d.gpu ? [d.gpu] : [];
  lines.push(
    "GPU : " +
      (gpus.length ? gpus.map((g) => `${v(g.name)} (${v(g.ram_mb)} Mo VRAM, pilote ${v(g.driver_date)})`).join(" ; ") : "?"),
  );

  lines.push("DISQUES :");
  if (Array.isArray(d.disks) && d.disks.length) {
    for (const disk of d.disks) {
      lines.push(`  ${disk.letter} : ${disk.free_gb} Go libre / ${disk.total_gb} Go (${disk.pct_used}% utilise)`);
    }
  } else {
    lines.push("  Aucun disque detecte");
  }
  if (Array.isArray(d.physical_disks)) {
    for (const p of d.physical_disks) {
      lines.push(
        `  Physique ${v(p.friendly_name)} : ${v(p.media_type)} ${v(p.bus_type)} | sante ${v(p.health_status)} | ` +
          `temp ${v(p.temperature_c)}C | secteurs realloues ${v(p.reallocated_sectors)} | heures ${v(p.hours_used)}`,
      );
    }
  }

  if (Array.isArray(d.temperatures) && d.temperatures.length) {
    lines.push("TEMPERATURES : " + d.temperatures.map((t: any) => `${v(t.temp_celsius)}C`).join(", "));
  }

  const s = d.security || {};
  lines.push(
    `SECURITE : antivirus ${v(s.defender_enabled)} | temps reel ${v(s.realtime_protection)} | ` +
      `signatures ${v(s.antivirus_signature_date)} | pare-feu prive ${v(s.firewall_private)} / public ${v(s.firewall_public)} | UAC ${v(s.uac_enabled)}`,
  );

  lines.push("PROCESSUS (top RAM) :");
  for (const p of (Array.isArray(d.procs) ? d.procs : []).slice(0, 8)) {
    lines.push(`  ${p.name} : ${p.ram_mb} Mo`);
  }

  lines.push("DEMARRAGE : " + (Array.isArray(d.startup) && d.startup.length ? d.startup.join(", ") : "Aucun"));

  const st = d.stability || d.events || {};
  lines.push(`STABILITE : ${v(st.critical_24h, "0")} erreurs critiques en 24h | ${v(st.bsod_count, "0")} arrets brutaux sur 7 jours`);
  for (const e of Array.isArray(st.samples) ? st.samples : []) {
    lines.push(`  [ID ${e.id}] ${e.message || e.msg || ""}`);
  }

  lines.push("---", "Fournis le JSON de diagnostic complet.");
  return lines.join("\n");
}

function parseReport(rawText: string): any | null {
  try {
    return JSON.parse(rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
  } catch {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export default async (req: Request, context: Context) => {
  if (isRateLimited(`analyze:${context.ip}`, 10, 60 * 60 * 1000)) {
    return jsonResponse(429, { error: "Trop d'analyses. Réessayez dans une heure." });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Corps de requête invalide" });
  }
  if (!body?.data || typeof body.data !== "object") {
    return jsonResponse(400, { error: "Données système manquantes" });
  }

  const result = await callGemini(
    [{ role: "user", parts: [{ text: buildPrompt(body.data, String(body.problem || "")) }] }],
    { temperature: 0.2, maxOutputTokens: 2000, response_mime_type: "application/json" },
  );
  if (!result.ok) return jsonResponse(result.status, { error: result.error });

  const report = parseReport(result.text);
  if (!report) {
    console.error("diag-analyze: invalid JSON from model:", result.text);
    return jsonResponse(500, { error: "Réponse IA invalide" });
  }
  return jsonResponse(200, { report });
};

export const config: Config = { path: "/api/diag/analyze", method: "POST" };
