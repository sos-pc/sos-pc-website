// Shared audit core — types, helpers, and the orchestrator runFullAudit().
// Imported by audit.ts (sync entry), audit-background.ts (long-running),
// and audit-status.ts (poll endpoint). The leading underscore in the
// filename keeps Netlify from publishing this as a function endpoint.

const API_KEY = process.env.PAGESPEED_API_KEY;
const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const MAX_ISSUES = 15;
const DESCRIPTION_MAX_CHARS = 200;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PSI_TIMEOUT_MS = 45 * 1000;
const TECH_FETCH_TIMEOUT_MS = 10 * 1000;

type Strategy = "mobile" | "desktop";

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
  impact: string;
  level: "error" | "warning";
  category: string;
  effort: "easy" | "medium" | "hard";
  weight: number;
}

interface StrategyResult {
  scores: Record<string, number>;
  scoreOverall: number;
  vitals: VitalMetric[];
  issues: Issue[];
  quickWins: Issue[];
  summary: { critical: number; warning: number; passed: number };
  screenshot?: string;
}

interface TechInfo {
  name: string;
  category: "CMS" | "Framework" | "JS" | "CSS" | "Analytics" | "Serveur" | "Autre";
  version?: string;
}

interface SecurityHeader {
  name: string;
  present: boolean;
  value?: string;
  label: string;
  description: string;
}

interface SslResult {
  https: boolean;
  redirectsToHttps: boolean;
  headers: SecurityHeader[];
  score: number; // 0-100
}

interface SeoCheck {
  id: string;
  label: string;
  present: boolean;
  value?: string;
  level: "good" | "warn" | "info";
  description: string;
}

interface SeoData {
  score: number; // 0-100
  checks: SeoCheck[];
}

interface AuditResponse {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  techStack: TechInfo[];
  ssl: SslResult;
  seo: SeoData;
  mobile: StrategyResult;
  desktop: StrategyResult;
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

const BUSINESS_IMPACT: Record<string, string> = {
  "largest-contentful-paint": "Selon Google, 1 visiteur sur 2 quitte un site mobile s'il met plus de 3 secondes à s'afficher.",
  "first-contentful-paint": "Au-delà de 3 secondes d'attente, le taux d'abandon double.",
  "total-blocking-time": "Si la page ne répond pas en 1 seconde, l'utilisateur pense qu'elle est cassée et part.",
  "cumulative-layout-shift": "Les visiteurs cliquent par erreur, remplissent mal les formulaires, et finissent par fuir.",
  "speed-index": "Un site qui semble lent perd la confiance du visiteur dans les 3 premières secondes.",
  "interactive": "Tant que la page n'est pas interactive, chaque clic ignoré est un client potentiel perdu.",
  "color-contrast": "1 français sur 5 a des troubles de la vision. Un texte illisible = clients exclus.",
  "image-alt": "Sans alt, vos images sont invisibles pour Google et les lecteurs d'écran.",
  "meta-description": "Sans description, Google met un extrait aléatoire — vous perdez le contrôle de votre vitrine sur les résultats de recherche.",
  "document-title": "Sans titre, votre site apparaît comme « Page sans titre » dans les onglets et les résultats Google.",
  "render-blocking-resources": "Le visiteur voit une page blanche pendant que les fichiers se chargent. Effet désastreux sur mobile.",
  "uses-text-compression": "Vos pages prennent 3 à 5 fois plus de bande passante que nécessaire — pénalise le mobile rural et le SEO.",
  "modern-image-formats": "Vos visiteurs téléchargent 30-50% de données en trop juste pour vos images.",
  "tap-targets": "Vos clients ratent le bouton « Réserver » ou « Acheter » et abandonnent.",
  "viewport": "Sans viewport, votre site apparaît minuscule sur mobile — illisible sans zoom.",
  "uses-https": "Chrome et Firefox marquent votre site « Non sécurisé » dans la barre d'adresse. Effet rédhibitoire.",
  "is-on-https": "Chrome et Firefox marquent votre site « Non sécurisé » dans la barre d'adresse. Effet rédhibitoire.",
  "uses-responsive-images": "Vos visiteurs mobile chargent des images désktop — gaspillage de data et lenteur.",
  "unused-javascript": "Du code inutile ralentit chaque chargement, surtout sur mobile 4G.",
  "unused-css-rules": "Du CSS inutile ralentit le rendu de la page sans bénéfice.",
  "unminified-javascript": "Vos fichiers JS pèsent 30 à 50% de plus que nécessaire.",
  "unminified-css": "Vos fichiers CSS pèsent 30 à 50% de plus que nécessaire.",
  "uses-long-cache-ttl": "Sans cache long, chaque visiteur retéléchage tout — perte de temps et de bande passante.",
  "uses-optimized-images": "Vos images font perdre des secondes de chargement à chaque visiteur.",
  "offscreen-images": "Vous chargez des images que personne ne verra — gaspillage qui ralentit l'affichage du contenu visible.",
  "third-party-summary": "Les scripts tiers (analytics, pubs, chats) ralentissent votre site sans que vos visiteurs en bénéficient.",
  "dom-size": "Une page trop complexe rame sur les mobiles bas de gamme — exclut une partie de votre audience.",
  "bootup-time": "Trop de JavaScript = page qui rame, surtout sur smartphones de plus de 3 ans.",
  "html-has-lang": "Sans langue déclarée, Google et les traducteurs automatiques ne savent pas comment indexer votre site.",
  "link-name": "Les lecteurs d'écran annoncent « lien lien lien » — vos clients mal-voyants sont perdus.",
  "button-name": "Vos boutons sans intitulé sont invisibles aux lecteurs d'écran — clients potentiels exclus.",
  "robots-txt": "Un robots.txt cassé peut empêcher Google d'indexer votre site entier.",
  "canonical": "Une URL canonique mal configurée peut diluer votre référencement Google.",
  "hreflang": "Une balise hreflang invalide brouille l'indexation multi-langue chez Google.",
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

// ---------------------------------------------------------------------------
// Tech stack detection — headers + HTML patterns, zero external dependencies
// ---------------------------------------------------------------------------

interface TechPattern {
  name: TechInfo["name"];
  category: TechInfo["category"];
  headerKey?: string;
  headerPattern?: RegExp;
  htmlPattern?: RegExp;
  versionCapture?: RegExp; // capture group 1 = version
}

const TECH_PATTERNS: TechPattern[] = [
  // CMS
  { name: "WordPress", category: "CMS", htmlPattern: /\/wp-content\/|\/wp-includes\//i, versionCapture: /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress ([0-9.]+)/i },
  { name: "WordPress", category: "CMS", headerKey: "x-powered-by", headerPattern: /WordPress/i },
  { name: "Elementor", category: "CMS", htmlPattern: /elementor-/i },
  { name: "Divi", category: "CMS", htmlPattern: /et_pb_|DiviBuilder/i },
  { name: "WooCommerce", category: "CMS", htmlPattern: /woocommerce/i },
  { name: "Shopify", category: "CMS", htmlPattern: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: "Shopify", category: "CMS", headerKey: "x-shopify-stage", headerPattern: /./ },
  { name: "Webflow", category: "CMS", htmlPattern: /webflow\.com\/|data-wf-page|data-wf-site/i },
  { name: "Wix", category: "CMS", htmlPattern: /static\.wixstatic\.com|wix-warmup-data/i },
  { name: "Squarespace", category: "CMS", htmlPattern: /squarespace\.com\/|static1\.squarespace\.com/i },
  { name: "Ghost", category: "CMS", headerKey: "x-ghost-cache-status", headerPattern: /./ },
  { name: "Ghost", category: "CMS", htmlPattern: /<meta[^>]+name=["']generator["'][^>]+content=["']Ghost/i },
  { name: "Drupal", category: "CMS", htmlPattern: /\/sites\/default\/files\/|Drupal\.settings/i },
  { name: "Joomla", category: "CMS", htmlPattern: /\/media\/jui\/|Joomla!/i },
  { name: "TYPO3", category: "CMS", htmlPattern: /typo3temp\/|This website is powered by TYPO3/i },
  { name: "PrestaShop", category: "CMS", htmlPattern: /prestashop|\/modules\/ps_/i },
  { name: "Magento", category: "CMS", htmlPattern: /mage\/cookies|Magento_/i },
  // Frameworks
  { name: "Next.js", category: "Framework", headerKey: "x-powered-by", headerPattern: /Next\.js/i },
  { name: "Next.js", category: "Framework", htmlPattern: /__NEXT_DATA__|_next\/static/i },
  { name: "Nuxt.js", category: "Framework", htmlPattern: /__NUXT__|_nuxt\//i },
  { name: "Astro", category: "Framework", htmlPattern: /astro-island|data-astro-cid/i },
  { name: "Gatsby", category: "Framework", htmlPattern: /___gatsby|gatsby-chunk/i },
  { name: "SvelteKit", category: "Framework", htmlPattern: /__sveltekit|_app\/immutable/i },
  { name: "Remix", category: "Framework", htmlPattern: /window\.__remixContext/i },
  // JS libraries
  { name: "React", category: "JS", htmlPattern: /react(?:\.min)?\.js|__reactFiber|data-reactroot/i },
  { name: "Vue.js", category: "JS", htmlPattern: /vue(?:\.min)?\.js|__vue_/i },
  { name: "Angular", category: "JS", htmlPattern: /ng-version=|angular(?:\.min)?\.js/i },
  { name: "jQuery", category: "JS", htmlPattern: /jquery(?:\.min)?\.js|jQuery\.fn\.jquery/i },
  { name: "Alpine.js", category: "JS", htmlPattern: /alpinejs|x-data=/i },
  { name: "Htmx", category: "JS", htmlPattern: /htmx\.org|hx-get=/i },
  // CSS
  { name: "Bootstrap", category: "CSS", htmlPattern: /bootstrap(?:\.min)?\.css|class=["'][^"']*\b(?:container|navbar|btn)\b/i },
  { name: "Tailwind CSS", category: "CSS", htmlPattern: /tailwind(?:css)?(?:\.min)?\.css|class=["'][^"']*(?:flex|grid|text-)/i },
  { name: "Bulma", category: "CSS", htmlPattern: /bulma(?:\.min)?\.css/i },
  { name: "Foundation", category: "CSS", htmlPattern: /foundation(?:\.min)?\.css/i },
  // Analytics / tracking
  { name: "Google Analytics 4", category: "Analytics", htmlPattern: /gtag\('config'|googletagmanager\.com\/gtag/i },
  { name: "Google Tag Manager", category: "Analytics", htmlPattern: /googletagmanager\.com\/gtm\.js/i },
  { name: "Matomo", category: "Analytics", htmlPattern: /matomo\.js|piwik\.js/i },
  { name: "Hotjar", category: "Analytics", htmlPattern: /hotjar\.com\/|hj\('trigger'/i },
  { name: "Plausible", category: "Analytics", htmlPattern: /plausible\.io\/js/i },
  // Serveur / hébergement
  { name: "Nginx", category: "Serveur", headerKey: "server", headerPattern: /nginx/i },
  { name: "Apache", category: "Serveur", headerKey: "server", headerPattern: /apache/i },
  { name: "Cloudflare", category: "Serveur", headerKey: "cf-ray", headerPattern: /./ },
  { name: "Netlify", category: "Serveur", headerKey: "x-nf-request-id", headerPattern: /./ },
  { name: "Vercel", category: "Serveur", headerKey: "x-vercel-id", headerPattern: /./ },
  { name: "OVH", category: "Serveur", headerKey: "server", headerPattern: /LiteSpeed|OVH/i },
  { name: "PHP", category: "Serveur", headerKey: "x-powered-by", headerPattern: /PHP\/([0-9.]+)/i, versionCapture: /PHP\/([0-9.]+)/i },
];

interface PageData {
  techs: TechInfo[];
  ssl: SslResult;
  seo: SeoData;
}

const SECURITY_HEADERS: Array<{
  key: string;
  label: string;
  description: string;
}> = [
  {
    key: "strict-transport-security",
    label: "HSTS",
    description: "Force le navigateur à utiliser HTTPS pour les prochaines visites.",
  },
  {
    key: "content-security-policy",
    label: "CSP",
    description: "Limite les sources de scripts et ressources — protection contre le XSS.",
  },
  {
    key: "x-frame-options",
    label: "X-Frame-Options",
    description: "Protège contre le clickjacking en empêchant l'intégration en iframe.",
  },
  {
    key: "x-content-type-options",
    label: "X-Content-Type-Options",
    description: "Empêche le navigateur de deviner le type MIME d'un fichier.",
  },
  {
    key: "referrer-policy",
    label: "Referrer-Policy",
    description: "Contrôle les informations d'origine envoyées aux sites tiers.",
  },
  {
    key: "permissions-policy",
    label: "Permissions-Policy",
    description: "Restreint l'accès aux APIs sensibles (caméra, micro, géoloc…).",
  },
];

function parseSeoData(html: string, finalUrl: string): SeoData {
  const checks: SeoCheck[] = [];

  function meta(name: string): string | undefined {
    const m =
      html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']{1,300})`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']${name}["']`, "i"));
    return m?.[1]?.trim();
  }

  function prop(name: string): string | undefined {
    const m =
      html.match(new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']{1,300})`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']{1,300})["'][^>]+property=["']${name}["']`, "i"));
    return m?.[1]?.trim();
  }

  function link(rel: string): string | undefined {
    const m = html.match(new RegExp(`<link[^>]+rel=["']${rel}["'][^>]+href=["']([^"']{1,300})`, "i"));
    return m?.[1]?.trim();
  }

  // Title
  const titleM = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const title = titleM?.[1]?.trim();
  checks.push({
    id: "title",
    label: "Title",
    present: !!title,
    value: title,
    level: title ? "good" : "warn",
    description: title ? "Titre de page présent." : "Balise <title> manquante — critique pour le SEO.",
  });

  // Meta description
  const desc = meta("description");
  checks.push({
    id: "meta-description",
    label: "Meta description",
    present: !!desc,
    value: desc,
    level: desc ? "good" : "warn",
    description: desc ? `${desc.length} caractères.` : "Meta description absente — Google génèrera un extrait aléatoire.",
  });

  // Lang
  const langM = html.match(/<html[^>]+lang=["']([a-zA-Z-]{2,10})["']/i);
  const lang = langM?.[1];
  checks.push({
    id: "lang",
    label: "Langue (lang=)",
    present: !!lang,
    value: lang,
    level: lang ? "good" : "warn",
    description: lang ? `Langue déclarée : ${lang}.` : "Attribut lang manquant sur <html> — pénalise l'indexation multilingue.",
  });

  // Canonical
  const canonical = link("canonical");
  checks.push({
    id: "canonical",
    label: "Canonical",
    present: !!canonical,
    value: canonical,
    level: canonical ? "good" : "info",
    description: canonical ? `URL canonique : ${canonical}.` : "Pas de balise canonical — risque de contenu dupliqué.",
  });

  // Robots meta
  const robots = meta("robots");
  const isBlocked = robots && /noindex/i.test(robots);
  checks.push({
    id: "robots",
    label: "Robots meta",
    present: !!robots,
    value: robots,
    level: isBlocked ? "warn" : robots ? "good" : "info",
    description: isBlocked
      ? `⚠ noindex détecté — cette page est exclue de Google (${robots}).`
      : robots
        ? `Directive : ${robots}.`
        : "Pas de meta robots — comportement par défaut (indexation autorisée).",
  });

  // OpenGraph
  const ogTitle = prop("og:title");
  const ogDesc = prop("og:description");
  const ogImage = prop("og:image");
  const ogPresent = !!(ogTitle || ogDesc || ogImage);
  checks.push({
    id: "opengraph",
    label: "OpenGraph (og:)",
    present: ogPresent,
    value: ogPresent ? [ogTitle && `title`, ogDesc && `description`, ogImage && `image`].filter(Boolean).join(", ") : undefined,
    level: ogPresent ? "good" : "warn",
    description: ogPresent
      ? "Les balises og: sont présentes — le partage sur Facebook/LinkedIn sera correctement prévisualisé."
      : "og:title / og:description / og:image absents — les partages sur les réseaux sociaux afficheront un aperçu vide.",
  });

  // Twitter Card
  const twCard = meta("twitter:card");
  const twTitle = meta("twitter:title");
  const twPresent = !!(twCard || twTitle);
  checks.push({
    id: "twitter-card",
    label: "Twitter Card",
    present: twPresent,
    value: twCard,
    level: twPresent ? "good" : "info",
    description: twPresent
      ? `Type : ${twCard || "défini"} — les partages Twitter/X seront enrichis.`
      : "twitter:card absent — aperçu basique sur Twitter/X.",
  });

  // JSON-LD structured data
  const jsonLdM = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]{1,4000}?)<\/script>/i);
  const jsonLd = jsonLdM?.[1]?.trim();
  let jsonLdType: string | undefined;
  if (jsonLd) {
    try {
      const parsed = JSON.parse(jsonLd);
      jsonLdType = parsed["@type"] || (Array.isArray(parsed["@graph"]) ? "Graph" : undefined);
    } catch {}
  }
  checks.push({
    id: "json-ld",
    label: "JSON-LD (données structurées)",
    present: !!jsonLd,
    value: jsonLdType,
    level: jsonLd ? "good" : "info",
    description: jsonLd
      ? `Type détecté : ${jsonLdType || "présent"} — Google peut afficher des Rich Results.`
      : "Pas de JSON-LD — aucune chance d'apparaître en Rich Snippet (étoiles, FAQ, recettes…).",
  });

  // Favicon
  const favM =
    html.match(/<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']{1,200})["']/i) ||
    html.match(/<link[^>]+href=["']([^"']{1,200})["'][^>]+rel=["'](?:icon|shortcut icon)["']/i);
  const fav = favM?.[1];
  checks.push({
    id: "favicon",
    label: "Favicon",
    present: !!fav,
    value: fav,
    level: fav ? "good" : "info",
    description: fav ? "Favicon déclaré dans le HTML." : "Aucun favicon déclaré — onglets et résultats Google sans icône.",
  });

  const goodCount = checks.filter((c) => c.level === "good").length;
  const score = Math.round((goodCount / checks.length) * 100);

  return { score, checks };
}

function buildSslResult(
  originalUrl: string,
  finalUrl: string,
  headers: Record<string, string>
): SslResult {
  const https = originalUrl.startsWith("https://");
  const redirectsToHttps =
    !originalUrl.startsWith("https://") && finalUrl.startsWith("https://");

  const secHeaders: SecurityHeader[] = SECURITY_HEADERS.map(({ key, label, description }) => {
    const val = headers[key];
    return { name: key, label, description, present: !!val, value: val };
  });

  const presentCount = secHeaders.filter((h) => h.present).length;
  const httpsBonus = (https || redirectsToHttps) ? 40 : 0;
  const headersScore = Math.round((presentCount / SECURITY_HEADERS.length) * 60);
  const score = httpsBonus + headersScore;

  return { https, redirectsToHttps, headers: secHeaders, score };
}

async function fetchPageData(url: string): Promise<PageData> {
  const nullSsl: SslResult = {
    https: url.startsWith("https://"),
    redirectsToHttps: false,
    headers: SECURITY_HEADERS.map(({ key, label, description }) => ({
      name: key, label, description, present: false,
    })),
    score: url.startsWith("https://") ? 40 : 0,
  };
  const nullSeo: SeoData = { score: 0, checks: [] };

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TECH_FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SOS-PC-Audit/1.0)" },
      redirect: "follow",
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const finalUrl = res.url || url;
    const ssl = buildSslResult(url, finalUrl, headers);

    const contentType = headers["content-type"] || "";
    let html = "";
    if (contentType.includes("text/html")) {
      // Read at most 50 KB — enough for <head> patterns
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer.slice(0, 51200));
      html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }

    const seo = html ? parseSeoData(html, finalUrl) : nullSeo;

    const detected = new Map<string, TechInfo>();

    for (const pattern of TECH_PATTERNS) {
      if (detected.has(pattern.name)) continue;

      let matched = false;
      let version: string | undefined;

      if (pattern.headerKey && pattern.headerPattern) {
        const headerVal = headers[pattern.headerKey] || "";
        if (pattern.headerPattern.test(headerVal)) {
          matched = true;
          if (pattern.versionCapture) {
            const m = headerVal.match(pattern.versionCapture);
            version = m?.[1];
          }
        }
      }

      if (!matched && pattern.htmlPattern && html) {
        if (pattern.htmlPattern.test(html)) {
          matched = true;
          if (pattern.versionCapture) {
            const m = html.match(pattern.versionCapture);
            version = m?.[1];
          }
        }
      }

      if (matched) {
        detected.set(pattern.name, { name: pattern.name, category: pattern.category, version });
      }
    }

    return { techs: Array.from(detected.values()), ssl, seo };
  } catch {
    // Non-fatal — best-effort
    return { techs: [], ssl: nullSsl, seo: nullSeo };
  }
}

const rateLimitStore = new Map<string, number[]>();
const cacheStore = new Map<string, { response: AuditResponse; expiresAt: number }>();

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

function getCached(url: string): AuditResponse | null {
  const entry = cacheStore.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(url);
    return null;
  }
  return entry.response;
}

function setCached(url: string, response: AuditResponse): void {
  cacheStore.set(url, { response, expiresAt: Date.now() + CACHE_TTL_MS });
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

function frenchize(id: string, fallbackTitle: string, fallbackDesc: string): { title: string; description: string; impact: string } {
  const title = FR_TITLES[id] || fallbackTitle;
  const cleanDesc = stripMarkdownLinks(fallbackDesc || "");
  const description = FR_DESCRIPTIONS[id] || truncateAtWord(cleanDesc, DESCRIPTION_MAX_CHARS);
  const impact = BUSINESS_IMPACT[id] || "";
  return { title, description, impact };
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
    const { title, description, impact } = frenchize(
      ref.id,
      audit.title || ref.id,
      audit.displayValue || audit.description || ""
    );

    issues.push({
      id: ref.id,
      title,
      description,
      impact,
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

function summarize(issues: Issue[], audits: any): StrategyResult["summary"] {
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

interface PsiCallResult {
  result: StrategyResult;
  finalUrl: string;
}

async function runStrategyAudit(url: string, strategy: Strategy): Promise<PsiCallResult> {
  if (!API_KEY) throw new Error("PAGESPEED_API_KEY not configured");

  const categories = ["performance", "seo", "accessibility", "best-practices"];
  const params = new URLSearchParams({
    url,
    key: API_KEY,
    strategy,
    locale: "fr",
  });
  categories.forEach((c) => params.append("category", c));

  const psiUrl = `${PSI_BASE}?${params.toString()}`;
  const res = await fetch(psiUrl, { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) });

  if (!res.ok) {
    const errBody = await res.text();
    let errMsg = `Erreur API ${res.status}`;
    try {
      errMsg = JSON.parse(errBody)?.error?.message || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  const lhr = data.lighthouseResult;
  if (!lhr || !lhr.categories) {
    throw new Error("Réponse invalide de l'API PageSpeed");
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
  const screenshot =
    lhr.fullPageScreenshot?.screenshot?.data ||
    lhr.audits?.["final-screenshot"]?.details?.data;

  return {
    finalUrl: lhr.finalUrl || url,
    result: {
      scores,
      scoreOverall: computeOverallScore(scores),
      vitals,
      issues,
      quickWins,
      summary,
      screenshot: typeof screenshot === "string" ? screenshot : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — runs every audit task in parallel and assembles the response.
// Caching is the responsibility of the caller (entry function).
// ---------------------------------------------------------------------------

async function runFullAudit(url: string): Promise<AuditResponse> {
  const [mobile, desktop, pageData] = await Promise.all([
    runStrategyAudit(url, "mobile"),
    runStrategyAudit(url, "desktop"),
    fetchPageData(url),
  ]);

  return {
    url,
    finalUrl: mobile.finalUrl || desktop.finalUrl || url,
    fetchedAt: new Date().toISOString(),
    techStack: pageData.techs,
    ssl: pageData.ssl,
    seo: pageData.seo,
    mobile: mobile.result,
    desktop: desktop.result,
  };
}

export type { AuditResponse, StrategyResult, Issue, VitalMetric, TechInfo, SslResult, SeoData };
export { API_KEY, runFullAudit, normalizeUrl, isPrivateUrl, checkRateLimit, getCached, setCached };
