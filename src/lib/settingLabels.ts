/**
 * Readable French labels and values for fal model settings. fal publishes
 * technical names (`enable_prompt_expansion`, `portrait_4_3`, `TURBO`); keys
 * and values not listed here fall back to a tidied version of themselves.
 */

const LABELS: Record<string, string> = {
  aspect_ratio: "Format",
  image_size: "Taille",
  resolution: "Résolution",
  duration: "Durée",
  generate_audio: "Audio",
  rendering_speed: "Vitesse de rendu",
  style: "Style",
  style_preset: "Style prédéfini",
  strength: "Force",
  seed: "Seed",
  guidance_scale: "Guidance",
  cfg_scale: "Fidélité au prompt (CFG)",
  num_inference_steps: "Étapes de génération",
  enable_prompt_expansion: "Améliorer le prompt",
  enhance_prompt: "Améliorer le prompt",
  prompt_optimizer: "Optimiser le prompt",
  prompt_expansion_mode: "Réécriture du prompt",
  shot_type: "Type de plan",
  camera_fixed: "Caméra fixe",
  fps: "Images par seconde",
  num_frames: "Nombre d'images",
  quality: "Qualité",
  background: "Fond",
  acceleration: "Accélération",
  temperature: "Température",
  max_tokens: "Tokens max",
  max_output_tokens: "Tokens max en sortie",
  reasoning: "Raisonnement",
  priority: "Priorité",
  top_p: "Top P",
  thinking_level: "Niveau de réflexion",
  enable_web_search: "Recherche web",
  enable_image_search: "Recherche d'images",
  include_thoughts: "Inclure le raisonnement",
  limit_generations: "Limiter les générations",
  enable_safety_checker: "Filtre de sécurité",
  safety_tolerance: "Tolérance du filtre",
  output_format: "Format du fichier",
  output_compression: "Compression",
  codec: "Codec",
  bitrate_mode: "Débit vidéo",
  watermark: "Filigrane",
  auto_fix: "Correction automatique",
  sequential_image_generation: "Génération séquentielle",
  return_byteplus_urls: "URL BytePlus",
  model: "Modèle",
  detailed_analysis: "Analyse détaillée",
};

/** Technical options, kept out of the way in a folded "Avancé" section. */
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
]);

const IMAGE_SIZES: Record<string, string> = {
  square_hd: "Carré HD",
  square: "Carré",
  portrait_4_3: "Portrait 3:4",
  portrait_16_9: "Portrait 9:16",
  landscape_4_3: "Paysage 4:3",
  landscape_16_9: "Paysage 16:9",
};

const WORDS: Record<string, string> = {
  auto: "Auto",
  low: "Basse",
  medium: "Moyenne",
  high: "Haute",
  none: "Aucune",
  regular: "Normale",
  standard: "Standard",
  turbo: "Turbo",
  balanced: "Équilibré",
  quality: "Qualité",
  general: "Général",
  realistic: "Réaliste",
  design: "Design",
  transparent: "Transparent",
  opaque: "Opaque",
  throughput: "Débit",
  latency: "Latence",
  customize: "Personnalisé",
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
  if (IMAGE_SIZES[value]) return IMAGE_SIZES[value];
  if (/^auto_\d+K$/i.test(value)) return `Auto ${value.split("_")[1]}`;
  // Ratios (16:9), sizes (1K, 1080p), durations (8s), numbers: already readable.
  if (/^[\d.:]+[a-zA-Z]{0,2}$/.test(value) || key === "model") return value;
  return WORDS[value.toLowerCase()] ?? tidy(value);
}
