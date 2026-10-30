# SimpleNode

Application de bureau pour construire des workflows de génération IA sous forme de graphe de nœuds : on relie des prompts, des images et des vidéos à des modèles (Nano Banana, Seedream, Kling, Veo, Seedance…), puis on exécute le graphe. Tous les modèles passent par [fal.ai](https://fal.ai).

Construite avec **Tauri 2** (backend Rust) et **Next.js + React Flow** (interface).

## Fonctionnalités

- **Canvas à nœuds** : glisser-déposer depuis la bibliothèque, clic droit pour ajouter un nœud, annuler / rétablir, liens colorés selon le type (texte, image, vidéo).
- **Nœuds** : Prompt, Import (image ou vidéo), Preview, Router, Prompt Concatenator, Crop, Prompt Enhancer, Image Describer, Video Describer, LLM.
- **Modèles d'image** : Nano Banana Pro / 2, Seedream 5.0 Lite / 4.5, GPT Image 2, FLUX.2 [pro], FLUX.1 Kontext [pro], Qwen Image Max, Recraft V4 Pro, Ideogram V3, FLUX.1 [schnell]. Avec des images reliées en référence, l'app utilise la version « édition » du modèle.
- **Modèles vidéo** : Kling 4 / 3 Pro / 2.5 Turbo Pro, MiniMax H3 / H3 Max, Seedance 2.5 / 2.0 / 1.0 Pro, Veo 3.1 / 3.1 Fast, Hailuo 02, Wan 2.5, LTX-2. Image de départ et de fin selon le modèle.
- **Seedance 2.5 Draft** : génère un brouillon 480p peu coûteux, puis le finalise en 1080p d'un clic (brouillon valable 7 jours chez fal).
- **Exécution** : « Tout exécuter » ou exécution d'un seul nœud. Les résultats déjà générés en amont sont réutilisés, pour ne pas payer deux fois.
- **Projets** : page d'accueil avec vos fichiers, miniatures, corbeille, sauvegarde automatique.
- **Réglages** : clé fal.ai, tarif de chaque modèle, dépenses réelles par modèle, gestion du stockage local.

## Prérequis

- **Node.js** 20 ou plus récent, et npm
- **Rust**, toolchain stable récente (testé avec 1.90) : <https://rustup.rs>
- **macOS** : Xcode ou les Command Line Tools
- **Windows / Linux** : les [prérequis système de Tauri](https://v2.tauri.app/start/prerequisites/)
- Une **clé API fal.ai** : <https://fal.ai/dashboard/keys>

## Installation

Pour simplement utiliser l'app sur une autre machine, inutile d'installer tout ça : voir [Installer sur une autre machine](#installer-sur-une-autre-machine).

Sur une machine neuve (macOS) :

```bash
# 1. Outils de compilation Apple
xcode-select --install

# 2. Rust, puis recharger le shell pour que `cargo` soit trouvé
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 3. Le projet et ses dépendances
git clone https://github.com/Heako/simplenode-public.git
cd simplenode
npm install
```

Node.js 20+ s'installe depuis <https://nodejs.org> ou avec `brew install node`.

`npm install` est à relancer après chaque clone : `node_modules` n'est pas versionné. Sans lui, `npm run tauri dev` échoue avec `tauri: command not found`.

L'interface ne fonctionne pas dans un navigateur seul (`npm run dev` sur `localhost:3000`). Elle dépend du backend Rust et plante au démarrage avec `Cannot read properties of undefined (reading 'invoke')`. Lancez toujours l'app avec `npm run tauri dev`.

## Lancer l'application

```bash
npm run tauri dev
```

La première compilation Rust prend quelques minutes. Les suivantes sont incrémentales.

Au premier lancement :

1. Ouvrez **Réglages** (en bas à gauche de l'accueil).
2. Collez votre clé fal.ai dans **Clé de génération**, puis cliquez sur **Tester**.
3. Revenez à **Mes fichiers**, créez un **Nouveau fichier**, ajoutez des nœuds et lancez **Tout exécuter**.

La clé est enregistrée dans le trousseau du système (Trousseau d'accès sur macOS), jamais dans les projets. En développement, la variable d'environnement `FAL_KEY` est utilisée si aucune clé n'est enregistrée.

### Voir ses dépenses

La section **Coûts** affiche les tarifs avec n'importe quelle clé. Pour les **dépenses réelles**, fal exige une clé créée avec le preset `BILLING` ou `FULL`. Ajoutez-la dans **Clé de facturation**, sinon l'app essaie avec la clé de génération. fal ne publie pas le solde par API : un lien mène à votre tableau de bord.

## Compiler une version distribuable

```bash
npm run tauri build
```

L'installeur est produit dans `src-tauri/target/release/bundle/` (`.app` et `.dmg` sur macOS).

### Installer sur une autre machine

Copiez le `.dmg` de `src-tauri/target/release/bundle/dmg/` sur l'autre Mac et installez l'app comme n'importe quelle autre. Node, Rust et Xcode ne sont pas nécessaires.

L'app n'est pas signée : au premier lancement, macOS la bloque. Faites clic droit → **Ouvrir**, ou allez dans Réglages Système → Confidentialité et sécurité → **Ouvrir quand même**.

## Problème connu : erreur de linker sur macOS 27

Avec les Command Line Tools de macOS 27, toute compilation Rust peut échouer avec :

```
ld: tapi error: malformed file
.../MacOSX27.0.sdk/usr/lib/libSystem.B.tbd: error: unknown architecture arm64e.x1-macos
```

Le SDK fourni contient une architecture que le linker installé ne reconnaît pas encore.

**Solution :** mettez Xcode à jour (corrigé avec **Xcode 27.1**), puis :

```bash
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
cd src-tauri && cargo clean && cargo build
```

Si vous ne pouvez pas mettre Xcode à jour, compilez contre un SDK plus ancien présent sur la machine (il ne contient pas le fichier en cause), en créant `src-tauri/.cargo/config.toml` (ignoré par git, car propre à chaque machine) avec `SDKROOT` pointant vers ce SDK :

```toml
[env]
SDKROOT = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
```

Les SDK disponibles se listent avec `ls /Library/Developer/CommandLineTools/SDKs/`.

## Où sont les données

Dans le dossier de données de l'application. Sur macOS : `~/Library/Application Support/com.simplenode.app/`.

- `projects/` : un fichier JSON par projet
- `images/` : images et vidéos importées ou générées. Les URLs de fal expirent, donc chaque résultat est téléchargé immédiatement.

**Réglages → Stockage** affiche l'espace utilisé et supprime les médias qui ne servent plus à aucun projet.

## Structure du code

```
src/                      Interface (Next.js en export statique)
  components/
    App.tsx               Bascule accueil ↔ éditeur
    Home.tsx              Accueil : fichiers, corbeille
    Settings.tsx          Réglages : clés, coûts, stockage
    Editor.tsx            Canvas, sauvegarde automatique
    Library.tsx           Bibliothèque de nœuds (panneau gauche)
    ContextMenus.tsx      Menus du clic droit
    nodes.tsx             Rendu de chaque type de nœud
    ProviderIcon.tsx      Logos des fournisseurs
  lib/
    spec.ts               Types de ports, nœuds, entrées/sorties
    store.ts              État du graphe (Zustand), historique
    projects.ts           Lecture / écriture des projets

src-tauri/src/            Backend Rust
  models.rs               Registre des modèles fal (source de vérité)
  graph.rs                Exécution du graphe
  fal.rs                  Client fal : file d'attente, upload, brouillons
  account.rs              Clés (trousseau), tarifs, dépenses
  projects.rs             Fichiers projets
  storage.rs              Médias locaux, crop, nettoyage
  lib.rs                  Commandes Tauri
```

### Ajouter un modèle fal

1. Récupérez son schéma : `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>`.
2. Ajoutez une entrée dans `MODELS` ou `VIDEO_MODELS` (`src-tauri/src/models.rs`), avec ses endpoints texte et image, le champ des images de référence et ses paramètres.
3. Lancez `cargo test` dans `src-tauri/` : un test vérifie la cohérence du registre.
4. Optionnel : ajoutez son logo dans `MODEL_LOGOS` (`src/components/ProviderIcon.tsx`).

L'interface (bibliothèque, ports, réglages, tarifs) se construit automatiquement à partir du registre.

## Vérifications

```bash
npx tsc --noEmit                   # types
npm run lint                       # lint
cd src-tauri && cargo test         # tests Rust
cd src-tauri && cargo clippy       # lint Rust
```

## Crédits

- Logos des fournisseurs : [@lobehub/icons](https://github.com/lobehub/lobe-icons) (licence MIT). Ces logos sont des marques de leurs propriétaires respectifs et servent uniquement à identifier le fournisseur de chaque modèle. Voir `public/providers/ATTRIBUTION.md`.
- Icônes de l'interface : [Lucide](https://lucide.dev).

## Licence

© 2026 LUDACOM SARL. Tous droits réservés.

Le code source est publié pour consultation. Aucune licence n'est accordée pour le copier, le modifier ou le redistribuer sans l'accord écrit de LUDACOM SARL.
