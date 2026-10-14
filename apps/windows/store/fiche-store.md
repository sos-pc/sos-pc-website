# Soumission Microsoft Store — Talos Diagnostic

Tout ce qu'il faut saisir dans Partner Center, dans l'ordre des pages de la
soumission. Les fichiers à déposer sont dans ce dossier :

| Fichier | Où le déposer |
|---|---|
| `../out/TalosDiagnostic_<version>_x64.msix` (construit par `build.ps1`) | Packages |
| `screenshots/1-accueil.png`, `2-analyse.png`, `3-termine.png` (1920×1080) | Store listings → Screenshots (Desktop) |
| `app-tile-300.png` | Store listings → Store logos → 1:1 App tile icon (300 × 300) |

## 0. Nom réservé et build

| Cas | Nom à réserver | Commande de build |
|---|---|---|
| Test privé (compte individuel, en attendant le compte entreprise) | `Talos Diagnostic Test` | `./apps/windows/build.ps1 -DisplayName "Talos Diagnostic Test" -IdentityName "<…>" -Publisher "<…>" -PublisherDisplayName "<…>"` |
| Version publique (compte entreprise) | `Talos Diagnostic` | `./apps/windows/build.ps1 -IdentityName "<…>" -Publisher "<…>" -PublisherDisplayName "<…>"` |

Les trois valeurs `<…>` viennent de **Product management → Product identity** :
`Package/Identity/Name`, `Package/Identity/Publisher`,
`Package/Properties/PublisherDisplayName`. Le nom affiché du package doit être
un nom réservé, sinon Partner Center refuse le fichier.

## 1. Pricing and availability

- **Markets** : laisser la valeur par défaut (tous les marchés).
- **Audience** :
  - test → **Private audience**, avec un groupe contenant l'adresse du compte
    Microsoft *personnel* utilisé dans le Microsoft Store du PC de test ;
  - version publique → **Public audience**.
  - Attention : une fois soumis en *Public audience*, on ne peut plus revenir
    en *Private audience*.
- **Discoverability** : valeur par défaut.
- **Base price** : **Free**.

## 2. Properties

- **Category** : `Utilities + tools` (pas de sous-catégorie).
- **Privacy policy** : oui, l'app transmet des informations personnelles →
  `https://www.talos-int.com/man/legal/#rgpd`
- **Website** : `https://www.talos-int.com`
- **Support contact info** : `contact@talos-int.com`
- **Product declarations / System requirements** : laisser les valeurs par défaut.

## 3. Age ratings

Questionnaire IARC : l'app ne contient ni violence ni contenu sensible, pas
d'achats, pas de partage de localisation, pas d'échanges entre utilisateurs,
pas de navigation web intégrée (elle ouvre le navigateur du PC). Répondre
**Non** à ces questions.

## 4. Packages

Déposer le `.msix`. Partner Center détecte la famille d'appareils
(Windows Desktop) depuis le manifeste.

## 5. Store listings — Français (France)

### Description

```
Talos Diagnostic analyse votre PC Windows en 15 secondes environ et vous présente un bilan clair sur talos-int.com : score de santé, problèmes détectés et actions conseillées, avec un assistant IA pour répondre à vos questions.

Ce qui est analysé
• Processeur, mémoire, disques (espace libre et état de santé) et carte graphique
• Version de Windows, mises à jour, antivirus et pare-feu
• Erreurs système, arrêts brutaux et programmes qui ont planté ces 7 derniers jours
• Programmes installés et programmes lancés au démarrage

Comment ça marche
1. Cliquez sur « Lancer l'analyse ».
2. Le rapport est envoyé de façon sécurisée (HTTPS) à Talos Int.
3. Vos résultats s'ouvrent dans votre navigateur.

Votre vie privée
L'application lit uniquement des informations techniques. Elle ne lit jamais vos fichiers, photos, mots de passe ni votre historique de navigation. Elle ne modifie rien sur votre PC et fonctionne sans droits administrateur. Les rapports sont supprimés de nos serveurs dès leur affichage, et au plus tard 24 heures après l'envoi.

Besoin d'aide ? Talos Int. intervient à Oraison (04) et à distance partout en France.
```

### What's new in this version

```
Première version.
```

### App features (une ligne par champ)

```
Analyse complète du PC en 15 secondes environ
Santé des disques, espace libre et mémoire
Erreurs système, arrêts brutaux et programmes qui plantent
Antivirus, pare-feu et mises à jour Windows
Résultats expliqués simplement, avec des actions conseillées
Aucun droit administrateur, rien n'est modifié sur le PC
Rapport supprimé de nos serveurs sous 24 heures maximum
```

### Screenshots (Desktop) et légendes

| Fichier | Légende |
|---|---|
| `screenshots/1-accueil.png` | Avant l'analyse : ce qui est lu, et ce qui ne l'est jamais. |
| `screenshots/2-analyse.png` | Une analyse d'environ 15 secondes, sans droits administrateur. |
| `screenshots/3-termine.png` | Vos résultats et les conseils de l'IA s'ouvrent dans votre navigateur. |

### Store logos

`app-tile-300.png` dans **1:1 App tile icon (300 x 300)**.

### Keywords (search terms)

```
diagnostic PC
dépannage informatique
PC lent
santé du PC
réparation PC
analyse Windows
Talos Int.
```

### Copyright and trademark info / Developed by

```
© 2026 Talos Int.
```
```
Talos Int.
```

## 6. Submission options

### Notes for certification (en anglais pour les testeurs Microsoft)

```
Talos Diagnostic is a free PC health check for Windows by Talos Int., a computer repair business in France. The user interface is in French.

How to test: launch the app and click "Lancer l'analyse" (Start analysis). The scan takes about 10 to 20 seconds. The report is then sent over HTTPS to https://www.talos-int.com/api/diag/collect and the results page https://www.talos-int.com/?diag=<token> opens in the default browser, where the diagnosis is shown.

No account, login or test credentials are needed. The app runs without administrator rights, only reads system information and does not modify the PC. The website talos-int.com is online and must be reachable.

The app also registers the talos-diag: protocol so the website can start a scan; the protocol carries no data.

Privacy policy: https://www.talos-int.com/man/legal/#rgpd
```

### Restricted capabilities — runFullTrust

```
Talos Diagnostic is a desktop application (WPF, .NET Framework 4.8) packaged as MSIX, so it requires runFullTrust to run outside the AppContainer. It performs a read-only health check of the PC, started only when the user clicks "Lancer l'analyse" (Start analysis). The information it reads is not available to sandboxed apps:
- WMI classes for hardware and system state (Win32_OperatingSystem, Win32_Processor, Win32_VideoController, Win32_LogicalDisk, MSFT_PhysicalDisk, Windows Defender and Windows Security Center status) and raw performance counters;
- the Windows Firewall API (HNetCfg.FwPolicy2) to report whether the firewall is on;
- the System and Application event logs, to detect recent errors, unexpected shutdowns and application crashes;
- registry keys and the Startup folders that list installed programs and programs launched at startup.
Nothing on the system is modified. The resulting report is sent to the publisher's website (talos-int.com) to display the diagnosis, as described in the privacy policy.
```

## 7. Après la certification

- Lien d'installation du test privé : **Product identity** → *URL if your app is
  only visible to certain people (requires authentication)*. L'ouvrir avec le
  compte Microsoft personnel du groupe.
- Tester sur talos-int.com : dans la console du navigateur,
  `localStorage.setItem("talos_app_preview", "1")`, recharger, ouvrir le
  widget, cliquer sur **Lancer le diagnostic**.
- Version publique : renseigner l'ID Store dans `STORE_PRODUCT_ID`
  (`src/scripts/diagnostic-widget.ts`) et adapter `src/components/Diagnostic.astro`.
