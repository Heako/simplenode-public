/**
 * The tool nodes that call a service without being registry models (Voice,
 * Talking avatar, Upscale / Export, Video → Prompt, Add sound): their option
 * lists, shared by the nodes and the inspector panel, and what that panel shows.
 */
import type { NodeKind } from "./spec";

/** ElevenLabs premade voices both fal and WaveSpeed take by name. */
export const VOICES: [string, string][] = [
  ["Matilda", "Matilda · woman, warm professional alto"],
  ["Aria", "Aria · woman, middle-aged, calm, slight rasp"],
  ["Sarah", "Sarah · woman, warm, reassuring"],
  ["Lily", "Lily · woman, velvety, British"],
  ["Alice", "Alice · woman, clear, British"],
  ["Laura", "Laura · young woman, sunny"],
  ["Jessica", "Jessica · young woman, playful"],
  ["Charlotte", "Charlotte · woman, low, raspy"],
  ["River", "River · relaxed, neutral"],
  ["George", "George · man, warm, British"],
  ["Brian", "Brian · man, resonant, comforting"],
  ["Daniel", "Daniel · man, broadcast"],
  ["Bill", "Bill · man, friendly storyteller"],
  ["Eric", "Eric · man in his 40s, smooth"],
  ["Chris", "Chris · man, natural"],
  ["Will", "Will · man, laid back"],
  ["Roger", "Roger · man, easy-going"],
  ["Liam", "Liam · young man, energetic"],
  ["Charlie", "Charlie · young man, Australian"],
  ["Callum", "Callum · man, gravelly"],
];
export const VOICE_STABILITY: [string, string][] = [
  ["0", "Creative: most expressive"],
  ["0.5", "Natural"],
  ["1", "Robust: steadiest from clip to clip"],
];

export const UPSCALE_RESOLUTIONS: [string, string][] = [
  ["1080p", "1080p (Full HD)"],
  ["2k", "2K"],
  ["4k", "4K"],
];
export const UPSCALE_QUALITY: [string, string][] = [
  ["standard", "Standard"],
  ["pro", "Pro: finer detail, steadier frames (4–8× the price)"],
];
export const UPSCALE_LOOKS: [string, string][] = [
  ["aigc", "AI-generated video"],
  ["general", "General"],
  ["ugc", "Phone / social video"],
  ["short_series", "Short drama"],
  ["old_film", "Old film restoration"],
];
export const UPSCALE_FIDELITY: [string, string][] = [
  ["high", "Faithful: close to the source"],
  ["medium", "Enhanced: sharper, more retouched"],
];
export const UPSCALE_FPS: [string, string][] = [
  ["", "Same as the source"],
  ["24", "24 fps (cinema)"],
  ["25", "25 fps"],
  ["30", "30 fps"],
  ["60", "60 fps (smooth, interpolated)"],
];
export const UPSCALE_FORMATS: [string, string][] = [
  ["h264", "MP4 · H.264 (plays everywhere)"],
  ["h265", "MP4 · H.265 (half the size)"],
  ["prores", "MOV · ProRes 422 HQ (for editing)"],
];

/** Upscale image: the long side's class. 8K is WaveSpeed's only (fal's SeedVR2 stops at 2160p). */
export const IMAGE_UPSCALE_RESOLUTIONS: [string, string][] = [
  ["2k", "2K"],
  ["4k", "4K"],
  ["8k", "8K (WaveSpeed only)"],
];
export const IMAGE_UPSCALE_FORMATS: [string, string][] = [
  ["png", "PNG (lossless)"],
  ["jpg", "JPEG (smaller)"],
  ["webp", "WebP"],
];

/**
 * What one Upscale image run costs: WaveSpeed charges $0.01 a run; fal's
 * SeedVR2 $0.001 per output megapixel, here for a 16:9 or 9:16 image
 * (2560×1440 or 3840×2160), an upper bound for squarer ones.
 */
export function imageUpscaleCost(onWaveSpeed: boolean, resolution: string | undefined): number {
  if (onWaveSpeed) return 0.01;
  return resolution === "2k" ? 0.0037 : 0.0083;
}

export interface ToolField {
  key: string;
  label: string;
  kind: "select" | "text" | "toggle";
  options?: [string, string][];
  default: string;
  /** Hidden when this input port is wired (its value wins). */
  unlessWired?: string;
  /** Only fal offers it. */
  falOnly?: boolean;
  /** For a toggle: the param's value when on, and when off. */
  on?: string;
  off?: string;
  placeholder?: string;
  hint?: string;
}

export interface ToolPanel {
  label: string;
  /** What runs it, after the provider badge. */
  service: string;
  fields: ToolField[];
}

export const TOOL_PANELS: Partial<Record<NodeKind, ToolPanel>> = {
  voice: {
    label: "Voice",
    service: "ElevenLabs v3 · text → voice",
    fields: [
      { key: "text", label: "Text", kind: "text", default: "", unlessWired: "text", placeholder: "What the character says. Tags like [whispers] or [laughs] set the tone." },
      { key: "voice", label: "Voice", kind: "select", options: VOICES, default: "Matilda", hint: "Keep the same voice for every line of a character." },
      { key: "stability", label: "Delivery", kind: "select", options: VOICE_STABILITY, default: "0.5" },
    ],
  },
  avatar: {
    label: "Talking avatar",
    service: "Kling AI Avatar v2 Pro · image + voice → video",
    fields: [
      { key: "prompt", label: "Acting", kind: "text", default: "", unlessWired: "prompt", placeholder: "e.g. calm, soft smile, gentle nods, looks into the lens", hint: "The video lasts as long as the voice." },
    ],
  },
  upscale: {
    label: "Upscale / Export",
    service: "video upscaler · then exported on this computer",
    fields: [
      { key: "resolution", label: "Resolution", kind: "select", options: UPSCALE_RESOLUTIONS, default: "1080p" },
      { key: "quality", label: "Quality", kind: "select", options: UPSCALE_QUALITY, default: "standard" },
      { key: "look", label: "Footage", kind: "select", options: UPSCALE_LOOKS, default: "aigc", falOnly: true },
      { key: "fidelity", label: "Enhancement", kind: "select", options: UPSCALE_FIDELITY, default: "high", falOnly: true },
      { key: "fps", label: "Frame rate", kind: "select", options: UPSCALE_FPS, default: "" },
      { key: "format", label: "Format", kind: "select", options: UPSCALE_FORMATS, default: "h264" },
      { key: "sound", label: "Keep the sound", kind: "toggle", default: "on", on: "on", off: "off" },
    ],
  },
  upscaleImage: {
    label: "Upscale image",
    service: "image upscaler · SeedVR2 on fal, Image Upscaler on WaveSpeed",
    fields: [
      { key: "resolution", label: "Resolution", kind: "select", options: IMAGE_UPSCALE_RESOLUTIONS, default: "4k" },
      { key: "format", label: "Format", kind: "select", options: IMAGE_UPSCALE_FORMATS, default: "png" },
    ],
  },
  motionPrompt: {
    label: "Video → Prompt",
    service: "vision LLM · video → timed prompt",
    fields: [
      { key: "notes", label: "Notes", kind: "text", default: "", unlessWired: "notes", placeholder: "What to change or stress, e.g. “she wears a red dress”" },
      { key: "outfit", label: "Keep the video's outfit", kind: "toggle", default: "character", on: "video", off: "character", hint: "Off: the outfit comes from your reference images." },
    ],
  },
  addAudio: {
    label: "Add sound",
    service: "puts a sound track on a video",
    fields: [{ key: "offset", label: "Sound start (s)", kind: "text", default: "0" }],
  },
};
