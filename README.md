# SimpleNode

A desktop app for building AI generation workflows as a node graph: connect prompts, images and videos to models (Nano Banana, Seedream, Kling, Veo, Seedance…), then run the graph. Models run through [fal.ai](https://fal.ai) or, for those without a fal account, [WaveSpeed](https://wavespeed.ai); optionally BytePlus ModelArk.

Built with **Tauri 2** (Rust backend) and **Next.js + React Flow** (interface).

## Download and install (no technical skills needed)

1. **Download** the `SimpleNode_x.y.z_universal.dmg` file of the latest version from the [Releases](https://github.com/Heako/simplenode-public/releases/latest) page. It works on all recent Macs (Apple M1 to M4 chips, or Intel), with macOS 11 or later.
2. **Open** the downloaded file, then drag the **SimpleNode** icon onto the **Applications** folder.
3. **Launch SimpleNode** from the Applications folder (or Launchpad).

**On first launch, macOS shows a warning**, because the app isn't signed by Apple yet. This is expected. To allow it once and for all:

- Click **Done** (don't move it to the trash).
- Open **System Settings → Privacy & Security**, scroll down to the message "SimpleNode was blocked", then click **Open Anyway** and confirm with your password.
- Launch SimpleNode again. The warning won't come back.

If macOS says the app "is damaged", open the **Terminal** app, paste this line and press Return:

```bash
xattr -dr com.apple.quarantine /Applications/SimpleNode.app
```

**For the Compositor**, also install ffmpeg, once: install [Homebrew](https://brew.sh), then type `brew install ffmpeg` in the Terminal. The rest of the app works without it.

**On first launch, SimpleNode guides you** through creating your [fal.ai](https://fal.ai) account, the service that generates the images and videos, adding some credit to it and pasting your key. You can pick [WaveSpeed](https://wavespeed.ai) instead: it runs most of the models (22 of them), but not Recast, the LLM tools nor a few models, which need a fal key. fal.ai bills each generation per unit (from a few cents for an image to about a dollar for a video). Your key stays on your computer.

## Features

- **Node canvas**: drag and drop from the library, right-click to add a node, undo / redo, links colored by type (text, image, video).
- **Nodes**: Prompt, Import (image or video), Preview, Router, Prompt Concatenator, Crop, Grid Crop, Camera angles, Extract frame, Video → Prompt, Upscale / Export, Prompt Enhancer, Image Describer, Video Describer, LLM.
- **Image models**: Nano Banana Pro / 2, Seedream 5.0 Lite / 4.5, GPT Image 2, FLUX.2 [pro], FLUX.1 Kontext [pro], Qwen Image 3, Recraft V4 Pro, Ideogram V3, FLUX.1 [schnell]. With reference images connected, the app uses the model's "edit" version.
- **Video models**: Kling 4 / 3 Pro / 2.5 Turbo Pro, MiniMax H3 / H3 Max, Seedance 2.5 / 2.0 / 1.0 Pro, Seedance 2.5 Motion transfer and Character swap (with a reference video, up to 30 s), Veo 3.1 / 3.1 Fast, Hailuo 02, Wan 2.5, LTX-2. Start and end image depending on the model.
- **Recast**: from a source video and a character image, two modes. **Replace** keeps the scene, lighting, camera and sound, and replaces the people with your characters (H3 Max Recast, up to 4 characters; Wan 2.2 Animate Replace). **Motion** animates your character, in their own setting, with the gestures and camera of the video (Kling 3 Motion Control Pro / Standard).
- **Music and sound**: music (ElevenLabs Music, Stable Audio 2.5), sound effects (ElevenLabs Sound Effects, MMAudio), sound generated for a video (MMAudio), and "Add sound" to put a track on a video.
- **Compositor**: stacks images, videos and sounds as layers, in a full-screen editor (position, size, opacity, volume, fades, loop, order). In timeline mode, each layer has its own start and duration, and "Chain end to end" puts the shots one after another. The export runs on your computer, for free; it needs [ffmpeg](https://ffmpeg.org) (see above).
- **Workflows**: from the home page, creates an already wired file, for images (create a character, edit, combine, put a character in a scene, camera angles) and for video; just import your media and run.
- **Recreate a video with your character**: the workflow for redoing a video's action with your own character, in the video's setting. **Extract frame** takes a frame of the video (free, on your computer), and an image model puts your character in it from three images (face from the front, in profile, full body with the outfit). **Video → Prompt** samples the video and has a vision LLM write its action, camera and setting as a timed prompt, without describing the people in it. Seedance 2.5 then generates the video from that prompt and your images only: the source video is never sent, so a real person in it doesn't block or replace your character.
- **Upscale / Export**: a finished video in 1080p, 2K or 4K (Standard or Pro), then written on your computer at the frame rate you choose (60 fps interpolated), as MP4 H.264, MP4 H.265 or MOV ProRes 422 HQ, with or without sound. A 480p render plus an upscale costs much less than rendering in 1080p; the node shows the estimated cost.
- **Seedance 2.5 Draft**: generates a cheap 480p draft, then finalizes it in 1080p in one click (draft valid 14 days).
- **BytePlus ModelArk (optional)**: Seedance 2.5 with an AI-created character whose face shows, which fal refuses. The character goes through an **AI Portrait** validated by BytePlus, or through a trusted **Seedream** image. AI Portrait, Seedance 2.5 and Seedream (BytePlus) nodes, with your own account and keys. Step-by-step setup: [docs/byteplus-guide.md](docs/byteplus-guide.md).
- **Running**: "Run all" or run a single node, and a Stop button. A paid node that already has a result is never run again by "Run all", so you never pay twice; the estimated cost shows before launching.
- **Projects**: home page with your files, thumbnails, trash, autosave.
- **WaveSpeed (alternative to fal)**: with a WaveSpeed key, 22 of the models run on WaveSpeed: Nano Banana, Seedream, GPT Image 2, FLUX, Qwen Image 3, Recraft, Kling, MiniMax H3, Seedance, Veo 3.1, Hailuo, Wan, LTX, ElevenLabs. Recast also runs there with Wan 2.2 Animate Replace and Kling Motion Control, its segments cut and joined on your computer with ffmpeg. Settings come from WaveSpeed's own schema, and the cost shown is WaveSpeed's price. **Settings → Provider** picks who runs everything; with WaveSpeed, nothing goes to fal, and what only fal offers is marked "fal only".
- **Settings**: fal.ai and WaveSpeed keys (WaveSpeed balance shown), BytePlus keys (optional), price of each model, actual spending per model, local storage management.

## Requirements

- **Node.js** 20 or later, and npm
- **ffmpeg** and ffprobe, for the Compositor (`brew install ffmpeg`)
- **Rust**, recent stable toolchain (tested with 1.90): <https://rustup.rs>
- **macOS**: Xcode or the Command Line Tools
- **Windows / Linux**: the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/)
- A **fal.ai API key**: <https://fal.ai/dashboard/keys>, or a **WaveSpeed** developer key: <https://wavespeed.ai/accesskey>

## Installation

To simply use the app on another machine, you don't need any of this: see [Install on another machine](#install-on-another-machine).

On a fresh machine (macOS):

```bash
# 1. Apple build tools
xcode-select --install

# 2. Rust, then reload the shell so `cargo` is found
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 3. The project and its dependencies
git clone https://github.com/Heako/simplenode-public.git
cd simplenode
npm install
```

Node.js 20+ installs from <https://nodejs.org> or with `brew install node`.

Run `npm install` again after every clone: `node_modules` isn't versioned. Without it, `npm run tauri dev` fails with `tauri: command not found`.

The interface doesn't work in a browser alone (`npm run dev` on `localhost:3000`). It depends on the Rust backend and crashes on start with `Cannot read properties of undefined (reading 'invoke')`. Always launch the app with `npm run tauri dev`.

## Run the app

```bash
npm run tauri dev
```

The first Rust build takes a few minutes. The next ones are incremental.

On first launch:

1. Open **Settings** (bottom left of the home page).
2. Paste your fal.ai key in **Generation key**, then click **Test**.
3. Go back to **My files**, create a **New file**, add nodes and click **Run all**.

The key is saved in a private file of the app (`keys.json` in its config folder, readable by your account only), never in projects. Unlike the macOS keychain, it doesn't ask for your session password after each app update. In development only, the `FAL_KEY` environment variable is used when no key is saved; the distributed app only uses the key the user entered.

For BytePlus (optional), follow [docs/byteplus-guide.md](docs/byteplus-guide.md): account, API key, Access Key / Secret Key for portraits, then **Settings → BytePlus ModelArk**.

### See your spending

The **Costs** section shows prices with any key. For **actual spending**, fal requires a key created with the `BILLING` or `FULL` preset. Add it as the **Billing key**, otherwise the app tries with the generation key. fal doesn't publish the balance through its API: a link leads to your dashboard.

## Build a distributable version

```bash
npm run tauri build
```

The installer is written to `src-tauri/target/release/bundle/` (`.app` and `.dmg` on macOS).

### Install on another machine

Copy the `.dmg` from `src-tauri/target/release/bundle/dmg/` to the other Mac and install the app like any other. Node, Rust and Xcode aren't needed.

The app isn't signed: on first launch, macOS blocks it. See [Download and install](#download-and-install-no-technical-skills-needed).

For an installer that works on both Apple Silicon and Intel Macs:

```bash
rustup target add x86_64-apple-darwin   # once
RUSTFLAGS="--remap-path-prefix=$HOME=~" npm run tauri build -- --target universal-apple-darwin
```

The `.dmg` is then in `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`. `RUSTFLAGS` removes your home folder paths from the binary. Stop `npm run tauri dev` before building: both use the `.next` folder.

## Known issue: linker error on macOS 27

With the macOS 27 Command Line Tools, any Rust build can fail with:

```
ld: tapi error: malformed file
.../MacOSX27.0.sdk/usr/lib/libSystem.B.tbd: error: unknown architecture arm64e.x1-macos
```

The bundled SDK contains an architecture the installed linker doesn't know yet.

**Fix:** update Xcode (fixed in **Xcode 27.1**), then:

```bash
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
cd src-tauri && cargo clean && cargo build
```

If you can't update Xcode, build against an older SDK present on the machine (it doesn't contain the faulty file), by creating `src-tauri/.cargo/config.toml` (ignored by git, as it is specific to each machine) with `SDKROOT` pointing to that SDK:

```toml
[env]
SDKROOT = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
```

List the available SDKs with `ls /Library/Developer/CommandLineTools/SDKs/`.

## Where the data lives

In the application's data folder. On macOS: `~/Library/Application Support/com.simplenode.app/`.

- `projects/`: one JSON file per project
- `images/`: imported or generated images and videos. fal and BytePlus URLs expire, so every result is downloaded right away.
- `byteplus-trusted.json`: the original address of Seedream (BytePlus) images, to send them to Seedance as is.

**Settings → Storage** shows the space used and deletes media no project uses anymore.

## Code structure

```
src/                      Interface (Next.js static export)
  components/
    App.tsx               Switches home ↔ editor
    Home.tsx              Home: files, trash
    Settings.tsx          Settings: keys, costs, storage
    Editor.tsx            Canvas, autosave
    Library.tsx           Node library (left panel)
    ContextMenus.tsx      Right-click menus
    nodes.tsx             Rendering of each node type
    CompositorEditor.tsx  Full-screen Compositor editor
    ProviderIcon.tsx      Provider logos
  lib/
    spec.ts               Port types, nodes, inputs/outputs
    store.ts              Graph state (Zustand), history
    projects.ts           Reading / writing projects
    cost.ts               Per-second cost of video → video models
    byteplus.ts           BytePlus keys, options and cost estimates
    provider.ts           Key status, and who runs models both fal and WaveSpeed host

src-tauri/src/            Rust backend
  models.rs               fal model registry (source of truth)
  graph.rs                Graph execution
  recast.rs               Recast: modes, splitting into segments
  compose.rs              Compositor rendering, and local ffmpeg tools (frames, contact sheets, export)
  motion.rs               Video → Prompt: what the vision LLM is asked
  fal.rs                  fal client: queue, upload, drafts
  byteplus.rs             BytePlus client: Seedance, Seedream, portraits
  wavespeed.rs            WaveSpeed client and the models it hosts
  account.rs              Keys (private file), prices, spending
  projects.rs             Project files
  storage.rs              Local media, crop, cleanup
  lib.rs                  Tauri commands
```

### Add a fal model

1. Get its schema: `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>`.
2. Add an entry to `MODELS` or `VIDEO_MODELS` (`src-tauri/src/models.rs`), with its text and image endpoints, the reference image field and its parameters.
3. Run `cargo test` in `src-tauri/`: a test checks the registry is consistent.
4. Optional: add its logo to `MODEL_LOGOS` (`src/components/ProviderIcon.tsx`).

The interface (library, ports, settings, prices) is built automatically from the registry.

## Checks

```bash
npx tsc --noEmit                   # types
npm run lint                       # lint
cd src-tauri && cargo test         # Rust tests
cd src-tauri && cargo clippy       # Rust lint
```

## Credits

- Provider logos: [@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT license). These logos are trademarks of their respective owners and only identify the provider of each model. See `public/providers/ATTRIBUTION.md`.
- Interface icons: [Lucide](https://lucide.dev).

## License

© 2026 LUDACOM SARL. All rights reserved.

The source code is published for reference. No license is granted to copy, modify or redistribute it without the written consent of LUDACOM SARL.
