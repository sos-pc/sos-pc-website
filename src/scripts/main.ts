import "./diagnostic-widget.ts";

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = "1";
        entry.target.style.transform = "translateY(0)";
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.05 }
);

document
  .querySelectorAll(
    ".service-card-new, .portfolio-card, .info-card, .stat"
  )
  .forEach((el, idx) => {
    const rect = el.getBoundingClientRect();
    const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
    if (!isVisible) {
      (el as HTMLElement).style.opacity = "0";
      (el as HTMLElement).style.transform = "translateY(20px)";
      (el as HTMLElement).style.transition =
        "opacity 0.4s ease " +
        Math.min(idx * 0.02, 0.1) +
        "s, transform 0.4s ease " +
        Math.min(idx * 0.02, 0.1) +
        "s";
      observer.observe(el);
    }
  });

function formatDiagMeta(data: any) {
  const parts: string[] = [];
  if (data.generated) parts.push(data.generated);
  if (data.score != null) parts.push("Score " + data.score + "/100");
  const problemCount = (data.issues || []).filter(
    (i: any) => i.level !== "ok"
  ).length;
  if (problemCount)
    parts.push(
      problemCount + " problème" + (problemCount > 1 ? "s" : "") + " détecté" + (problemCount > 1 ? "s" : "")
    );
  if ((data.symptoms_user || []).length)
    parts.push(data.symptoms_user.length + " symptôme(s) décrits");
  return parts.join(" · ");
}

function attachDiagToForm(data: any) {
  try {
    (document.getElementById("diagnostic-data") as HTMLInputElement).value =
      data.text || JSON.stringify(data, null, 2);
  } catch {}
  const metaEl = document.getElementById("dab-meta-text");
  if (metaEl) metaEl.textContent = formatDiagMeta(data);
  const banner = document.getElementById("diag-attach-banner");
  if (banner) banner.style.display = "flex";
  const label = document.getElementById("contact-submit-label");
  if (label) label.textContent = "Envoyer + diagnostic joint";
  const subject = document.querySelector(
    'input[name="subject"]'
  ) as HTMLInputElement;
  if (subject && !subject.value) {
    subject.value =
      "Suite diagnostic SOS-PC du " +
      (data.generated || new Date().toLocaleDateString("fr-FR"));
  }
}

(window as any).sospcDetachDiag = function () {
  try {
    (document.getElementById("diagnostic-data") as HTMLInputElement).value = "";
  } catch {}
  const banner = document.getElementById("diag-attach-banner");
  if (banner) banner.style.display = "none";
  const label = document.getElementById("contact-submit-label");
  if (label) label.textContent = "Envoyer le message";
  const subject = document.querySelector(
    'input[name="subject"]'
  ) as HTMLInputElement;
  if (subject && subject.value.startsWith("Suite diagnostic"))
    subject.value = "";
};

window.addEventListener("sospc:attach-diag", (e: any) =>
  attachDiagToForm(e.detail)
);
window.addEventListener("sospc:attach-diag-update", (e: any) =>
  attachDiagToForm(e.detail)
);
window.addEventListener("sospc:diag-reset", () =>
  (window as any).sospcDetachDiag()
);

document.addEventListener("DOMContentLoaded", function () {
  try {
    const raw = localStorage.getItem("sospc_diagnostic_v1");
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved.diagReport) return;
    const userMsgs = (saved.chatHistory || [])
      .filter((m: any) => m.role === "user")
      .map((m: any) => m.content);
    const meta = {
      generated: saved.savedAt
        ? new Date(saved.savedAt).toLocaleString("fr-FR")
        : "—",
      score: saved.diagReport.score,
      issues: saved.diagReport.issues || [],
      symptoms_user: userMsgs,
      text: saved.diagReport.summary || "",
    };
    attachDiagToForm(meta);
  } catch {}
});

(function () {
  const script = document.createElement("script");
  script.src =
    "https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie_light.min.js";
  script.onload = function () {
    document.querySelectorAll("[data-lottie-src]").forEach((el) => {
      const src = el.getAttribute("data-lottie-src");
      if (src) {
        const anim = (window as any).lottie.loadAnimation({
          container: el,
          renderer: "svg",
          loop: true,
          autoplay: false,
          path: src,
        });
        const card = el.closest(".service-card-new");
        if (card) {
          card.addEventListener("mouseenter", () => anim.play());
          card.addEventListener("mouseleave", () => anim.pause());
        }
      }
    });
  };
  document.head.appendChild(script);
})();
