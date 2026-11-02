# SimpleNode

Application de bureau pour construire des workflows de génération IA sous forme de graphe de nœuds : on relie des prompts, des images et des vidéos à des modèles (Nano Banana, Seedream, Kling, Veo, Seedance…), puis on exécute le graphe. Tous les modèles passent par [fal.ai](https://fal.ai).

Construite avec **Tauri 2** (backend Rust) et **Next.js + React Flow** (interface).

## Télécharger et installer (sans compétences techniques)

1. **Téléchargez** le fichier `SimpleNode_x.y.z_universal.dmg` de la dernière version, sur la page [Releases](https://github.com/Heako/simplenode-public/releases/latest). Il fonctionne sur tous les Mac récents (puce Apple M1 à M4, ou Intel), avec macOS 11 ou plus récent.
2. **Ouvrez** le fichier téléchargé, puis faites glisser l'icône **SimpleNode** sur le dossier **Applications**.
3. **Lancez SimpleNode** depuis le dossier Applications (ou le Launchpad).

**Au premier lancement, macOS affiche un avertissement**, car l'app n'est pas encore signée par Apple. C'est normal. Pour l'autoriser une fois pour toutes :

- Cliquez sur **Terminé** (ne la mettez pas à la corbeille).
- Ouvrez **Réglages Système → Confidentialité et sécurité**, descendez jusqu'au message « SimpleNode a été bloqué », puis cliquez sur **Ouvrir quand même** et confirmez avec votre mot de passe.
- Relancez SimpleNode. L'avertissement n'apparaîtra plus.

Si macOS indique que l'app « est endommagée », ouvrez l'app **Terminal**, collez cette ligne puis appuyez sur Entrée :

```bash
xattr -dr com.apple.quarantine /Applications/SimpleNode.app
```

**Pour le Compositeur**, installez aussi ffmpeg, une seule fois : installez [Homebrew](https://brew.sh), puis tapez `brew install ffmpeg` dans le Terminal. Le reste de l'app fonctionne sans.

**Au premier lancement, SimpleNode vous guide** pour créer votre compte [fal.ai](https://fal.ai), le service qui génère les images et vidéos, puis pour y ajouter un peu de crédit et coller votre clé. Chaque génération est facturée par fal.ai à l'unité (de quelques centimes pour une image à environ un euro pour une vidéo). Votre clé reste sur votre ordinateur.

## Fonctionnalités

- **Canvas à nœuds** : glisser-déposer depuis la bibliothèque, clic droit pour ajouter un nœud, annuler / rétablir, liens colorés selon le type (texte, image, vidéo).
- **Nœuds** : Prompt, Import (image ou vidéo), Preview, Router, Prompt Concatenator, Crop, Prompt Enhancer, Image Describer, Video Describer, LLM.
- **Modèles d'image** : Nano Banana Pro / 2, Seedream 5.0 Lite / 4.5, GPT Image 2, FLUX.2 [pro], FLUX.1 Kontext [pro], Qwen Image 3, Recraft V4 Pro, Ideogram V3, FLUX.1 [schnell]. Avec des images reliées en référence, l'app utilise la version « édition » du modèle.
- **Modèles vidéo** : Kling 4 / 3 Pro / 2.5 Turbo Pro, MiniMax H3 / H3 Max, Seedance 2.5 / 2.0 / 1.0 Pro, Veo 3.1 / 3.1 Fast, Hailuo 02, Wan 2.5, LTX-2. Image de départ et de fin selon le modèle.
- **Recast** : à partir d'une vidéo source et d'une image de personnage, deux modes. **Remplacer** garde la scène, la lumière, la caméra et le son, et remplace les personnes par vos personnages (H3 Max Recast, jusqu'à 4 personnages ; Wan 2.2 Animate Replace). **Mouvement** anime votre personnage, dans son propre décor, avec les gestes et la caméra de la vidéo (Kling 3 Motion Control Pro / Standard).
- **Musique et son** : musique (ElevenLabs Music, Stable Audio 2.5), bruitages (ElevenLabs Sound Effects, MMAudio), son généré pour une vidéo (MMAudio), et « Ajouter le son » pour poser une piste sur une vidéo.
- **Compositeur** : superpose images, vidéos et sons en calques, dans un éditeur plein écran (position, taille, opacité, volume, fondus, boucle, ordre). En mode timeline, chaque calque a son début et sa durée, et « Enchaîner bout à bout » monte les plans à la suite. L'export se fait sur votre ordinateur, gratuitement ; il demande [ffmpeg](https://ffmpeg.org) (voir ci-dessous).
- **Workflows** : depuis l'accueil, crée un fichier déjà relié (vidéo source → Recast ← personnage) ; il ne reste qu'à importer ses médias et exécuter.
- **Seedance 2.5 Draft** : génère un brouillon 480p peu coûteux, puis le finalise en 1080p d'un clic (brouillon valable 7 jours chez fal).
- **Exécution** : « Tout exécuter » ou exécution d'un seul nœud, et bouton Arrêter. Un nœud payant qui a déjà un résultat n'est jamais relancé par « Tout exécuter », pour ne pas payer deux fois ; le coût estimé s'affiche avant de lancer.
- **Projets** : page d'accueil avec vos fichiers, miniatures, corbeille, sauvegarde automatique.
- **Réglages** : clé fal.ai, tarif de chaque modèle, dépenses réelles par modèle, gestion du stockage local.

## Prérequis

- **Node.js** 20 ou plus récent, et npm
- **ffmpeg** et ffprobe, pour le Compositeur (`brew install ffmpeg`)
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

La clé est enregistrée dans un fichier privé de l'app (`keys.json` dans son dossier de configuration, lisible par votre compte uniquement), jamais dans les projets. Contrairement au trousseau macOS, il ne demande pas le mot de passe de session après chaque mise à jour de l'app. En développement uniquement, la variable d'environnement `FAL_KEY` est utilisée si aucune clé n'est enregistrée ; l'app distribuée n'utilise que la clé déclarée par l'utilisateur.

### Voir ses dépenses

La section **Coûts** affiche les tarifs avec n'importe quelle clé. Pour les **dépenses réelles**, fal exige une clé créée avec le preset `BILLING` ou `FULL`. Ajoutez-la dans **Clé de facturation**, sinon l'app essaie avec la clé de génération. fal ne publie pas le solde par API : un lien mène à votre tableau de bord.

## Compiler une version distribuable

```bash
npm run tauri build
```

L'installeur est produit dans `src-tauri/target/release/bundle/` (`.app` et `.dmg` sur macOS).

### Installer sur une autre machine

Copiez le `.dmg` de `src-tauri/target/release/bundle/dmg/` sur l'autre Mac et installez l'app comme n'importe quelle autre. Node, Rust et Xcode ne sont pas nécessaires.

L'app n'est pas signée : au premier lancement, macOS la bloque. Voir [Télécharger et installer](#télécharger-et-installer-sans-compétences-techniques).

Pour un installeur qui fonctionne sur les Mac Apple Silicon et Intel :

```bash
rustup target add x86_64-apple-darwin   # une seule fois
RUSTFLAGS="--remap-path-prefix=$HOME=~" npm run tauri build -- --target universal-apple-darwin
```

Le `.dmg` est alors dans `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`. `RUSTFLAGS` retire les chemins de votre dossier personnel du binaire. Arrêtez `npm run tauri dev` avant de compiler : les deux utilisent le dossier `.next`.

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
    CompositorEditor.tsx  Éditeur plein écran du Compositeur
    ProviderIcon.tsx      Logos des fournisseurs
  lib/
    spec.ts               Types de ports, nœuds, entrées/sorties
    store.ts              État du graphe (Zustand), historique
    projects.ts           Lecture / écriture des projets
    cost.ts               Coût à la seconde des modèles vidéo → vidéo

src-tauri/src/            Backend Rust
  models.rs               Registre des modèles fal (source de vérité)
  graph.rs                Exécution du graphe
  recast.rs               Recast : modes, découpage en segments
  compose.rs              Compositeur : rendu des calques avec ffmpeg
  fal.rs                  Client fal : file d'attente, upload, brouillons
  account.rs              Clés (fichier privé), tarifs, dépenses
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
