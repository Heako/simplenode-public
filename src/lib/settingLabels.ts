/**
 * Readable labels and values for fal model settings. fal publishes
 * technical names (`enable_prompt_expansion`, `portrait_4_3`, `TURBO`); keys
 * and values not listed here fall back to a tidied version of themselves.
 */

const LABELS: Record<string, string> = {
  aspect_ratio: "Aspect ratio",
  image_size: "Size",
  resolution: "Resolution",
  duration: "Duration",
  generate_audio: "Audio",
  rendering_speed: "Rendering speed",
  style: "Style",
  style_preset: "Style preset",
  strength: "Strength",
  seed: "Seed",
  guidance_scale: "Guidance",
  cfg_scale: "Prompt adherence (CFG)",
  num_inference_steps: "Inference steps",
  enable_prompt_expansion: "Enhance the prompt",
  enhance_prompt: "Enhance the prompt",
  prompt_optimizer: "Optimize the prompt",
  prompt_expansion_mode: "Prompt rewriting",
  shot_type: "Shot type",
  camera_fixed: "Fixed camera",
  fps: "Frames per second",
  num_frames: "Number of frames",
  quality: "Quality",
  background: "Background",
  acceleration: "Acceleration",
  temperature: "Temperature",
  max_tokens: "Max tokens",
  max_output_tokens: "Max output tokens",
  reasoning: "Reasoning",
  priority: "Priority",
  top_p: "Top P",
  thinking_level: "Thinking level",
  enable_web_search: "Web search",
  enable_image_search: "Image search",
  include_thoughts: "Include reasoning",
  limit_generations: "Limit generations",
  enable_safety_checker: "Safety checker",
  safety_tolerance: "Safety tolerance",
  output_format: "File format",
  output_compression: "Compression",
  codec: "Codec",
  bitrate_mode: "Video bitrate",
  watermark: "Watermark",
  auto_fix: "Auto fix",
  sequential_image_generation: "Sequential generation",
  return_byteplus_urls: "BytePlus URLs",
  model: "Model",
  detailed_analysis: "Detailed analysis",
  character_orientation: "Framing",
  keep_original_sound: "Original sound",
  enhance_realism: "Enhanced realism",
  video_quality: "Video quality",
  video_write_mode: "Video encoding",
  use_turbo: "Turbo mode",
};

/** Values whose meaning depends on the setting they belong to. */
const KEYED_VALUES: Record<string, Record<string, string>> = {
  character_orientation: { video: "Like the video", image: "Like the image" },
};

/** Technical options, kept out of the way in a folded "Advanced" section. */
const ADVANCED = new Set([
  "enable_safety_checker",
  "safety_tolerance",
  "output_format",
  "output_compression",
  "codec",
  "bitrate_mode",
  "watermark",
  "return_byteplus_urls",
  "limit_generations",
  "include_thoughts",
  "priority",
  "acceleration",
  "auto_fix",
  "enable_web_search",
  "enable_image_search",
  "max_output_tokens",
  "top_p",
  "thinking_level",
  "sequential_image_generation",
  "num_frames",
  "video_write_mode",
]);

const IMAGE_SIZES: Record<string, string> = {
  square_hd: "Square HD",
  square: "Square",
  portrait_4_3: "Portrait 3:4",
  portrait_16_9: "Portrait 9:16",
  landscape_4_3: "Landscape 4:3",
  landscape_16_9: "Landscape 16:9",
};

const WORDS: Record<string, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  none: "None",
  regular: "Regular",
  standard: "Standard",
  turbo: "Turbo",
  balanced: "Balanced",
  quality: "Quality",
  general: "General",
  realistic: "Realistic",
  design: "Design",
  transparent: "Transparent",
  opaque: "Opaque",
  throughput: "Throughput",
  latency: "Latency",
  customize: "Custom",
  intelligent: "Intelligent",
};

const tidy = (s: string) => {
  const spaced = s.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export function settingLabel(key: string, fallback?: string) {
  return LABELS[key] ?? fallback ?? tidy(key);
}

export function isAdvanced(key: string) {
  return ADVANCED.has(key);
}

/** "portrait_4_3" -> "Portrait 3:4", "TURBO" -> "Turbo", "auto_2K" -> "Auto 2K"; ratios, sizes and numbers stay. */
export function optionLabel(key: string, value: string) {
  if (KEYED_VALUES[key]?.[value]) return KEYED_VALUES[key][value];
  if (IMAGE_SIZES[value]) return IMAGE_SIZES[value];
  if (/^auto_\d+K$/i.test(value)) return `Auto ${value.split("_")[1]}`;
  // Ratios (16:9), sizes (1K, 1080p), durations (8s), numbers: already readable.
  if (/^[\d.:]+[a-zA-Z]{0,2}$/.test(value) || key === "model") return value;
  return WORDS[value.toLowerCase()] ?? tidy(value);
}
