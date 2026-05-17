import type { Handler, HandlerEvent } from "@netlify/functions";

const API_KEY = process.env.PAGESPEED_API_KEY;
const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const MAX_ISSUES = 15;
const DESCRIPTION_MAX_CHARS = 200;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface VitalMetric {
  id: string;
  label: string;
  value: string;
  numericValue: number;
  unit: string;
  rating: "good" | "needs-improvement" | "poor";
}

interface Issue {
  id: string;
  title: string;
  description: string;
  level: "error" | "warning";
  category: string;
  effort: "easy" | "medium" | "hard";
  weight: number;
}

interface AuditResult {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  scores: Record<string, number>;
  scoreOverall: number;
  vitals: VitalMetric[];
  issues: Issue[];
  quickWins: Issue[];
  summary: {
    critical: number;
    warning: number;
    passed: number;
  };
  screenshot?: string;
}

const FR_TITLES: Record<string, string> = {
  "largest-contentful-paint": "Affichage du plus gros élément",
  "first-contentful-paint": "Premier contenu affiché",
  "total-blocking-time": "Temps de blocage du navigateur",
  "cumulative-layout-shift": "Stabilité visuelle",
  "speed-index": "Indice de vitesse de chargement",
  "interactive": "Délai d'interactivité",
  "color-contrast": "Contraste des couleurs insuffisant",
  "image-alt": "Images sans description (alt)",
  "tap-targets": "Boutons trop petits sur mobile",
  "viewport": "Balise viewport mobile manquante",
  "meta-description": "Description SEO manquante",
  "document-title": "Titre de page manquant",
  "uses-https": "Site non sécurisé (HTTPS)",
  "is-on-https": "Site non sécurisé (HTTPS)",
  "uses-responsive-images": "Images non optimisées pour mobile",
  "modern-image-formats": "Formats d'image modernes (WebP/AVIF)",
  "uses-text-compression": "Compression du texte (gzip/brotli)",
  "render-blocking-resources": "Ressources bloquant le rendu",
  "unused-javascript": "Code JavaScript inutilisé",
  "unused-css-rules": "Règles CSS inutilisées",
  "unminified-javascript": "JavaScript non minifié",
  "unminified-css": "CSS non minifié",
  "efficient-animated-content": "Animations vidéo trop lourdes",
  "uses-long-cache-ttl": "Mise en cache des ressources",
  "uses-optimized-images": "Images non optimisées",
  "offscreen-images": "Images hors écran chargées trop tôt",
  "third-party-summary": "Scripts tiers ralentissant le site",
  "dom-size": "Trop d'éléments dans la page",
  "bootup-time": "Temps d'exécution JavaScript",
  "mainthread-work-breakdown": "Charge du processeur principal",
  "html-has-lang": "Langue de la page non déclarée",
  "link-name": "Liens sans intitulé clair",
  "button-name": "Boutons sans intitulé clair",
  "robots-txt": "Fichier robots.txt invalide",
  "canonical": "Lien canonique mal configuré",
  "hreflang": "Balise hreflang invalide",
};

const FR_DESCRIPTIONS: Record<string, string> = {
  "largest-contentful-paint": "Le plus gros élément visible (image ou texte) met du temps à apparaître. Cela donne l'impression d'un site lent au chargement.",
  "first-contentful-paint": "Délai avant que le visiteur voie le premier contenu de la page. Plus c'est long, plus l'impression d'attente est forte.",
  "total-blocking-time": "Temps pendant lequel la page ne répond pas aux clics de l'utilisateur. Souvent causé par trop de JavaScript.",
  "cumulative-layout-shift": "Les éléments de la page bougent pendant le chargement (texte qui saute, boutons qui se déplacent). Très frustrant pour le visiteur.",
  "color-contrast": "Certains textes manquent de contraste avec leur fond. Ils sont difficiles à lire, en particulier sur mobile en plein soleil.",
  "image-alt": "Vos images n'ont pas de description textuelle. Pénalise le SEO et l'accessibilité aux personnes mal-voyantes.",
  "meta-description": "La balise <meta description> est manquante ou vide. Google affichera un extrait aléatoire dans les résultats de recherche.",
  "document-title": "Le titre de la page est manquant ou trop court. Critique pour le SEO et l'affichage dans les onglets.",
  "render-blocking-resources": "Des fichiers CSS ou JS bloquent l'affichage de la page tant qu'ils ne sont pas chargés.",
  "uses-text-compression": "Vos fichiers texte (HTML, CSS, JS) ne sont pas compressés. La compression réduit leur taille de 60-80%.",
  "modern-image-formats": "Vos images sont en JPEG/PNG. Les formats WebP ou AVIF sont 30-50% plus légers à qualité égale.",
  "tap-targets": "Sur mobile, certains boutons ou liens sont trop petits ou trop proches les uns des autres.",
};

const EFFORT_BY_CATEGORY: Record<string, Issue["effort"]> = {
  "image": "easy",
  "compression": "easy",
  "cache": "easy",
  "minification": "easy",
  "alt": "easy",
  "title": "easy",
  "description": "easy",
  "viewport": "easy",
  "https": "medium",
  "javascript": "medium",
  "css": "medium",
  "render": "medium",
  "third-party": "hard",
  "lcp": "hard",
  "cls": "hard",
};

const VITAL_THRESHOLDS: Record<string, { good: number; poor: number; unit: string }> = {
  "largest-contentful-paint": { good: 2500, poor: 4000, unit: "ms" },
  "cumulative-layout-shift": { good: 0.1, poor: 0.25, unit: "" },
  "interaction-to-next-paint": { good: 200, poor: 500, unit: "ms" },
  "total-blocking-time": { good: 200, poor: 600, unit: "ms" },
  "first-contentful-paint": { good: 1800, poor: 3000, unit: "ms" },
};

const VITAL_LABELS: Record<string, string> = {
  "largest-contentful-paint": "LCP — Affichage principal",
  "cumulative-layout-shift": "CLS — Stabilité visuelle",
  "interaction-to-next-paint": "INP — Réactivité",
  "total-blocking-time": "TBT — Blocage navigateur",
  "first-contentful-paint": "FCP — Premier contenu",
};

const rateLimitStore = new Map<string, number[]>();
const cacheStore = new Map<string, { result: AuditResult; expiresAt: number }>();

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }
  return url;
}

function isPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (host.endsWith(".local") || host.endsWith(".internal")) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitStore.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(ip, hits);
    return false;
  }
  hits.push(now);
  rateLimitStore.set(ip, hits);
  return true;
}

function getCached(url: string): AuditResult | null {
  const entry = cacheStore.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(url);
    return null;
  }
  return entry.result;
}

function setCached(url: string, result: AuditResult): void {
  cacheStore.set(url, { result, expiresAt: Date.now() + CACHE_TTL_MS });
}

function stripMarkdownLinks(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

function frenchize(id: string, fallbackTitle: string, fallbackDesc: string): { title: string; description: string } {
  const title = FR_TITLES[id] || fallbackTitle;
  const cleanDesc = stripMarkdownLinks(fallbackDesc || "");
  const description = FR_DESCRIPTIONS[id] || truncateAtWord(cleanDesc, DESCRIPTION_MAX_CHARS);
  return { title, description };
}

function inferEffort(id: string, title: string): Issue["effort"] {
  const haystack = (id + " " + title).toLowerCase();
  for (const key of Object.keys(EFFORT_BY_CATEGORY)) {
    if (haystack.includes(key)) return EFFORT_BY_CATEGORY[key];
  }
  return "medium";
}

function inferCategory(id: string, categoryRefs: Map<string, string>): string {
  return categoryRefs.get(id) || "general";
}

function buildCategoryRefs(categories: any): Map<string, string> {
  const map = new Map<string, string>();
  const names: Record<string, string> = {
    performance: "Performance",
    seo: "SEO",
    accessibility: "Accessibilité",
    "best-practices": "Pratiques",
  };
  for (const [key, cat] of Object.entries(categories) as [string, any][]) {
    const display = names[key] || key;
    for (const ref of cat.auditRefs || []) {
      if (!map.has(ref.id)) map.set(ref.id, display);
    }
  }
  return map;
}

function extractIssues(categories: any, audits: any): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const categoryRefs = buildCategoryRefs(categories);

  const auditRefs: { id: string; weight: number }[] = [];
  for (const cat of Object.values(categories) as any[]) {
    for (const ref of cat.auditRefs || []) {
      if (ref.weight > 0) auditRefs.push({ id: ref.id, weight: ref.weight });
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
    if (score === null || score === undefined || score >= 0.9) continue;

    const level: Issue["level"] = score < 0.5 ? "error" : "warning";
    const { title, description } = frenchize(
      ref.id,
      audit.title || ref.id,
      audit.displayValue || audit.description || ""
    );

    issues.push({
      id: ref.id,
      title,
      description,
      level,
      category: inferCategory(ref.id, categoryRefs),
      effort: inferEffort(ref.id, audit.title || ""),
      weight: ref.weight,
    });
  }

  issues.sort((a, b) => {
    if (a.level !== b.level) return a.level === "error" ? -1 : 1;
    return b.weight - a.weight;
  });

  return issues;
}

function rateVital(id: string, value: number): VitalMetric["rating"] {
  const t = VITAL_THRESHOLDS[id];
  if (!t) return "needs-improvement";
  if (value <= t.good) return "good";
  if (value <= t.poor) return "needs-improvement";
  return "poor";
}

function formatVitalValue(id: string, numericValue: number): string {
  const t = VITAL_THRESHOLDS[id];
  if (!t) return String(numericValue);
  if (id === "cumulative-layout-shift") return numericValue.toFixed(2);
  if (numericValue < 1000) return Math.round(numericValue) + " ms";
  return (numericValue / 1000).toFixed(1) + " s";
}

function extractVitals(audits: any): VitalMetric[] {
  const ids = ["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "first-contentful-paint"];
  const vitals: VitalMetric[] = [];
  for (const id of ids) {
    const audit = audits[id];
    if (!audit || audit.numericValue === undefined) continue;
    vitals.push({
      id,
      label: VITAL_LABELS[id] || id,
      value: formatVitalValue(id, audit.numericValue),
      numericValue: audit.numericValue,
      unit: VITAL_THRESHOLDS[id]?.unit || "",
      rating: rateVital(id, audit.numericValue),
    });
  }
  return vitals;
}

function computeOverallScore(scores: Record<string, number>): number {
  const weights: Record<string, number> = {
    performance: 0.4,
    seo: 0.2,
    accessibility: 0.25,
    "best-practices": 0.15,
  };
  let total = 0;
  let totalWeight = 0;
  for (const [key, score] of Object.entries(scores)) {
    const w = weights[key] || 0.1;
    total += score * w;
    totalWeight += w;
  }
  return totalWeight > 0 ? Math.round((total / totalWeight) * 100) : 0;
}

function summarize(issues: Issue[], audits: any): AuditResult["summary"] {
  const passed = Object.values(audits as any[]).filter((a: any) => a.score === 1).length;
  return {
    critical: issues.filter((i) => i.level === "error").length,
    warning: issues.filter((i) => i.level === "warning").length,
    passed,
  };
}

function pickQuickWins(issues: Issue[]): Issue[] {
  const easyHighImpact = issues.filter((i) => i.effort === "easy");
  const sorted = easyHighImpact.sort((a, b) => {
    if (a.level !== b.level) return a.level === "error" ? -1 : 1;
    return b.weight - a.weight;
  });
  return sorted.slice(0, 3);
}

function getClientIp(event: HandlerEvent): string {
  const headers = event.headers || {};
  return (
    (headers["x-nf-client-connection-ip"] as string) ||
    ((headers["x-forwarded-for"] as string) || "").split(",")[0].trim() ||
    "unknown"
  );
}

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "PAGESPEED_API_KEY not configured" }) };
  }

  const ip = getClientIp(event);
  if (!checkRateLimit(ip)) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "Trop de requêtes. Réessayez dans une heure." }),
    };
  }

  let url: string;
  try {
    const body = JSON.parse(event.body || "{}");
    url = normalizeUrl(body.url || "");
    if (!url || url.length < 8) throw new Error("URL invalide");
    if (isPrivateUrl(url)) throw new Error("URL privée non autorisée");
  } catch (e: any) {
    return { statusCode: 400, body: JSON.stringify({ error: e.message || "URL invalide" }) };
  }

  const cached = getCached(url);
  if (cached) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" },
      body: JSON.stringify(cached),
    };
  }

  try {
    const categories = ["performance", "seo", "accessibility", "best-practices"];
    const params = new URLSearchParams({
      url,
      key: API_KEY,
      strategy: "mobile",
      locale: "fr",
    });
    categories.forEach((c) => params.append("category", c));

    const psiUrl = `${PSI_BASE}?${params.toString()}`;
    const res = await fetch(psiUrl, { signal: AbortSignal.timeout(45000) });

    if (!res.ok) {
      const errBody = await res.text();
      let errMsg = `Erreur API ${res.status}`;
      try {
        errMsg = JSON.parse(errBody)?.error?.message || errMsg;
      } catch {}
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

    const audits = lhr.audits || {};
    const issues = extractIssues(lhr.categories, audits);
    const vitals = extractVitals(audits);
    const summary = summarize(issues, audits);
    const quickWins = pickQuickWins(issues);
    const screenshot = lhr.fullPageScreenshot?.screenshot?.data || lhr.audits?.["final-screenshot"]?.details?.data;

    const result: AuditResult = {
      url,
      finalUrl: lhr.finalUrl || url,
      fetchedAt: new Date().toISOString(),
      scores,
      scoreOverall: computeOverallScore(scores),
      vitals,
      issues,
      quickWins,
      summary,
      screenshot: typeof screenshot === "string" ? screenshot : undefined,
    };

    setCached(url, result);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" },
      body: JSON.stringify(result),
    };
  } catch (err: any) {
    const message =
      err.name === "TimeoutError"
        ? "Le site met trop de temps à répondre (timeout 45s)"
        : err.message || "Erreur interne";
    return { statusCode: 500, body: JSON.stringify({ error: message }) };
  }
};

export { handler };
