# SimpleNode

A desktop app for building AI generation workflows as a node graph: connect prompts, images and videos to models (Nano Banana, Seedream, Kling, Veo, Seedance…), then run the graph. Models run through [fal.ai](https://fal.ai) or, for those without a fal account, [WaveSpeed](https://wavespeed.ai); optionally BytePlus ModelArk.

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

**On first launch, SimpleNode guides you** through creating your [fal.ai](https://fal.ai) account, the service that generates the images and videos, adding some credit to it and pasting your key. You can pick [WaveSpeed](https://wavespeed.ai) instead: it runs most of the models (26 of them), but not Recast, the LLM tools nor a few models, which need a fal key. fal.ai bills each generation per unit (from a few cents for an image to about a dollar for a video). Your key stays on your computer.

## Features

- **Node canvas**: drag and drop from the library, right-click to add a node, undo / redo, links colored by type (text, image, video).
- **Nodes**: Prompt, Import (image or video), Preview, Router, Prompt Concatenator, Crop, Grid Crop, Camera angles, Extract frame, Video → Prompt, Upscale image, Upscale / Export, Prompt Enhancer, Image Describer, Video Describer, LLM.
- **Image models**: Nano Banana Pro / 2, Seedream 5.0 Pro / 5.0 Lite / 4.5, GPT Image 2, FLUX.2 [pro], FLUX.1 Kontext [pro], Qwen Image 3, Recraft V4 Pro, Ideogram V3, FLUX.1 [schnell]. With reference images connected, the app uses the model's "edit" version.
- **Video models**: Kling 4 / 3 Pro / 2.5 Turbo Pro, MiniMax H3 / H3 Max, Seedance 2.5 / 2.0 / 1.0 Pro, Seedance 2.5 Motion transfer and Character swap (with a reference video, up to 30 s), reference-to-video with images (Seedance 2.5 Reference, up to 30 images, with a 480p draft; MiniMax H3 / H3 Max Reference, up to 9 images), Veo 3.1 / 3.1 Fast, Hailuo 02, Wan 2.5, LTX-2. Start and end image depending on the model.
- **Recast**: from a source video and a character image, two modes. **Replace** keeps the scene, lighting, camera and sound, and replaces the people with your characters (H3 Max Recast, up to 4 characters; Wan 2.2 Animate Replace). **Motion** animates your character, in their own setting, with the gestures and camera of the video (Kling 3 Motion Control Pro / Standard).
- **Music and sound**: music (ElevenLabs Music, Stable Audio 2.5), sound effects (ElevenLabs Sound Effects, MMAudio), sound generated for a video (MMAudio), and "Add sound" to put a track on a video.
- **Compositor**: stacks images, videos and sounds as layers, in a full-screen editor (position, size, opacity, volume, fades, loop, order). In timeline mode, each layer has its own start and duration, and "Chain end to end" puts the shots one after another. The export runs on your computer, for free; it needs [ffmpeg](https://ffmpeg.org) (see above).
- **Workflows**: from the home page, creates an already wired file, for images (create a character, edit, combine, put a character in a scene, camera angles) and for video; just import your media and run.
- **Recreate a video with your character**: the workflow for redoing a video's action with your own character, in the video's setting. **Extract frame** takes a frame of the video (free, on your computer), and an image model puts your character in it from three images (face from the front, in profile, full body with the outfit). **Video → Prompt** samples the video and has a vision LLM write its action, camera and setting as a timed prompt, without describing the people in it. Seedance 2.5 then generates the video from that prompt and your images only: the source video is never sent, so a real person in it doesn't block or replace your character.
- **Upscale / Export**: a finished video in 1080p, 2K or 4K (Standard or Pro), then written on your computer at the frame rate you choose (60 fps interpolated), as MP4 H.264, MP4 H.265 or MOV ProRes 422 HQ, with or without sound. A 480p render plus an upscale costs much less than rendering in 1080p; the node shows the estimated cost.
- **Upscale image** (Tools): an image in 2K or 4K, sharper, with SeedVR2 on fal (under a cent) or WaveSpeed's Image Upscaler ($0.01, also 8K), as PNG, JPEG or WebP.
- **Seedance 2.5 Draft**: generates a cheap 480p draft, then finalizes it in 1080p in one click (draft valid 14 days).
- **BytePlus ModelArk (optional)**: Seedance 2.5 with an AI-created character whose face shows, which fal refuses. The character goes through an **AI Portrait** validated by BytePlus, or through a trusted **Seedream** image. AI Portrait, Seedance 2.5 and Seedream (BytePlus) nodes, with your own account and keys. Step-by-step setup: [docs/byteplus-guide.md](docs/byteplus-guide.md).
- **Running**: "Run all" or run a single node, and a Stop button. A paid node that already has a result is never run again by "Run all", so you never pay twice; the estimated cost shows before launching.
- **Projects**: home page with your files, thumbnails, trash, autosave.
- **WaveSpeed (alternative to fal)**: with a WaveSpeed key, 26 of the models run on WaveSpeed: Nano Banana, Seedream, GPT Image 2, FLUX, Qwen Image 3, Recraft, Kling, MiniMax H3, Seedance, Veo 3.1, Hailuo, Wan, LTX, ElevenLabs. Recast also runs there with Wan 2.2 Animate Replace and Kling Motion Control, its segments cut and joined on your computer with ffmpeg. Settings come from WaveSpeed's own schema, and the cost shown is WaveSpeed's price. **Settings → Provider** picks who runs everything; with WaveSpeed, nothing goes to fal, and what only fal offers is marked "fal only".
- **Settings**: fal.ai and WaveSpeed keys (WaveSpeed balance shown), BytePlus keys (optional), price of each model, actual spending per model, local storage management.

## Credits

- Provider logos: [@lobehub/icons](https://github.com/lobehub/lobe-icons) (MIT license). These logos are trademarks of their respective owners and only identify the provider of each model.
- Interface icons: [Lucide](https://lucide.dev).

## License

© 2026 LUDACOM SARL. All rights reserved. SimpleNode is distributed as a ready-to-install app; its source code is not public.
