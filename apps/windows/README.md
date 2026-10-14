# Talos Diagnostic — app Windows (Microsoft Store)

Petite app WPF (.NET Framework 4.8, déjà intégré à Windows 10 1903+ et 11) qui
remplace la commande PowerShell du widget de diagnostic :

1. elle collecte les mêmes informations que `public/diag.ps1`, sans lancer
   PowerShell et sans droits administrateur ;
2. elle génère son propre jeton, envoie le rapport à
   `https://www.talos-int.com/api/diag/collect` ;
3. elle ouvre `https://www.talos-int.com/?diag=<jeton>` : le widget affiche
   l'analyse de l'IA.

Elle est distribuée par le Microsoft Store, qui signe le package : aucun
avertissement SmartScreen, installation en 2 clics via le lien direct du Store.

## Lancements

| Origine | Comportement |
|---|---|
| Menu Démarrer / fin d'installation Store | écran d'accueil (ce qui est analysé) puis bouton « Lancer l'analyse » |
| Lien `talos-diag:scan` sur le site | l'analyse démarre directement (le visiteur a cliqué sur le site et confirmé la fenêtre du navigateur) |
| `TalosDiagnostic.exe --dump rapport.json` | collecte seule, écrit le rapport dans un fichier, n'envoie rien (support / tests) |
| `--origin https://<branche>--sos-pc-website-test-2.netlify.app --no-browser` | envoie à un aperçu Netlify (tests) ; seules ces adresses sont acceptées |

Sécurité : l'app n'accepte **jamais** de jeton venant de l'extérieur (lien,
page web). Sinon un site malveillant pourrait lancer l'app avec son propre
jeton et lire le rapport via `/api/diag/poll`.

## Construire

Prérequis : SDK .NET (8+), Windows SDK (makeappx, makepri). Depuis la racine du dépôt :

```powershell
./apps/windows/build.ps1
```

Résultat : `apps/windows/out/TalosDiagnostic_<version>_x64.msix` (non signé).
Le build GitHub (`.github/workflows/windows-app.yml`) produit le même fichier
en artefact à chaque modification de `apps/windows/`.

Après modification du logo (`branding/app-icon.svg`) : `node apps/windows/branding/render-assets.mjs`.

## Tester sans le Store

- **Collecte** : `apps/windows/out/bin/TalosDiagnostic.exe --dump rapport.json`
- **Parcours complet** : `TalosDiagnostic.exe --origin <aperçu Netlify>` envoie
  le rapport à l'aperçu et ouvre la page de résultats.
- **Lien `talos-diag:` (package installé)** : nécessite d'installer le MSIX. Hors
  Store, Windows exige soit le mode développeur (`Add-AppxPackage -Register
  apps/windows/out/layout/AppxManifest.xml`), soit un certificat de test
  approuvé sur le PC. Le plus simple est de passer par une soumission Store
  masquée (voir ci-dessous).
- **Widget côté site** : tant que `STORE_PRODUCT_ID` est vide dans
  `src/scripts/diagnostic-widget.ts`, les visiteurs gardent la commande
  PowerShell. Pour voir le parcours app sur un aperçu :
  `localStorage.setItem("talos_app_preview", "1")` dans la console.

## Publier sur le Microsoft Store

1. **Compte développeur** (gratuit pour les particuliers et les entreprises) :
   <https://storedeveloper.microsoft.com>, avec vérification d'identité.
2. **Réserver le nom** « Talos Diagnostic » dans Partner Center (Applications et
   jeux → Nouveau produit → Application MSIX ou PWA).
3. **Récupérer l'identité** : Gestion du produit → Identité du produit :
   `Package/Identity/Name`, `Package/Identity/Publisher`,
   `Package/Properties/PublisherDisplayName`, et l'**ID Store** (12 caractères).
4. **Construire le package Store** :
   ```powershell
   ./apps/windows/build.ps1 -IdentityName "<Identity/Name>" -Publisher "<Identity/Publisher>" -PublisherDisplayName "<PublisherDisplayName>" -Version 1.0.0.0
   ```
   `-DisplayName` (par défaut « Talos Diagnostic ») doit être un nom réservé
   pour le produit, par exemple `-DisplayName "Talos Diagnostic Test"` pour un
   produit de test. Pour que l'artefact du workflow GitHub soit directement
   prêt : variables `STORE_IDENTITY_NAME`, `STORE_PUBLISHER`,
   `STORE_PUBLISHER_DISPLAY_NAME` et `STORE_DISPLAY_NAME` dans GitHub →
   Settings → Variables.
5. **Soumission** : tous les champs, les textes à copier-coller, les captures
   et l'icône 300 × 300 sont dans [store/fiche-store.md](store/fiche-store.md).
   Pour tester avant d'ouvrir au public, utiliser **Private audience** (et non
   « disponible mais non découvrable », qui reste accessible à quiconque a le
   lien). Une fois soumis en *Public audience*, on ne peut plus revenir en privé.
6. **Activer le parcours app sur le site** une fois l'app certifiée : renseigner
   `STORE_PRODUCT_ID` dans `src/scripts/diagnostic-widget.ts`, et adapter la
   section Diagnostic de l'accueil (`src/components/Diagnostic.astro` : mention
   « aucune installation » et démonstration de la commande PowerShell).

Chaque nouvelle version : augmenter `-Version` (le dernier chiffre doit rester 0)
et `<Version>` dans `TalosDiagnostic.csproj`.
