// ============================================================
//  SOS-PC — Browser Diagnostic Scan
//  Collecte tout ce que le navigateur peut récupérer sans
//  installation, et génère un score + des alertes immédiates.
//  ~2 Ko gzippé, lazy-loadé uniquement sur les pages avec widget.
// ============================================================

export interface BrowserDiag {
  cpu: { cores: number; arch: string };
  ram: { deviceMemoryGB: number | null; estimated: string };
  gpu: { renderer: string; vendor: string };
  os: { platform: string; version: string; arch: string; isWin11: boolean };
  screen: { width: number; height: number; pixelRatio: number };
  network: {
    downlink: number | null;
    rtt: number | null;
    type: string | null;
    online: boolean;
  };
  battery: { level: number | null; charging: boolean | null };
  performance: { jsHeapMB: number | null };
}

export interface BrowserAlert {
  level: "critical" | "warning" | "ok";
  category: string;
  title: string;
}

export interface BrowserResult {
  data: BrowserDiag;
  score: number;
  alerts: BrowserAlert[];
  isWin11: boolean;
}

// ── Collecte ──────────────────────────────────────────────────────

function getGPU(): { renderer: string; vendor: string } {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl") ||
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null);
    if (!gl) return { renderer: "inconnu", vendor: "inconnu" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext)
      return { renderer: "inconnu (extension bloquée)", vendor: "inconnu" };
    return {
      renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "inconnu",
      vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || "inconnu",
    };
  } catch {
    return { renderer: "inconnu", vendor: "inconnu" };
  }
}

function getOS(): BrowserDiag["os"] {
  const ua = navigator.userAgent;
  const uaData = (navigator as any).userAgentData;

  let platform = "inconnu";
  let version = "inconnu";
  let arch = "inconnu";

  // Tenter userAgentData (Chrome/Edge moderne)
  if (uaData?.platform) {
    platform = uaData.platform;
    arch = uaData.architecture || arch;
    // Chercher la version Windows dans les brands
    const brands = uaData.brands || [];
    for (const b of brands) {
      if (b.brand === "Windows" || b.brand === "Microsoft Windows") {
        version = b.version;
        break;
      }
    }
    // Fallback : parser la version depuis platform
    if (version === "inconnu" && platform.toLowerCase().includes("windows")) {
      const m = ua.match(/Windows NT (\d+\.\d+)/);
      if (m)
        version =
          parseFloat(m[1]) >= 10.1
            ? "11"
            : parseFloat(m[1]) >= 10.0
              ? "10"
              : m[1];
    }
  }

  // Fallback userAgent classique
  if (platform === "inconnu") {
    if (ua.includes("Windows")) {
      platform = "Windows";
      const m = ua.match(/Windows NT (\d+\.\d+)/);
      if (m) {
        const nt = parseFloat(m[1]);
        version =
          nt >= 10.1 ? "11" : nt >= 10.0 ? "10" : nt >= 6.3 ? "8.1" : m[1];
      }
      arch =
        ua.includes("WOW64") || ua.includes("Win64") || ua.includes("x64")
          ? "x64"
          : "x86";
    } else if (ua.includes("Mac")) {
      platform = "macOS";
    } else if (ua.includes("Linux")) {
      platform = "Linux";
    }
  }

  const isWin11 =
    platform.toLowerCase().includes("windows") && version === "11";

  return { platform, version, arch, isWin11 };
}

function getBattery(): BrowserDiag["battery"] {
  // getBattery() est asynchrone — on le gère en lazy
  return { level: null, charging: null };
}

async function fetchBattery(): Promise<{
  level: number | null;
  charging: boolean | null;
}> {
  try {
    if (!(navigator as any).getBattery) return { level: null, charging: null };
    const b = await (navigator as any).getBattery();
    return {
      level: b.level != null ? Math.round(b.level * 100) : null,
      charging: b.charging,
    };
  } catch {
    return { level: null, charging: null };
  }
}

function getNetwork(): BrowserDiag["network"] {
  const conn =
    (navigator as any).connection ||
    (navigator as any).mozConnection ||
    (navigator as any).webkitConnection;
  return {
    downlink: conn?.downlink ?? null,
    rtt: conn?.rtt ?? null,
    type: conn?.effectiveType ?? null,
    online: navigator.onLine,
  };
}

// ── Score ─────────────────────────────────────────────────────────

function computeScore(data: BrowserDiag): {
  score: number;
  alerts: BrowserAlert[];
} {
  const alerts: BrowserAlert[] = [];
  const checks: boolean[] = [];

  // RAM
  if (data.ram.deviceMemoryGB !== null) {
    if (data.ram.deviceMemoryGB >= 16) {
      checks.push(true);
      alerts.push({
        level: "ok",
        category: "RAM",
        title: "16 Go ou plus — confortable",
      });
    } else if (data.ram.deviceMemoryGB >= 8) {
      checks.push(true);
      alerts.push({
        level: "ok",
        category: "RAM",
        title: "8 Go — suffisant pour la plupart des usages",
      });
    } else if (data.ram.deviceMemoryGB >= 4) {
      checks.push(false);
      alerts.push({
        level: "warning",
        category: "RAM",
        title: "4 Go — peut ralentir avec plusieurs applications ouvertes",
      });
    } else {
      checks.push(false);
      alerts.push({
        level: "critical",
        category: "RAM",
        title: "Moins de 4 Go — passage à 8 Go fortement recommandé",
      });
    }
  }

  // GPU
  const gpu = data.gpu.renderer.toLowerCase();
  if (gpu.includes("microsoft basic") || gpu.includes("gdi generic")) {
    checks.push(false);
    alerts.push({
      level: "critical",
      category: "GPU",
      title: "Pas de pilote GPU dédié — performances graphiques très limitées",
    });
  } else if (gpu === "inconnu" || gpu.includes("bloquée")) {
    alerts.push({
      level: "warning",
      category: "GPU",
      title:
        "Impossible d'identifier la carte graphique (navigateur restrictif)",
    });
  } else {
    checks.push(true);
    const shortName =
      data.gpu.renderer.length > 50
        ? data.gpu.renderer.slice(0, 47) + "..."
        : data.gpu.renderer;
    alerts.push({ level: "ok", category: "GPU", title: shortName });
  }

  // CPU cores
  if (data.cpu.cores >= 8) {
    checks.push(true);
  } else if (data.cpu.cores >= 4) {
    checks.push(true);
  } else {
    checks.push(false);
    alerts.push({
      level: "warning",
      category: "CPU",
      title: "Moins de 4 cœurs — peut limiter le multitâche",
    });
  }

  // OS
  const isOldOS =
    data.os.platform === "Windows" &&
    data.os.version !== "11" &&
    data.os.version !== "10";
  if (isOldOS) {
    checks.push(false);
    alerts.push({
      level: "critical",
      category: "Système",
      title:
        "Windows " +
        data.os.version +
        " n'est plus supporté — risque de sécurité",
    });
  }

  // Réseau
  if (!data.network.online) {
    checks.push(false);
    alerts.push({
      level: "critical",
      category: "Réseau",
      title: "Pas de connexion internet",
    });
  } else if (data.network.downlink !== null && data.network.downlink < 2) {
    alerts.push({
      level: "warning",
      category: "Réseau",
      title: "Connexion très lente (" + data.network.downlink + " Mbps)",
    });
  }

  // Calcul du score
  const passed = checks.filter(Boolean).length;
  const total = checks.length || 1;
  const score = Math.round((passed / total) * 100);

  return { score, alerts };
}

// ── Point d'entrée principal ──────────────────────────────────────

export async function runBrowserScan(): Promise<BrowserResult> {
  const gpu = getGPU();
  const os = getOS();
  const network = getNetwork();

  const data: BrowserDiag = {
    cpu: {
      cores: navigator.hardwareConcurrency || 0,
      arch: os.arch,
    },
    ram: {
      deviceMemoryGB: (navigator as any).deviceMemory ?? null,
      estimated: (navigator as any).deviceMemory
        ? (navigator as any).deviceMemory + " Go"
        : "inconnu",
    },
    gpu,
    os,
    screen: {
      width: screen.width,
      height: screen.height,
      pixelRatio: window.devicePixelRatio || 1,
    },
    network,
    battery: getBattery(),
    performance: {
      jsHeapMB: (performance as any).memory?.usedJSHeapSize
        ? Math.round((performance as any).memory.usedJSHeapSize / (1024 * 1024))
        : null,
    },
  };

  // Batterie (async)
  const battery = await fetchBattery();
  data.battery = battery;

  // Score
  const { score, alerts } = computeScore(data);

  const result: BrowserResult = { data, score, alerts, isWin11: os.isWin11 };

  // Envoyer au widget
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("sospc:browser-scan-done", { detail: result }),
    );
  }

  return result;
}

// ── Auto-exécution ────────────────────────────────────────────────

// Si importé en tant que module lazy dans diagnostic-widget.ts,
// c'est le widget qui appelle runBrowserScan().
// Si chargé directement, on auto-exécute.
if (
  typeof document !== "undefined" &&
  document.getElementById("sospc-widget")
) {
  runBrowserScan();
}
