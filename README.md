# SOS-PC — Site Vitrine

Site vitrines pour **SOS-PC**, entreprise de dépannage informatique, création web et hébergement basée au Castellet (04700).

**Demo :** [sos-pc.click](https://sos-pc.click)

## Stack

- [Astro](https://astro.build) v4 (SSG)
- CSS custom (dark/light mode)
- Lottie animations
- Netlify Forms + Netlify Functions (diagnostic IA)

## Structure

```
src/
├── components/
│   ├── AsciiBackground.astro    Fond ASCII interactif
│   ├── Contact.astro            Formulaire Netlify + liens
│   ├── CoverPage.astro          Page d'accueil animée
│   ├── Diagnostic.astro         Section diagnostic IA
│   ├── DiagnosticWidget.astro   Chatbot flottant
│   ├── Footer.astro
│   ├── Hero.astro               Terminal bash
│   ├── Location.astro           Google Maps
│   ├── Navbar.astro             Navigation fixe + thème
│   ├── Portfolio.astro          Réalisations
│   ├── Services.astro           4 services + Lottie
│   └── About.astro              Stats + info cards
├── layouts/
│   └── Layout.astro             SEO, meta, fonts, thème
├── pages/
│   ├── index.astro
│   └── contact-success.astro
├── scripts/
│   ├── diagnostic-widget.ts     Logique du chatbot diagnostic
│   └── main.ts                  Scroll animations, Lottie, form attach
└── styles/
    └── global.css               Variables CSS, base, widget

public/                           Assets statiques (images, Lottie JSON)
```

## Développement

```bash
npm install
npm run dev
```

Si erreur de mémoire (OOM) :

```powershell
$env:NODE_OPTIONS="--max-old-space-size=8192"; npm run dev
```

## Build

```bash
npm run build
```

Le output se trouve dans `dist/`.

## Déploiement (Netlify)

- **Build command :** `npm run build`
- **Publish directory :** `dist`
- **Forms :** le formulaire `contact` est géré par Netlify Forms
- **Redirects :** configurés dans `netlify.toml`

## Fonctionnalités

- Thème sombre/clair avec persistance (`localStorage`)
- Page d'accueil type "cover" avec interactions scroll/drag
- Fond ASCII animé réactif à la souris
- Terminal bash décoratif (hero + diagnostic)
- Animations Lottie sur les cartes services (hover)
- Widget de diagnostic PC flottant (draggable, chat IA, rapport détaillé)
- Formulaire de contact avec pièce jointe diagnostic
- SEO complet (Open Graph, Twitter Cards, JSON-LD)
- Responsive design

## Services externes

- **Diagnostic IA :** `sos-pc-diagnostic.netlify.app` (API poll/analyze/chat)
- **Script PowerShell :** `sos-pc.click/diag.ps1` (redirect vers le site diagnostic)
