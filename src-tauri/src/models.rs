//! Model registry: the single source of truth for which fal endpoints exist,
//! which parameters they take, and how reference images are passed.
//! Endpoints and enums were checked against fal's published OpenAPI schemas.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Image,
    Video,
    Llm,
}

/// How an edit endpoint receives reference images.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RefField {
    /// `image_urls: [..]`
    Urls,
    /// `image_url: ".."` (only the first reference is used)
    Url,
    /// `start_image_url: ".."` (Kling 3 image-to-video)
    StartImage,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ParamKind {
    Enum,
    /// Options are integers on the wire.
    Int,
    /// "true" / "false", sent as a JSON boolean.
    Bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Video,
    Audio,
}

/// Which endpoint a media input goes to: both, or only the edit /
/// image-to-video one (used when references are wired).
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Both,
    Edit,
}

/// An extra media input beyond the references and the end frame (style
/// images, a mask, keyframes, audio…), wired through its own port.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInput {
    /// fal input key.
    pub key: &'static str,
    pub label: &'static str,
    pub kind: MediaKind,
    pub multiple: bool,
    pub mode: Mode,
}

const fn media(key: &'static str, label: &'static str, kind: MediaKind, multiple: bool, mode: Mode) -> MediaInput {
    MediaInput { key, label, kind, multiple, mode }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    /// fal input key, sent verbatim.
    pub key: &'static str,
    pub label: &'static str,
    pub options: &'static [&'static str],
    pub default: &'static str,
    pub kind: ParamKind,
    /// Only sent to the text endpoint (e.g. aspect ratio, which image-to-video takes from the image).
    pub text_only: bool,
}

const fn select(key: &'static str, label: &'static str, options: &'static [&'static str], default: &'static str) -> Param {
    Param { key, label, options, default, kind: ParamKind::Enum, text_only: false }
}

const fn int(key: &'static str, label: &'static str, options: &'static [&'static str], default: &'static str) -> Param {
    Param { key, label, options, default, kind: ParamKind::Int, text_only: false }
}

const fn toggle(key: &'static str, label: &'static str, default: &'static str) -> Param {
    Param { key, label, options: &["true", "false"], default, kind: ParamKind::Bool, text_only: false }
}

impl Param {
    const fn text_only(mut self) -> Self {
        self.text_only = true;
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDef {
    pub id: &'static str,
    pub label: &'static str,
    pub provider: &'static str,
    pub category: Category,
    pub text_endpoint: Option<&'static str>,
    pub edit_endpoint: Option<&'static str>,
    pub ref_field: RefField,
    pub max_refs: u8,
    /// Video models: input key for an optional last frame.
    pub end_field: Option<&'static str>,
    /// Sends `draft: true`: a cheap 480p preview plus a `draft_id` to finalize in 1080p.
    pub draft: bool,
    /// Accepts `negative_prompt` (checked on fal's schemas, text and edit endpoints alike).
    pub negative: bool,
    /// Port label for the references when the generic one would mislead.
    pub refs_label: Option<&'static str>,
    pub media: &'static [MediaInput],
    pub params: &'static [Param],
}

const ASPECT_NANO: &[&str] = &["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "4:5", "5:4"];
const ASPECT_KONTEXT: &[&str] = &["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"];
const SIZE_STD: &[&str] = &["square_hd", "square", "landscape_16_9", "portrait_16_9", "landscape_4_3", "portrait_4_3"];
const SIZE_SEEDREAM_45: &[&str] =
    &["auto_2K", "auto_4K", "square_hd", "square", "landscape_16_9", "portrait_16_9", "landscape_4_3", "portrait_4_3"];
const SIZE_SEEDREAM_5: &[&str] = &[
    "auto_2K", "auto_3K", "auto_4K", "square_hd", "square", "landscape_16_9", "portrait_16_9", "landscape_4_3", "portrait_4_3",
];
const SIZE_GPT: &[&str] = &["auto", "square_hd", "square", "landscape_16_9", "portrait_16_9", "landscape_4_3", "portrait_4_3"];

/// Every entry is valid for both the fal `any-llm` and `any-llm/vision` endpoints.
pub const LLM_MODELS: &[&str] = &[
    "google/gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-haiku-5.5",
    "openai/gpt-5-mini",
    "openai/gpt-5-chat",
    "openai/gpt-4.1",
    "moonshotai/kimi-k2.5",
    "meta-llama/llama-4-maverick",
];

pub static MODELS: &[ModelDef] = &[
    ModelDef {
        id: "nano-banana-pro",
        label: "Nano Banana Pro",
        provider: "Google",
        category: Category::Image,
        text_endpoint: Some("fal-ai/nano-banana-pro"),
        edit_endpoint: Some("fal-ai/nano-banana-pro/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[
            select("aspect_ratio", "Format", ASPECT_NANO, "1:1"),
            select("resolution", "Résolution", &["1K", "2K", "4K"], "1K"),
        ],
    },
    ModelDef {
        id: "nano-banana-2",
        label: "Nano Banana 2",
        provider: "Google",
        category: Category::Image,
        text_endpoint: Some("fal-ai/nano-banana-2"),
        edit_endpoint: Some("fal-ai/nano-banana-2/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[
            media("video_url", "Vidéo de référence", MediaKind::Video, false, Mode::Edit),
            media("audio_url", "Audio de référence", MediaKind::Audio, false, Mode::Edit),
        ],
        params: &[
            select("aspect_ratio", "Format", ASPECT_NANO, "1:1"),
            select("resolution", "Résolution", &["0.5K", "1K", "2K", "4K"], "1K"),
        ],
    },
    ModelDef {
        id: "seedream-5-lite",
        label: "Seedream 5.0 Lite",
        provider: "ByteDance",
        category: Category::Image,
        text_endpoint: Some("bytedance/seedream/v5/lite/text-to-image"),
        edit_endpoint: Some("bytedance/seedream/v5/lite/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("image_size", "Taille", SIZE_SEEDREAM_5, "auto_2K")],
    },
    ModelDef {
        id: "seedream-4.5",
        label: "Seedream 4.5",
        provider: "ByteDance",
        category: Category::Image,
        text_endpoint: Some("fal-ai/bytedance/seedream/v4.5/text-to-image"),
        edit_endpoint: Some("fal-ai/bytedance/seedream/v4.5/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("image_size", "Taille", SIZE_SEEDREAM_45, "auto_2K")],
    },
    ModelDef {
        id: "gpt-image-2",
        label: "GPT Image 2",
        provider: "OpenAI",
        category: Category::Image,
        text_endpoint: Some("openai/gpt-image-2"),
        edit_endpoint: Some("openai/gpt-image-2/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[media("mask_url", "Masque", MediaKind::Image, false, Mode::Edit)],
        params: &[
            select("image_size", "Taille", SIZE_GPT, "auto"),
            select("quality", "Qualité", &["auto", "low", "medium", "high"], "auto"),
        ],
    },
    ModelDef {
        id: "flux-2-pro",
        label: "FLUX.2 [pro]",
        provider: "Black Forest Labs",
        category: Category::Image,
        text_endpoint: Some("fal-ai/flux-2-pro"),
        edit_endpoint: Some("fal-ai/flux-2-pro/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("image_size", "Taille", SIZE_STD, "square_hd")],
    },
    ModelDef {
        id: "flux-kontext-pro",
        label: "FLUX.1 Kontext [pro]",
        provider: "Black Forest Labs",
        category: Category::Image,
        text_endpoint: Some("fal-ai/flux-pro/kontext/text-to-image"),
        edit_endpoint: Some("fal-ai/flux-pro/kontext"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("aspect_ratio", "Format", ASPECT_KONTEXT, "1:1")],
    },
    ModelDef {
        id: "qwen-image-max",
        label: "Qwen Image Max",
        provider: "Alibaba",
        category: Category::Image,
        text_endpoint: Some("fal-ai/qwen-image-max/text-to-image"),
        edit_endpoint: Some("fal-ai/qwen-image-max/edit"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: true,
        refs_label: None,
        media: &[],
        params: &[select("image_size", "Taille", SIZE_STD, "square_hd")],
    },
    ModelDef {
        id: "recraft-v4-pro",
        label: "Recraft V4 Pro",
        provider: "Recraft",
        category: Category::Image,
        text_endpoint: Some("fal-ai/recraft/v4/pro/text-to-image"),
        edit_endpoint: None,
        ref_field: RefField::Urls,
        max_refs: 0,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("image_size", "Taille", SIZE_STD, "square_hd")],
    },
    ModelDef {
        id: "ideogram-v3",
        label: "Ideogram V3",
        provider: "Ideogram",
        category: Category::Image,
        text_endpoint: Some("fal-ai/ideogram/v3"),
        edit_endpoint: Some("fal-ai/ideogram/v3/remix"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: None,
        draft: false,
        negative: true,
        refs_label: Some("Image à remixer"),
        media: &[media("image_urls", "Images de style", MediaKind::Image, true, Mode::Both)],
        params: &[select("image_size", "Taille", SIZE_STD, "square_hd")],
    },
    ModelDef {
        id: "flux-schnell",
        label: "FLUX.1 [schnell]",
        provider: "Black Forest Labs",
        category: Category::Image,
        text_endpoint: Some("fal-ai/flux/schnell"),
        edit_endpoint: Some("fal-ai/flux/dev/image-to-image"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("image_size", "Taille", SIZE_STD, "square_hd")],
    },
    ModelDef {
        id: "llm",
        label: "LLM",
        provider: "fal any-llm",
        category: Category::Llm,
        text_endpoint: Some("fal-ai/any-llm"),
        edit_endpoint: Some("fal-ai/any-llm/vision"),
        ref_field: RefField::Urls,
        max_refs: 10,
        end_field: None,
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("model", "Modèle", LLM_MODELS, "google/gemini-2.5-flash")],
    },
];

const ASPECT_VIDEO: &[&str] = &["16:9", "9:16", "1:1"];
const ASPECT_SEEDANCE: &[&str] = &["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const SECONDS_3_15: &[&str] = &["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];

const SECONDS_SEEDANCE_25: &[&str] = &["auto", "4", "5", "6", "8", "10", "12", "15", "20", "25", "30"];
const ASPECT_SEEDANCE_25: &[&str] = &["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

pub static VIDEO_MODELS: &[ModelDef] = &[
    ModelDef {
        id: "kling-4",
        label: "Kling 4",
        provider: "Kling",
        category: Category::Video,
        text_endpoint: Some("kling/v4/text-to-video"),
        edit_endpoint: Some("kling/v4/image-to-video"),
        ref_field: RefField::StartImage,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[media("middle_image_urls", "Images intermédiaires", MediaKind::Image, true, Mode::Edit)],
        params: &[
            int("duration", "Durée (s)", &["3", "5", "8", "10", "15", "20", "25", "30"], "5"),
            select("aspect_ratio", "Format", &["16:9", "9:16", "1:1", "21:9"], "16:9").text_only(),
            select("resolution", "Résolution", &["720p", "1080p"], "1080p"),
        ],
    },
    ModelDef {
        id: "minimax-h3",
        label: "MiniMax H3",
        provider: "MiniMax",
        category: Category::Video,
        text_endpoint: Some("minimax/h3/text-to-video"),
        edit_endpoint: Some("minimax/h3/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[media("target_audio_url", "Audio cible", MediaKind::Audio, false, Mode::Both)],
        params: &[
            int("duration", "Durée (s)", &["5", "6", "8", "10", "12", "15"], "5"),
            select("aspect_ratio", "Format", ASPECT_SEEDANCE, "16:9").text_only(),
            select("resolution", "Résolution", &["480P", "768P", "2K", "4K"], "2K"),
        ],
    },
    ModelDef {
        id: "minimax-h3-max",
        label: "MiniMax H3 Max",
        provider: "MiniMax",
        category: Category::Video,
        text_endpoint: Some("minimax/h3-max/text-to-video"),
        edit_endpoint: Some("minimax/h3-max/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[media("target_audio_url", "Audio cible", MediaKind::Audio, false, Mode::Both)],
        params: &[
            int("duration", "Durée (s)", &["2", "3", "5", "6", "8", "10", "12", "15"], "5"),
            select("aspect_ratio", "Format", ASPECT_SEEDANCE, "16:9").text_only(),
            select("resolution", "Résolution", &["480P", "768P", "1080P"], "768P"),
            // Required by the schema; "balanced" is fal's documented default.
            select("prompt_expansion_mode", "Réécriture du prompt", &["balanced"], "balanced"),
        ],
    },
    ModelDef {
        id: "seedance-2.5",
        label: "Seedance 2.5",
        provider: "ByteDance",
        category: Category::Video,
        text_endpoint: Some("bytedance/seedance-2.5/text-to-video"),
        edit_endpoint: Some("bytedance/seedance-2.5/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée (s)", SECONDS_SEEDANCE_25, "5"),
            select("aspect_ratio", "Format", ASPECT_SEEDANCE_25, "auto").text_only(),
            select("resolution", "Résolution", &["480p", "720p", "1080p"], "720p"),
            toggle("generate_audio", "Audio", "true"),
        ],
    },
    ModelDef {
        id: "seedance-2.5-draft",
        label: "Seedance 2.5 Draft",
        provider: "ByteDance",
        category: Category::Video,
        text_endpoint: Some("bytedance/seedance-2.5/text-to-video"),
        edit_endpoint: Some("bytedance/seedance-2.5/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: true,
        negative: false,
        refs_label: None,
        media: &[],
        // No resolution: draft mode always renders 480p.
        params: &[
            select("duration", "Durée (s)", SECONDS_SEEDANCE_25, "5"),
            select("aspect_ratio", "Format", ASPECT_SEEDANCE_25, "auto").text_only(),
            toggle("generate_audio", "Audio", "true"),
        ],
    },
    ModelDef {
        id: "kling-3-pro",
        label: "Kling 3 Pro",
        provider: "Kling",
        category: Category::Video,
        text_endpoint: Some("fal-ai/kling-video/v3/pro/text-to-video"),
        edit_endpoint: Some("fal-ai/kling-video/v3/pro/image-to-video"),
        ref_field: RefField::StartImage,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: true,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée (s)", SECONDS_3_15, "5"),
            select("aspect_ratio", "Format", ASPECT_VIDEO, "16:9").text_only(),
            toggle("generate_audio", "Audio", "false"),
        ],
    },
    ModelDef {
        id: "kling-2.5-turbo-pro",
        label: "Kling 2.5 Turbo Pro",
        provider: "Kling",
        category: Category::Video,
        text_endpoint: Some("fal-ai/kling-video/v2.5-turbo/pro/text-to-video"),
        edit_endpoint: Some("fal-ai/kling-video/v2.5-turbo/pro/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("tail_image_url"),
        draft: false,
        negative: true,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée (s)", &["5", "10"], "5"),
            select("aspect_ratio", "Format", ASPECT_VIDEO, "16:9").text_only(),
        ],
    },
    ModelDef {
        id: "veo-3.1",
        label: "Veo 3.1",
        provider: "Google",
        category: Category::Video,
        text_endpoint: Some("fal-ai/veo3.1"),
        edit_endpoint: Some("fal-ai/veo3.1/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: None,
        draft: false,
        negative: true,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée", &["4s", "6s", "8s"], "8s"),
            select("aspect_ratio", "Format", &["16:9", "9:16"], "16:9"),
            select("resolution", "Résolution", &["720p", "1080p", "4k"], "720p"),
            toggle("generate_audio", "Audio", "true"),
        ],
    },
    ModelDef {
        id: "veo-3.1-fast",
        label: "Veo 3.1 Fast",
        provider: "Google",
        category: Category::Video,
        text_endpoint: Some("fal-ai/veo3.1/fast"),
        edit_endpoint: Some("fal-ai/veo3.1/fast/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: None,
        draft: false,
        negative: true,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée", &["4s", "6s", "8s"], "8s"),
            select("aspect_ratio", "Format", &["16:9", "9:16"], "16:9"),
            select("resolution", "Résolution", &["720p", "1080p", "4k"], "720p"),
            toggle("generate_audio", "Audio", "true"),
        ],
    },
    ModelDef {
        id: "seedance-2",
        label: "Seedance 2.0",
        provider: "ByteDance",
        category: Category::Video,
        text_endpoint: Some("bytedance/seedance-2.0/text-to-video"),
        edit_endpoint: Some("bytedance/seedance-2.0/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée (s)", &["auto", "4", "5", "6", "8", "10", "12", "15"], "5"),
            select("aspect_ratio", "Format", &["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "auto"),
            select("resolution", "Résolution", &["480p", "720p", "1080p", "4k"], "720p"),
            toggle("generate_audio", "Audio", "true"),
        ],
    },
    ModelDef {
        id: "seedance-1-pro",
        label: "Seedance 1.0 Pro",
        provider: "ByteDance",
        category: Category::Video,
        text_endpoint: Some("fal-ai/bytedance/seedance/v1/pro/text-to-video"),
        edit_endpoint: Some("fal-ai/bytedance/seedance/v1/pro/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[
            select("duration", "Durée (s)", &["3", "5", "8", "10", "12"], "5"),
            select("aspect_ratio", "Format", ASPECT_SEEDANCE, "16:9"),
            select("resolution", "Résolution", &["480p", "720p", "1080p"], "1080p"),
        ],
    },
    ModelDef {
        id: "hailuo-02",
        label: "Hailuo 02",
        provider: "MiniMax",
        category: Category::Video,
        text_endpoint: Some("fal-ai/minimax/hailuo-02/standard/text-to-video"),
        edit_endpoint: Some("fal-ai/minimax/hailuo-02/standard/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[select("duration", "Durée (s)", &["6", "10"], "6")],
    },
    ModelDef {
        id: "wan-2.5",
        label: "Wan 2.5",
        provider: "Alibaba",
        category: Category::Video,
        text_endpoint: Some("fal-ai/wan-25-preview/text-to-video"),
        edit_endpoint: Some("fal-ai/wan-25-preview/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: None,
        draft: false,
        negative: true,
        refs_label: None,
        media: &[media("audio_url", "Audio", MediaKind::Audio, false, Mode::Both)],
        params: &[
            select("duration", "Durée (s)", &["5", "10"], "5"),
            select("resolution", "Résolution", &["480p", "720p", "1080p"], "1080p"),
            select("aspect_ratio", "Format", ASPECT_VIDEO, "16:9").text_only(),
        ],
    },
    ModelDef {
        id: "ltx-2",
        // Id kept from LTX-2 so saved projects still find it; fal moved to 2.3.
        label: "LTX-2.3",
        provider: "Lightricks",
        category: Category::Video,
        text_endpoint: Some("fal-ai/ltx-2.3/text-to-video"),
        edit_endpoint: Some("fal-ai/ltx-2.3/image-to-video"),
        ref_field: RefField::Url,
        max_refs: 1,
        end_field: Some("end_image_url"),
        draft: false,
        negative: false,
        refs_label: None,
        media: &[],
        params: &[
            int("duration", "Durée (s)", &["6", "8", "10"], "6"),
            select("resolution", "Résolution", &["1080p", "1440p", "2160p"], "1080p"),
            select("aspect_ratio", "Format", &["16:9", "9:16"], "16:9").text_only(),
            toggle("generate_audio", "Audio", "true"),
        ],
    },
];

pub fn find(id: &str) -> Option<&'static ModelDef> {
    MODELS.iter().chain(VIDEO_MODELS).find(|m| m.id == id)
}

/// Image, LLM and video models, in library order.
pub fn all() -> impl Iterator<Item = &'static ModelDef> {
    MODELS.iter().chain(VIDEO_MODELS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_consistent() {
        for m in all() {
            assert!(m.text_endpoint.is_some() || m.edit_endpoint.is_some(), "{} has no endpoint", m.id);
            assert_eq!(m.edit_endpoint.is_some(), m.max_refs > 0, "{}: edit endpoint vs max_refs", m.id);
            for p in m.params {
                assert!(p.options.contains(&p.default), "{}.{} default not in options", m.id, p.key);
                if p.kind == ParamKind::Int {
                    assert!(p.options.iter().all(|o| o.parse::<i64>().is_ok()), "{}.{} has non-integer options", m.id, p.key);
                }
            }
            for input in m.media {
                assert!(input.mode != Mode::Edit || m.edit_endpoint.is_some(), "{}.{}: edit-only input without edit endpoint", m.id, input.key);
                assert!(
                    m.media.iter().filter(|i| i.key == input.key).count() == 1 && Some(input.key) != m.end_field,
                    "{}.{} declared twice",
                    m.id,
                    input.key
                );
            }
            if m.draft {
                assert_eq!(m.category, Category::Video, "{}: drafts are video-only", m.id);
            }
            if m.end_field.is_some() {
                assert_eq!(m.category, Category::Video, "{}: end frames are video-only", m.id);
            }
        }
    }
}
