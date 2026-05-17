import type { Handler, HandlerEvent } from "@netlify/functions";

const API_KEY = process.env.PAGESPEED_API_KEY;
const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const MAX_ISSUES = 15;

interface AuditResult {
  url: string;
  scores: Record<string, number>;
  issues: { title: string; description: string; level: string }[];
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

function extractIssues(categories: any, audits: any): AuditResult["issues"] {
  const issues: AuditResult["issues"] = [];
  const seen = new Set<string>();

  const auditRefs: { id: string; weight: number }[] = [];
  for (const cat of Object.values(categories) as any[]) {
    for (const ref of cat.auditRefs || []) {
      if (ref.weight > 0) {
        auditRefs.push({ id: ref.id, weight: ref.weight });
      }
    }
  }

  auditRefs.sort((a, b) => b.weight - a.weight);

  for (const ref of auditRefs) {
    if (issues.length >= MAX_ISSUES) break;
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);

    const audit = audits[ref.id];
    if (!audit) continue;

    const score = audit.score;
    if (score === null || score >= 0.9) continue;

    const level = score < 0.5 ? "error" : "warning";
    const title = audit.title || ref.id;
    const description = audit.displayValue || audit.description?.slice(0, 120) || "";

    issues.push({ title, description, level });
  }

  return issues;
}

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "PAGESPEED_API_KEY not configured" }) };
  }

  let url: string;
  try {
    const body = JSON.parse(event.body || "{}");
    url = normalizeUrl(body.url || "");
    if (!url || url.length < 8) throw new Error("URL invalide");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "URL invalide ou manquante" }) };
  }

  try {
    const categories = ["performance", "seo", "accessibility", "best-practices"];
    const params = new URLSearchParams({
      url,
      key: API_KEY,
      strategy: "mobile",
    });
    categories.forEach((c) => params.append("category", c));

    const psiUrl = `${PSI_BASE}?${params.toString()}`;
    const res = await fetch(psiUrl, { signal: AbortSignal.timeout(30000) });

    if (!res.ok) {
      const errBody = await res.text();
      const errMsg = JSON.parse(errBody)?.error?.message || `PSI API error ${res.status}`;
      return { statusCode: 502, body: JSON.stringify({ error: errMsg }) };
    }

    const data = await res.json();
    const lhr = data.lighthouseResult;

    if (!lhr || !lhr.categories) {
      return { statusCode: 502, body: JSON.stringify({ error: "Réponse invalide de l'API PageSpeed" }) };
    }

    const scores: Record<string, number> = {};
    for (const [key, cat] of Object.entries(lhr.categories) as [string, any][]) {
      scores[key] = cat.score ?? 0;
    }

    const issues = extractIssues(lhr.categories, lhr.audits || {});

    const result: AuditResult = {
      url: lhr.finalUrl || url,
      scores,
      issues,
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(result),
    };
  } catch (err: any) {
    const message = err.name === "TimeoutError"
      ? "Le site met trop de temps à répondre (timeout 30s)"
      : err.message || "Erreur interne";
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
};

export { handler };
