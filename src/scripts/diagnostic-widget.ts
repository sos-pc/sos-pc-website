const STORAGE_DIAG = "sospc_diagnostic_v1";
const STORAGE_POS = "sospc_position_v1";

let isOpen = false;
let diagData: any = null;
let diagReport: any = null;
let chatHistory: { role: string; content: string }[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;
let sessionId: string | null = null;

let dragStartX = 0, dragStartY = 0;
let dragOffsetX = 0, dragOffsetY = 0;
let hasMoved = false, isDragging = false;

function playNotification() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    [[880, 440, 0.18, 0.25], [1320, 660, 0.08, 0.18]].forEach(([freq, endFreq, vol, dur]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + (dur as number) * 0.5);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(vol as number, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (dur as number));
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + (dur as number));
    });
  } catch {}
}

function getWidget() { return document.getElementById("sospc-widget")!; }

function positionWidget(x: number, y: number, animate: boolean) {
  const el = getWidget();
  const rect = el.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  x = Math.max(16, Math.min(x, w - rect.width - 16));
  y = Math.max(16, Math.min(y, h - rect.height - 16));
  if (animate) {
    el.classList.add("sospc-snapping");
    setTimeout(() => el.classList.remove("sospc-snapping"), 400);
  }
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.left = x + "px";
  el.style.top = y + "px";
  try { localStorage.setItem(STORAGE_POS, JSON.stringify({ x, y })); } catch {}
}

function snapToEdge() {
  const el = getWidget();
  const rect = el.getBoundingClientRect();
  const isRight = rect.left + rect.width / 2 > window.innerWidth / 2;
  const x = isRight ? window.innerWidth - rect.width - 16 : 16;
  positionWidget(x, rect.top, true);
}

function clampOpenPosition() {
  const el = getWidget();
  const rect = el.getBoundingClientRect();
  const w = window.innerWidth, h = window.innerHeight;
  const panelW = Math.min(360, w - 16 * 2);
  let x = rect.left, y = rect.top;
  if (x + panelW > w - 16) x = w - panelW - 16;
  if (x < 16) x = 16;
  const panelH = Math.min(520, h * 0.8);
  if (y + panelH > h - 16) y = h - panelH - 16;
  if (y < 16) y = 16;
  if (Math.abs(x - rect.left) > 1 || Math.abs(y - rect.top) > 1) {
    positionWidget(x, y, true);
  }
}

function restorePosition() {
  try {
    const saved = localStorage.getItem(STORAGE_POS);
    if (!saved) return;
    const { x, y } = JSON.parse(saved);
    const el = getWidget();
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.left = x + "px";
    el.style.top = y + "px";
  } catch {}
}

function initDrag() {
  [document.getElementById("sospc-fab-content"), document.getElementById("sospc-header")].forEach(el => {
    if (!el) return;
    el.addEventListener("pointerdown", (e: Event) => {
      const pe = e as PointerEvent;
      if ((pe.target as Element).closest("button")) return;
      pe.preventDefault();
      (el as HTMLElement).setPointerCapture(pe.pointerId);
      const rect = getWidget().getBoundingClientRect();
      dragStartX = pe.clientX; dragStartY = pe.clientY;
      dragOffsetX = pe.clientX - rect.left;
      dragOffsetY = pe.clientY - rect.top;
      hasMoved = false; isDragging = true;
      getWidget().classList.add("sospc-dragging");
    });
    el.addEventListener("pointermove", (e: Event) => {
      const pe = e as PointerEvent;
      if (!isDragging) return;
      if (Math.abs(pe.clientX - dragStartX) > 6 || Math.abs(pe.clientY - dragStartY) > 6) hasMoved = true;
      if (hasMoved) positionWidget(pe.clientX - dragOffsetX, pe.clientY - dragOffsetY, false);
    });
    el.addEventListener("pointerup", (e: Event) => {
      const pe = e as PointerEvent;
      if (!isDragging) return;
      isDragging = false;
      getWidget().classList.remove("sospc-dragging");
      (el as HTMLElement).releasePointerCapture(pe.pointerId);
      if (hasMoved && !isOpen) snapToEdge();
      if (!hasMoved) setTimeout(() => (window as any).sospcToggle(), 10);
      hasMoved = false;
    });
    el.addEventListener("pointercancel", () => {
      isDragging = false; hasMoved = false;
      getWidget().classList.remove("sospc-dragging");
    });
  });
}

(window as any).sospcToggle = function () {
  const el = getWidget();
  isOpen = !isOpen;
  if (isOpen) {
    el.classList.remove("sospc-closed");
    el.classList.add("sospc-open");
    setTimeout(clampOpenPosition, 50);
    if (!diagData && !pollInterval) startPolling();
    if (diagData) setTimeout(() => { const inp = document.getElementById("sospc-input") as HTMLInputElement; inp?.focus(); }, 300);
  } else {
    el.classList.remove("sospc-open");
    el.classList.add("sospc-closed");
    setTimeout(snapToEdge, 50);
  }
  (document.getElementById("sospc-fab-badge") as HTMLElement).style.display = "none";
};

function saveState() {
  try {
    localStorage.setItem(STORAGE_DIAG, JSON.stringify({
      diagData, diagReport, chatHistory, savedAt: Date.now()
    }));
  } catch {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_DIAG);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function clearState() {
  try { localStorage.removeItem(STORAGE_DIAG); } catch {}
}

function genSessionId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function buildCommand(id: string) {
  return `$s='${id}'; irm https://sos-pc.click/diag.ps1 | iex`;
}

(window as any).sospcCopy = function () {
  navigator.clipboard.writeText((document.getElementById("sospc-cmd") as HTMLElement).textContent || "").then(() => {
    const btn = document.getElementById("sospc-copy-btn") as HTMLElement;
    btn.textContent = "Copié !";
    btn.classList.add("copied");
    (document.getElementById("sospc-waiting-indicator") as HTMLElement).style.display = "flex";
    setTimeout(() => { btn.textContent = "Copier"; btn.classList.remove("copied"); }, 2500);
  });
};

(window as any).sospcReset = function () {
  if (confirm("Lancer un nouveau scan ?")) {
    stopPolling();
    clearState();
    sessionStorage.setItem("sospc_reset", "1");
    sessionStorage.setItem("sospc_fresh_session", "true");
    sessionId = genSessionId();
    (document.getElementById("sospc-cmd") as HTMLElement).textContent = buildCommand(sessionId);
    (document.getElementById("sospc-view-diag") as HTMLElement).style.display = "none";
    (document.getElementById("sospc-view-waiting") as HTMLElement).style.display = "block";
    (document.getElementById("sospc-waiting-indicator") as HTMLElement).style.display = "none";
    (document.getElementById("sospc-header-sub") as HTMLElement).textContent = "Diagnostic intelligent";
    (document.getElementById("sospc-fab-text") as HTMLElement).textContent = "Diagnostic PC";
    (document.getElementById("sospc-messages") as HTMLElement).innerHTML = "";
    (document.getElementById("sospc-suggestions") as HTMLElement).innerHTML = "";
    (document.getElementById("sospc-attach-bar") as HTMLElement).style.display = "none";
    window.dispatchEvent(new CustomEvent("sospc:diag-reset"));
    startPolling();
  }
};

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    try {
      const res = await (await fetch(`https://sos-pc-diagnostic.netlify.app/api/poll?s=${sessionId}`)).json();
      if (res.ready && res.data) {
        stopPolling();
        diagData = res.data;
        (document.getElementById("sospc-waiting-indicator") as HTMLElement).style.display = "none";
        playNotification();
        if (!isOpen) {
          isOpen = true;
          getWidget().classList.remove("sospc-closed");
          getWidget().classList.add("sospc-open");
          setTimeout(clampOpenPosition, 50);
        }
        analyzeData();
      }
    } catch {}
  }, 2000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function showDiagView() {
  (document.getElementById("sospc-view-waiting") as HTMLElement).style.display = "none";
  const v = document.getElementById("sospc-view-diag") as HTMLElement;
  v.style.display = "flex";
  v.style.flexDirection = "column";
}

function addMessage(type: string, text: string) {
  const el = document.getElementById("sospc-messages") as HTMLElement;
  const div = document.createElement("div");
  div.className = "sospc-msg " + type;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

function renderHistory() {
  const el = document.getElementById("sospc-messages") as HTMLElement;
  el.innerHTML = "";
  chatHistory.forEach(m => {
    const div = document.createElement("div");
    div.className = "sospc-msg " + (m.role === "user" ? "user" : "bot");
    div.textContent = m.content;
    el.appendChild(div);
  });
  el.scrollTop = el.scrollHeight;
}

function setScore(score: number) {
  const fill = document.getElementById("sospc-score-fill") as HTMLElement;
  fill.style.background = score >= 70 ? "#00d4aa" : score >= 40 ? "#e0af68" : "#f7768e";
  (document.getElementById("sospc-score-val") as HTMLElement).textContent = score + "/100";
  setTimeout(() => fill.style.width = score + "%", 100);
}

function showSuggestions(items: string[]) {
  const el = document.getElementById("sospc-suggestions") as HTMLElement;
  el.innerHTML = "";
  items.forEach(text => {
    const btn = document.createElement("button");
    btn.className = "sospc-suggestion";
    btn.textContent = text;
    btn.onclick = () => {
      el.innerHTML = "";
      (document.getElementById("sospc-input") as HTMLInputElement).value = text;
      (window as any).sospcSend();
    };
    el.appendChild(btn);
  });
}

function buildFullReport() {
  const d = diagData || {};
  const r = diagReport || {};
  const lines: string[] = [];
  const sep = "=".repeat(52);
  const dash = "-".repeat(52);

  lines.push(sep);
  lines.push("  RAPPORT DIAGNOSTIC SOS-PC");
  lines.push("  " + new Date().toLocaleString("fr-FR"));
  lines.push(sep);
  lines.push("");

  const score = r.score != null ? r.score : "?";
  const status = r.score >= 70 ? "Bon état" : r.score >= 40 ? "Attention requise" : "État critique";
  lines.push("SCORE : " + score + "/100  -- " + status);
  lines.push("");

  // Security alert
  const sec = d.security || {};
  if (sec.defender_enabled === false || sec.realtime_protection === false) {
    lines.push("/!\\ ALERTE SÉCURITÉ /!\\");
    if (sec.defender_enabled === false) lines.push("  >> Antivirus Windows Defender INACTIF");
    if (sec.realtime_protection === false) lines.push("  >> Protection en temps réel INACTIVE");
    if (sec.antivirus_signature_date) lines.push("  >> Dernières signatures : " + sec.antivirus_signature_date);
    lines.push("");
  }

  if (r.summary) { lines.push("RÉSUMÉ"); lines.push(r.summary); lines.push(""); }

  lines.push(dash);
  lines.push("SYSTÈME");
  lines.push(dash);
  const os = d.os || {};
  lines.push("OS           : " + (os.name || os.caption || "?"));
  lines.push("Version      : " + (os.version || "?") + " (Build " + (os.build || "?") + ")");
  lines.push("Architecture : " + (os.arch || "?"));
  lines.push("Uptime       : " + (os.uptime || "?") + "h");
  lines.push("Dernier boot : " + (os.last_boot || "?"));
  lines.push("");

  const cpu = d.cpu || {};
  lines.push("CPU          : " + (cpu.name || "?"));
  lines.push("Coeurs       : " + (cpu.cores || "?") + " coeurs / " + (cpu.threads || "?") + " threads");
  lines.push("Charge       : " + (cpu.load != null ? cpu.load + "%" : "?"));
  lines.push("");
  lines.push("RAM total    : " + (os.ram_total_gb || "?") + " Go");
  const ramPct = os.ram_total_gb && os.ram_free_gb ? Math.round((1 - os.ram_free_gb / os.ram_total_gb) * 100) : "?";
  lines.push("RAM libre    : " + (os.ram_free_gb || "?") + " Go  (" + ramPct + "% utilisée)");
  if (os.pagefile_total_gb) lines.push("Pagefile     : " + os.pagefile_used_gb + " / " + os.pagefile_total_gb + " Go");
  lines.push("");

  const gpus = (d.gpus || (d.gpu ? [d.gpu] : [])).filter(Boolean);
  if (gpus.length > 0) {
    lines.push("GPU(S)");
    gpus.forEach((g: any) => {
      lines.push("  " + (g.name || "?") + (g.ram_mb ? " -- " + g.ram_mb + " Mo VRAM" : "") + (g.driver ? " -- driver " + g.driver : "") + (g.driver_date ? " (" + g.driver_date + ")" : ""));
      if (g.resolution) lines.push("  Résolution : " + g.resolution + (g.refresh_hz ? " @ " + g.refresh_hz + "Hz" : ""));
    });
    lines.push("");
  }

  const disks = (d.disks || []).filter(Boolean);
  if (disks.length > 0) {
    lines.push("DISQUES LOGIQUES");
    disks.forEach((dk: any) => {
      const pct = dk.pct_used || 0;
      let bar = "";
      for (let i = 0; i < 10; i++) bar += i < Math.round(pct / 10) ? "#" : "-";
      lines.push("  " + dk.letter + "  [" + bar + "] " + pct + "%  --  " + dk.free_gb + " Go libres / " + dk.total_gb + " Go" + (dk.label ? " (" + dk.label + ")" : ""));
    });
    lines.push("");
  }

  const physDisks = (d.physical_disks || []).filter(Boolean);
  if (physDisks.length > 0) {
    lines.push("DISQUES PHYSIQUES (SMART)");
    physDisks.forEach((dk: any) => {
      lines.push("  " + dk.friendly_name + " -- " + (dk.media_type || "?") + " / " + (dk.bus_type || "?") + " -- " + dk.size_gb + " Go");
      lines.push("  Santé : " + (dk.health_status || "?") + "  |  Heures : " + (dk.hours_used != null ? dk.hours_used + "h" : "?") + "  |  Temp : " + (dk.temperature_c != null ? dk.temperature_c + "°C" : "?"));
      if (dk.reallocated_sectors) lines.push("  ATTENTION : " + dk.reallocated_sectors + " secteurs défaillants");
      if (dk.read_errors) lines.push("  ATTENTION : " + dk.read_errors + " erreurs de lecture");
    });
    lines.push("");
  }

  const net = d.network || {};
  if (net.adapters && net.adapters.filter(Boolean).length > 0) {
    lines.push("RÉSEAU");
    lines.push("Internet     : " + (net.internet_ok ? "OK" : "ÉCHEC") + (net.dns_latency_ms ? "  (DNS: " + net.dns_latency_ms + "ms)" : ""));
    net.adapters.filter(Boolean).forEach((a: any) => {
      lines.push("  " + (a.type || "?") + " : " + a.name + (a.ip ? " -- " + a.ip : "") + (a.speed_mbps ? " -- " + a.speed_mbps + " Mbps" : ""));
    });
    lines.push("");
  }

  const security = d.security || {};
  if (Object.keys(security).length > 0) {
    lines.push("SÉCURITÉ");
    lines.push("Antivirus    : " + (security.defender_enabled ? "Actif" : "INACTIF") + "  |  Temps réel : " + (security.realtime_protection ? "Actif" : "INACTIF"));
    if (security.antivirus_signature_date) lines.push("Signatures   : " + security.antivirus_signature_date);
    lines.push("Pare-feu     : Domaine " + (security.firewall_domain ? "OK" : "OFF") + " / Privé " + (security.firewall_private ? "OK" : "OFF") + " / Public " + (security.firewall_public ? "OK" : "OFF"));
    lines.push("UAC          : " + (security.uac_enabled ? "Actif" : "Inactif"));
    lines.push("");
  }

  const temps = (d.temperatures || []).filter(Boolean);
  if (temps.length > 0) {
    lines.push("TEMPÉRATURES");
    temps.forEach((t: any) => { lines.push("  " + t.instance + " : " + t.temp_celsius + "°C"); });
    lines.push("");
  }

  const perf = d.performance || {};
  if (Object.keys(perf).length > 0) {
    lines.push("PERFORMANCE");
    if (perf.disk_pct_busy != null) lines.push("Disque I/O   : " + perf.disk_pct_busy + "%");
    if (perf.ram_used_pct != null) lines.push("RAM          : " + perf.ram_used_pct + "%");
    if (perf.pagefile_used_pct != null) lines.push("Pagefile     : " + perf.pagefile_used_pct + "%");
    lines.push("");
  }

  const stability = d.stability || {};
  if (stability.bsod_count > 0) {
    lines.push(dash);
    lines.push("CRASHS SYSTÈME 7 JOURS : " + stability.bsod_count);
    lines.push(dash);
    (stability.bsod_last_7days || []).forEach((b: any) => { lines.push("  [" + b.time + "] ID:" + b.id + " -- " + b.message); });
    lines.push("");
  }

  const issues = r.issues || [];
  if (issues.length > 0) {
    lines.push(dash);
    lines.push("PROBLÈMES DÉTECTÉS (" + issues.length + ")");
    lines.push(dash);
    issues.forEach((i: any) => {
      const lvl = i.level === "critical" ? "[CRITIQUE] " : i.level === "warning" ? "[ATTENTION]" : "[OK]       ";
      lines.push(lvl + " " + (i.category ? "[" + i.category + "] " : "") + i.title);
      if (i.description) lines.push("           " + i.description);
      if (i.action) lines.push("           Action : " + i.action);
      lines.push("");
    });
  }

  const quickWins = r.quick_wins || [];
  if (quickWins.length > 0) {
    lines.push("ACTIONS RAPIDES");
    quickWins.forEach((q: string, idx: number) => { lines.push("  " + (idx + 1) + ". " + q); });
    lines.push("");
  }

  const userSymptoms = chatHistory.filter(m => m.role === "user").map(m => m.content);
  if (userSymptoms.length > 0) {
    lines.push(dash);
    lines.push("SYMPTÔMES DÉCRITS PAR L'UTILISATEUR");
    lines.push(dash);
    userSymptoms.forEach((s: string, idx: number) => { lines.push("  " + (idx + 1) + '. "' + s + '"'); });
    lines.push("");
  }

  const startup = (d.startup || []).filter(Boolean);
  if (startup.length > 0) {
    lines.push("DÉMARRAGE AUTOMATIQUE (" + startup.length + " programmes)");
    startup.forEach((s: string) => { lines.push("  - " + s); });
    lines.push("");
  }

  const hotfixes = ((d.updates || {}).last_hotfixes || []).filter(Boolean);
  if (hotfixes.length > 0) {
    lines.push("DERNIÈRES MISES À JOUR");
    hotfixes.forEach((u: any) => { lines.push("  " + u.id + " -- " + u.description + " (" + u.installed_on + ")"); });
    lines.push("");
  }

  const procs = (d.procs || []).filter(Boolean);
  if (procs.length > 0) {
    lines.push("TOP PROCESSUS (RAM)");
    procs.forEach((p: any) => { lines.push("  " + p.name + " -- " + p.ram_mb + " Mo"); });
    lines.push("");
  }

  const software = (d.software || []).filter(Boolean);
  if (software.length > 0) {
    lines.push(dash);
    lines.push("LOGICIELS INSTALLÉS (" + software.length + ")");
    lines.push(dash);
    software.forEach((s: any) => {
      let line = "  " + s.name;
      if (s.version) line += "  v" + s.version;
      if (s.publisher) line += "  (" + s.publisher + ")";
      if (s.install_date) line += "  -- " + s.install_date;
      lines.push(line);
    });
    lines.push("");
  }

  lines.push(sep);
  lines.push("  Rapport SOS-PC -- sos-pc.click -- " + new Date().toLocaleString("fr-FR"));
  lines.push(sep);

  return {
    text: lines.join("\n"),
    generated: new Date().toLocaleString("fr-FR"),
    score: r.score,
    issues: r.issues || [],
    symptoms_user: userSymptoms,
  };
}

(window as any).sospcAttachToForm = function () {
  const report = buildFullReport();
  window.dispatchEvent(new CustomEvent("sospc:attach-diag", { detail: report }));
  const contact = document.getElementById("contact");
  contact?.scrollIntoView({ behavior: "smooth" });
  const btn = document.getElementById("sospc-attach-btn") as HTMLElement;
  if (btn) {
    btn.classList.add("attached");
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Diagnostic joint !';
    setTimeout(() => {
      btn.classList.remove("attached");
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg> Joindre au formulaire de contact';
    }, 2500);
  }
};

function analyzeData() {
  showDiagView();
  (document.getElementById("sospc-header-sub") as HTMLElement).textContent = "Analyse en cours...";
  const loadingMsg = addMessage("bot typing", "> analyse en cours...");

  fetch("https://sos-pc-diagnostic.netlify.app/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: diagData, problem: "" }),
  })
    .then(r => r.json())
    .then(data => {
      diagReport = data.report;
      loadingMsg.remove();
      setScore(diagReport?.score || 50);
      (document.getElementById("sospc-header-sub") as HTMLElement).textContent = "Diagnostic terminé";
      (document.getElementById("sospc-fab-text") as HTMLElement).textContent = "Voir le diagnostic";

      const summary = diagReport?.summary || "Analyse terminée.";
      addMessage("bot", summary);
      chatHistory.push({ role: "assistant", content: summary });

      const criticals = (diagReport?.issues || []).filter((i: any) => i.level === "critical");
      if (criticals.length) {
        const msg = "⚠ " + criticals.length + " problème(s) critique(s) : " + criticals.map((i: any) => i.title).join(", ") + ".";
        addMessage("bot", msg);
        chatHistory.push({ role: "assistant", content: msg });
      }

      if ((diagReport?.issues || []).some((i: any) => i.level !== "ok")) {
        const msg = "Nos techniciens peuvent résoudre ces problèmes. Voulez-vous être contacté ?";
        addMessage("bot", msg);
        chatHistory.push({ role: "assistant", content: msg });
      }

      showSuggestions(["Expliquer le problème", "Améliorer les perfs", "Contacter SOS-PC"]);
      saveState();
      (document.getElementById("sospc-attach-bar") as HTMLElement).style.display = "block";
      window.dispatchEvent(new CustomEvent("sospc:attach-diag", { detail: buildFullReport() }));
    })
    .catch(() => {
      loadingMsg.remove();
      addMessage("bot", "Erreur d'analyse. Contactez-nous au 07 69 56 14 91.");
    });
}

(window as any).sospcSend = function () {
  const input = document.getElementById("sospc-input") as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  (document.getElementById("sospc-send") as HTMLButtonElement).disabled = true;
  (document.getElementById("sospc-suggestions") as HTMLElement).innerHTML = "";
  addMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  const loadingMsg = addMessage("bot typing", "...");

  fetch("https://sos-pc-diagnostic.netlify.app/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: chatHistory, systemData: diagData, report: diagReport }),
  })
    .then(r => r.json())
    .then(data => {
      loadingMsg.remove();
      const msg = data.message || "Erreur.";
      addMessage("bot", msg);
      chatHistory.push({ role: "assistant", content: msg });
      saveState();
      window.dispatchEvent(new CustomEvent("sospc:attach-diag-update", { detail: buildFullReport() }));
    })
    .catch(() => {
      loadingMsg.remove();
      addMessage("bot", "Erreur de connexion.");
    })
    .finally(() => {
      (document.getElementById("sospc-send") as HTMLButtonElement).disabled = false;
      input.focus();
    });
};

document.addEventListener("DOMContentLoaded", function () {
  initDrag();
  restorePosition();

  const saved = loadState();
  if (saved && saved.diagData && !sessionStorage.getItem("sospc_reset")) {
    diagData = saved.diagData;
    diagReport = saved.diagReport;
    chatHistory = saved.chatHistory || [];
    showDiagView();
    if (diagReport) setScore(diagReport.score || 50);
    renderHistory();
    if (diagReport) {
      showSuggestions(["Rappelle-moi le résumé", "Améliorer les perfs", "Contacter SOS-PC"]);
      (document.getElementById("sospc-attach-bar") as HTMLElement).style.display = "block";
    }
    (document.getElementById("sospc-header-sub") as HTMLElement).textContent = "Diagnostic sauvegardé";
    (document.getElementById("sospc-fab-text") as HTMLElement).textContent = "Voir le diagnostic";
    (document.getElementById("sospc-fab-badge") as HTMLElement).style.display = "flex";
  } else {
    sessionStorage.removeItem("sospc_reset");
    sessionId = genSessionId();
    (document.getElementById("sospc-cmd") as HTMLElement).textContent = buildCommand(sessionId);
  }
});
