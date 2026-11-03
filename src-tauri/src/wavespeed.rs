//! WaveSpeedAI: an alternative to fal for people without a fal account.
//!
//! The registry's models stay the source of truth; `MODELS` maps those that
//! WaveSpeed hosts to its own model ids. Settings and values follow
//! WaveSpeed's schema of each model (from its catalog), not fal's, since
//! names and values differ (`images` vs `image_urls`, `1k` vs `1K`…).
//! Mappings checked against WaveSpeed's catalog, November 2026.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use crate::account;
use crate::error::{AppError, Result};
use crate::schema::{self, Setting};
use crate::storage;

const API: &str = "https://api.wavespeed.ai/api/v3";
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const TIMEOUT: Duration = Duration::from_secs(1800);

/// How a WaveSpeed model takes the node's reference images.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Refs {
    /// `images: [..]`
    Images,
    /// `image: ".."` (only the first reference is used)
    Image,
    /// Takes none.
    None,
    /// An array under another name (`reference_images`…).
    Named(&'static str),
}

/// Video upscalers (720p to 4K) for the Upscale node: standard, and Pro
/// (better detail and frame-to-frame consistency, 4 to 8 times the price).
pub fn upscale_model(pro: bool) -> &'static str {
    if pro { "wavespeed-ai/video-upscaler-pro" } else { "wavespeed-ai/video-upscaler" }
}

/// Dollars per second of video, from WaveSpeed's docs (per 5 s: standard
/// $0.025 up to 1080p, $0.05 in 2K, $0.10 in 4K; Pro $0.20, $0.30, $0.40).
pub fn upscale_per_second(resolution: &str, pro: bool) -> f64 {
    let per_five = match (resolution, pro) {
        ("4k", false) => 0.10,
        ("2k", false) => 0.05,
        (_, false) => 0.025,
        ("4k", true) => 0.40,
        ("2k", true) => 0.30,
        (_, true) => 0.20,
    };
    per_five / 5.0
}

pub struct Mapping {
    /// Registry id (`models::ModelDef::id`).
    pub model: &'static str,
    /// Without reference images.
    pub text: Option<&'static str>,
    /// With reference images.
    pub edit: Option<&'static str>,
    pub refs: Refs,
    /// Field of the end frame, for models that take one.
    pub end: Option<&'static str>,
    /// The registry's media inputs this model takes: (registry key, WaveSpeed
    /// field, sent as an array).
    pub media: &'static [(&'static str, &'static str, bool)],
}

const fn image(model: &'static str, text: &'static str, edit: Option<&'static str>, refs: Refs) -> Mapping {
    Mapping { model, text: Some(text), edit, refs, end: None, media: &[] }
}

const fn video(model: &'static str, text: &'static str, edit: &'static str, end: Option<&'static str>) -> Mapping {
    Mapping { model, text: Some(text), edit: Some(edit), refs: Refs::Image, end, media: &[] }
}

pub static MODELS: &[Mapping] = &[
    image("nano-banana-pro", "google/nano-banana-pro/text-to-image", Some("google/nano-banana-pro/edit"), Refs::Images),
    image("nano-banana-2", "google/nano-banana-2/text-to-image", Some("google/nano-banana-2/edit"), Refs::Images),
    image("seedream-5-lite", "bytedance/seedream-v5.0-lite", Some("bytedance/seedream-v5.0-lite/edit"), Refs::Images),
    image("seedream-4.5", "bytedance/seedream-v4.5", Some("bytedance/seedream-v4.5/edit"), Refs::Images),
    image("gpt-image-2", "openai/gpt-image-2/text-to-image", Some("openai/gpt-image-2/edit"), Refs::Images),
    image("flux-2-pro", "wavespeed-ai/flux-2-pro/text-to-image", Some("wavespeed-ai/flux-2-pro/edit"), Refs::Images),
    image("flux-kontext-pro", "wavespeed-ai/flux-kontext-pro/text-to-image", Some("wavespeed-ai/flux-kontext-pro"), Refs::Image),
    image("qwen-image-3", "alibaba/qwen-image-3.0/text-to-image", Some("alibaba/qwen-image-3.0/edit"), Refs::Images),
    image("recraft-v4-pro", "recraft-ai/recraft-v4-pro/text-to-image", None, Refs::None),
    // The same endpoint takes an optional `image` (image-to-image).
    image("flux-schnell", "wavespeed-ai/flux-schnell", Some("wavespeed-ai/flux-schnell"), Refs::Image),
    video("kling-4", "kwaivgi/kling-v4.0/text-to-video", "kwaivgi/kling-v4.0/image-to-video", Some("last_image")),
    video("minimax-h3", "wavespeed-ai/minimax-h3/text-to-video", "wavespeed-ai/minimax-h3/image-to-video", Some("last_image")),
    video("seedance-2.5", "bytedance/seedance-2.5/text-to-video", "bytedance/seedance-2.5/image-to-video", Some("last_image")),
    video("seedance-2", "bytedance/seedance-2.0/text-to-video", "bytedance/seedance-2.0/image-to-video", Some("last_image")),
    video("kling-3-pro", "kwaivgi/kling-v3.0-pro/text-to-video", "kwaivgi/kling-v3.0-pro/image-to-video", Some("last_image")),
    video("kling-2.5-turbo-pro", "kwaivgi/kling-v2.5-turbo-pro/text-to-video", "kwaivgi/kling-v2.5-turbo-pro/image-to-video", Some("last_image")),
    video("veo-3.1", "google/veo3.1/text-to-video", "google/veo3.1/image-to-video", Some("last_image")),
    video("veo-3.1-fast", "google/veo3.1-fast/text-to-video", "google/veo3.1-fast/image-to-video", Some("last_image")),
    video("hailuo-02", "minimax/hailuo-02/t2v-standard", "minimax/hailuo-02/i2v-standard", Some("last_image")),
    video("wan-2.5", "alibaba/wan-2.5/text-to-video", "alibaba/wan-2.5/image-to-video", None),
    video("ltx-2", "wavespeed-ai/ltx-2.3/text-to-video", "wavespeed-ai/ltx-2.3/image-to-video", None),
    // Seedance 2.5 with a reference video: WaveSpeed splits fal's one endpoint
    // in two, motion transfer (reference) and editing (video-edit).
    Mapping {
        model: "seedance-2.5-motion",
        text: Some("bytedance/seedance-2.5/reference-to-video"),
        edit: Some("bytedance/seedance-2.5/reference-to-video"),
        refs: Refs::Named("reference_images"),
        end: None,
        media: &[("video_urls", "reference_videos", true)],
    },
    Mapping {
        model: "seedance-2.5-swap",
        text: Some("bytedance/seedance-2.5/video-edit"),
        edit: Some("bytedance/seedance-2.5/video-edit"),
        refs: Refs::Named("reference_images"),
        end: None,
        media: &[("video_urls", "video", false)],
    },
    Mapping { model: "elevenlabs-music", text: Some("elevenlabs/music"), edit: None, refs: Refs::None, end: None, media: &[] },
    // WaveSpeed hosts version 3 of ElevenLabs' sound effects (fal: version 2).
    Mapping { model: "elevenlabs-sfx-v2", text: Some("elevenlabs/sound-effects-v3"), edit: None, refs: Refs::None, end: None, media: &[] },
];

pub fn mapping(model: &str) -> Option<&'static Mapping> {
    MODELS.iter().find(|m| m.model == model)
}

/// A Recast model on WaveSpeed: the character image goes in `image`, the
/// source video (or segment) in `video`; `fixed` are values the node implies.
pub struct RecastModel {
    pub model: &'static str,
    pub ws: &'static str,
    pub fixed: &'static [(&'static str, &'static str)],
    /// Dollars per second of video, by resolution (from WaveSpeed's model
    /// pages, November 2026): its price API can't tell without the video.
    pub per_second: fn(&str) -> f64,
}

/// H3 Max Recast isn't on WaveSpeed.
pub static RECAST: &[RecastModel] = &[
    RecastModel {
        model: "wan-2.2-animate-replace",
        ws: "wavespeed-ai/wan-2.2/animate",
        fixed: &[("mode", "replace")],
        per_second: |r| if r.contains("720") { 0.08 } else { 0.04 },
    },
    RecastModel { model: "kling-3-pro-motion", ws: "kwaivgi/kling-v3.0-pro/motion-control", fixed: &[], per_second: |_| 0.168 },
    RecastModel { model: "kling-3-standard-motion", ws: "kwaivgi/kling-v3.0-std/motion-control", fixed: &[], per_second: |_| 0.126 },
];

pub fn recast(model: &str) -> Option<&'static RecastModel> {
    RECAST.iter().find(|m| m.model == model)
}

/// The WaveSpeed model a registry model calls (any kind), with or without references.
pub fn model_for(model: &str, label: &str, with_refs: bool) -> Result<&'static str> {
    if let Some(r) = recast(model) {
        return Ok(r.ws);
    }
    mapping(model).ok_or_else(|| AppError::Invalid(format!("{label} isn't available on WaveSpeed")))?.endpoint(label, with_refs)
}

impl Mapping {
    /// The WaveSpeed model for this call: with or without reference images.
    pub fn endpoint(&self, label: &str, with_refs: bool) -> Result<&'static str> {
        let id = if with_refs { self.edit } else { self.text };
        id.ok_or_else(|| {
            AppError::Invalid(if with_refs {
                format!("{label} on WaveSpeed doesn't take reference images")
            } else {
                format!("{label} on WaveSpeed needs a reference image")
            })
        })
    }
}

/// Inputs the app fills itself, or doesn't show: kept out of the settings.
const MANAGED: &[&str] = &[
    "images",
    "image",
    "last_image",
    "video",
    "audio",
    "mask_image",
    "reference_images",
    "reference_videos",
    "reference_audios",
    "keyframes",
    "element_list",
    "multi_prompt",
    "enable_base64_output",
    "enable_sync_mode",
    "num_images",
];

fn as_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// A node value typed for one property of WaveSpeed's schema; None when it
/// doesn't fit (the model's default applies then). Enumerations ignore case:
/// fal says "1K" where WaveSpeed says "1k".
fn coerce(prop: &Value, raw: &str) -> Option<Value> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(options) = prop["enum"].as_array() {
        return options.iter().find(|o| as_text(o).is_some_and(|t| t.eq_ignore_ascii_case(raw))).cloned();
    }
    match prop["type"].as_str() {
        Some("integer") => raw.parse::<f64>().ok().map(|n| json!(n.round() as i64)),
        Some("number") => raw.parse::<f64>().ok().map(|n| json!(n)),
        Some("boolean") => match raw {
            "true" => Some(json!(true)),
            "false" => Some(json!(false)),
            _ => None,
        },
        Some("string") => Some(json!(raw)),
        _ => None,
    }
}

/// The node's settings typed for `schema`. Registry params first, so an
/// `x:` setting of the same name overrides them; inputs the app fills itself
/// and keys the model doesn't declare are left out.
pub fn settings_input(schema: &Value, params: &HashMap<String, String>) -> Map<String, Value> {
    let props = schema["properties"].as_object().cloned().unwrap_or_default();
    let mut input = Map::new();
    let mut keys: Vec<&String> = params.keys().collect();
    keys.sort_by_key(|k| k.starts_with("x:"));
    for key in keys {
        let name = key.strip_prefix("x:").unwrap_or(key);
        if MANAGED.contains(&name) || matches!(name, "prompt" | "negative_prompt") {
            continue;
        }
        if let Some(value) = props.get(name).and_then(|p| coerce(p, &params[key])) {
            input.insert(name.to_owned(), value);
        }
    }
    input
}

/// A Recast request: settings, the node's fixed values, the character and the video.
pub fn recast_input(schema: &Value, model: &RecastModel, params: &HashMap<String, String>, prompt: &str, image: &str, video: &str) -> Map<String, Value> {
    let mut input = settings_input(schema, params);
    for (key, value) in model.fixed {
        input.insert((*key).into(), json!(value));
    }
    if !prompt.trim().is_empty() {
        input.insert("prompt".into(), json!(prompt));
    }
    input.insert("image".into(), json!(image));
    input.insert("video".into(), json!(video));
    input
}

/// What a model call sends, besides its settings.
pub struct Call<'a> {
    pub prompt: &'a str,
    pub negative: &'a str,
    /// Hosted URLs, in order.
    pub refs: &'a [String],
    pub end_frame: Option<String>,
    /// Hosted media for the mapping's media fields: (WaveSpeed field, value).
    pub media: Vec<(&'static str, Value)>,
}

/// The request body for `schema` (the model's request schema). The
/// inspector's `x:` settings, read from this schema, win over the registry's
/// params (fal's names and defaults, kept as a base); keys the model doesn't
/// declare are left out.
pub fn build_input(schema: &Value, map: &Mapping, label: &str, params: &HashMap<String, String>, call: &Call) -> Result<Map<String, Value>> {
    let props = schema["properties"].as_object().cloned().unwrap_or_default();
    let mut input = settings_input(schema, params);
    if !call.prompt.trim().is_empty() {
        input.insert("prompt".into(), json!(call.prompt));
    }
    if props.contains_key("negative_prompt") && !call.negative.trim().is_empty() {
        input.insert("negative_prompt".into(), json!(call.negative.trim()));
    }
    if !call.refs.is_empty() {
        match map.refs {
            Refs::Images => {
                let max = props.get("images").and_then(|p| p["maxItems"].as_u64()).unwrap_or(u64::MAX) as usize;
                input.insert("images".into(), json!(&call.refs[..call.refs.len().min(max)]));
            }
            Refs::Image => {
                input.insert("image".into(), json!(call.refs[0]));
            }
            Refs::Named(field) => {
                let max = props.get(field).and_then(|p| p["maxItems"].as_u64()).unwrap_or(u64::MAX) as usize;
                input.insert(field.into(), json!(&call.refs[..call.refs.len().min(max)]));
            }
            Refs::None => return Err(AppError::Invalid(format!("{label} on WaveSpeed doesn't take reference images"))),
        }
    }
    for (field, value) in &call.media {
        input.insert((*field).into(), value.clone());
    }
    match (&call.end_frame, map.end) {
        (Some(_), _) if call.refs.is_empty() => return Err(AppError::Invalid("An end image also needs a start image".into())),
        (Some(frame), Some(field)) => {
            input.insert(field.into(), json!(frame));
        }
        (Some(_), None) => return Err(AppError::Invalid(format!("{label} on WaveSpeed doesn't take an end image"))),
        (None, _) => {}
    }
    Ok(input)
}

// ---------------------------------------------------------------------------
// Client

pub struct WaveSpeed {
    http: Client,
    key: String,
}

/// WaveSpeed's catalog: each model's request schema, fetched once per session.
type Catalog = Arc<HashMap<String, Value>>;

fn catalog_cache() -> &'static Mutex<Option<Catalog>> {
    static CACHE: OnceLock<Mutex<Option<Catalog>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    /// What WaveSpeed charges, the account's discount included.
    pub cost: f64,
    /// Before the discount.
    pub list: f64,
}

impl WaveSpeed {
    pub fn from_account(http: &Client) -> Result<Self> {
        Ok(Self { http: http.clone(), key: account::wavespeed_key()? })
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.key)
    }

    /// `data` of an answer; `submitting` marks a refusal of a new task (not billed).
    async fn answer(res: reqwest::Response, submitting: bool) -> Result<Value> {
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let code = body["code"].as_u64().unwrap_or(status.as_u16() as u64);
        if status.is_success() && code == 200 {
            return Ok(body["data"].clone());
        }
        let message = body["message"].as_str().map(str::to_owned).unwrap_or_else(|| status.to_string());
        let text = match status {
            StatusCode::UNAUTHORIZED => "API key refused (invalid or deleted). Check it in Settings → WaveSpeed".to_owned(),
            StatusCode::FORBIDDEN => format!("access denied: {message}"),
            StatusCode::TOO_MANY_REQUESTS => "too many requests at once: try again in a moment".to_owned(),
            _ => message,
        };
        if submitting && (status.is_client_error() || code / 100 == 4) {
            Err(AppError::Refused(format!("WaveSpeed: {text}")))
        } else {
            Err(AppError::WaveSpeed(text))
        }
    }

    async fn get(&self, path: &str) -> Result<Value> {
        let res = self.http.get(format!("{API}{path}")).header(AUTHORIZATION, self.auth()).send().await?;
        Self::answer(res, false).await
    }

    async fn post(&self, path: &str, body: &Value, submitting: bool) -> Result<Value> {
        let res = self.http.post(format!("{API}{path}")).header(AUTHORIZATION, self.auth()).json(body).send().await?;
        Self::answer(res, submitting).await
    }

    /// Dollars left on the account.
    pub async fn balance(&self) -> Result<f64> {
        Ok(self.get("/balance").await?["balance"].as_f64().unwrap_or(0.0))
    }

    async fn catalog(&self) -> Result<Catalog> {
        let mut cache = catalog_cache().lock().await;
        if let Some(hit) = cache.as_ref() {
            return Ok(hit.clone());
        }
        let data = self.get("/models").await?;
        let list = data.as_array().cloned().or_else(|| data["items"].as_array().cloned()).unwrap_or_default();
        let mut schemas = HashMap::new();
        for model in list {
            let Some(id) = model["model_id"].as_str() else { continue };
            let run = model["api_schema"]["api_schemas"].as_array().into_iter().flatten().find(|s| s["type"] == "model_run");
            if let Some(schema) = run.map(|s| s["request_schema"].clone()) {
                schemas.insert(id.to_owned(), schema);
            }
        }
        let catalog = Arc::new(schemas);
        *cache = Some(catalog.clone());
        Ok(catalog)
    }

    /// The request schema of a WaveSpeed model.
    pub async fn schema(&self, model: &str) -> Result<Value> {
        self.catalog().await?.get(model).cloned().ok_or_else(|| AppError::WaveSpeed(format!("model not found in the catalog: {model}")))
    }

    /// Settings shown in the inspector, from WaveSpeed's schema.
    pub async fn settings(&self, model: &str) -> Result<Vec<Setting>> {
        Ok(schema::from_schema(&self.schema(model).await?, &Value::Null, MANAGED))
    }

    /// Exact price of a request, before submitting it.
    pub async fn price(&self, model: &str, inputs: &Map<String, Value>) -> Result<Price> {
        let data = self.post("/model/price", &json!({ "model_id": model, "inputs": inputs }), false).await?;
        let list = data["price"].as_f64().unwrap_or(0.0);
        Ok(Price { cost: data["discounted_price"].as_f64().unwrap_or(list), list })
    }

    /// A local file, as a URL model inputs accept.
    pub async fn upload(&self, path: &Path) -> Result<String> {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned();
        let mime = storage::mime_for(&storage::extension(path)).unwrap_or("application/octet-stream");
        let bytes = tokio::fs::read(path).await?;
        let res = self
            .http
            .post(format!("{API}/media/upload/binary"))
            .header(AUTHORIZATION, self.auth())
            .header(CONTENT_TYPE, mime)
            .header("file", name)
            .body(bytes)
            .send()
            .await?;
        let data = Self::answer(res, true).await?;
        data["download_url"].as_str().map(str::to_owned).ok_or_else(|| AppError::WaveSpeed("upload without a URL".into()))
    }

    /// Runs a model and waits for it. Returns the first output's URL.
    pub async fn run(&self, model: &str, input: Map<String, Value>) -> Result<String> {
        let task = self.post(&format!("/{model}"), &Value::Object(input), true).await?;
        let id = task["id"].as_str().ok_or_else(|| AppError::WaveSpeed("task created without an id".into()))?.to_owned();
        let started = Instant::now();
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let result = self.get(&format!("/predictions/{id}/result")).await?;
            match result["status"].as_str().unwrap_or_default() {
                "completed" => {
                    return result["outputs"][0]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| AppError::WaveSpeed("empty response".into()));
                }
                "failed" | "cancelled" | "timeout" => {
                    let error = result["error"].as_str().filter(|e| !e.is_empty()).unwrap_or("generation failed");
                    return Err(AppError::WaveSpeed(error.to_owned()));
                }
                _ if started.elapsed() > TIMEOUT => return Err(AppError::WaveSpeed("no result after 30 minutes".into())),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seedance_swap_sends_the_video_and_named_references() {
        let map = mapping("seedance-2.5-swap").unwrap();
        let schema = json!({ "properties": { "prompt": {}, "video": {}, "reference_images": {}, "resolution": { "enum": ["480p", "720p"] } } });
        let refs = vec!["https://x/1.png".to_owned()];
        let params = HashMap::from([("resolution".to_owned(), "720p".to_owned()), ("task".to_owned(), "editing".to_owned())]);
        let call = Call { prompt: "swap", negative: "", refs: &refs, end_frame: None, media: vec![("video", json!("https://x/v.mp4"))] };
        let input = build_input(&schema, map, "Swap", &params, &call).unwrap();
        assert_eq!(input["video"], "https://x/v.mp4");
        assert_eq!(input["reference_images"], json!(["https://x/1.png"]));
        assert_eq!(input["resolution"], "720p");
        assert!(input.get("task").is_none(), "fal's task isn't in WaveSpeed's schema");
    }
    use crate::models;

    fn schema() -> Value {
        json!({ "properties": {
            "prompt": { "type": "string" },
            "images": { "type": "array", "maxItems": 2 },
            "resolution": { "type": "string", "enum": ["1k", "2k", "4k"] },
            "duration": { "type": "integer" },
            "generate_audio": { "type": "boolean" },
            "negative_prompt": { "type": "string" },
            "seed": { "type": "integer" }
        }})
    }

    #[test]
    fn every_mapping_is_a_registry_model() {
        for m in MODELS {
            let def = models::find(m.model).unwrap_or_else(|| panic!("{} is not in the registry", m.model));
            assert!(m.text.is_some() || m.edit.is_some(), "{}", m.model);
            // A model that takes references in the registry keeps them here.
            if def.max_refs > 0 && def.text_endpoint.is_some() {
                assert!(m.text.is_some(), "{}: no text-only endpoint", m.model);
            }
        }
        let mut ids: Vec<_> = MODELS.iter().map(|m| m.model).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), MODELS.len(), "a model is mapped twice");
    }

    #[test]
    fn values_follow_the_schema() {
        let map = mapping("nano-banana-2").unwrap();
        let params = HashMap::from([
            ("modelId".to_owned(), "nano-banana-2".to_owned()),
            ("resolution".to_owned(), "2K".to_owned()),
            ("x:resolution".to_owned(), "4k".to_owned()),
            ("x:seed".to_owned(), "42".to_owned()),
            ("x:duration".to_owned(), "auto".to_owned()),
            ("x:generate_audio".to_owned(), "true".to_owned()),
            ("image_size".to_owned(), "square_hd".to_owned()),
        ]);
        let refs = vec!["a".to_owned(), "b".to_owned(), "c".to_owned()];
        let call = Call { prompt: "a fox", negative: "blur", refs: &refs, end_frame: None, media: Vec::new() };
        let input = build_input(&schema(), map, "Nano Banana 2", &params, &call).unwrap();
        // A registry value alone is kept, its case fixed to WaveSpeed's.
        let alone = HashMap::from([("resolution".to_owned(), "2K".to_owned())]);
        assert_eq!(build_input(&schema(), map, "Nano Banana 2", &alone, &call).unwrap()["resolution"], "2k");
        // The inspector's setting wins; unknown keys are dropped.
        assert_eq!(input["resolution"], "4k");
        assert_eq!(input["seed"], 42);
        assert_eq!(input["generate_audio"], true);
        assert!(!input.contains_key("duration") && !input.contains_key("image_size") && !input.contains_key("modelId"));
        assert_eq!(input["prompt"], "a fox");
        assert_eq!(input["negative_prompt"], "blur");
        // No more references than the model takes.
        assert_eq!(input["images"], json!(["a", "b"]));
    }

    #[test]
    fn single_image_models_and_end_frames() {
        let map = mapping("kling-4").unwrap();
        let schema = json!({ "properties": { "prompt": { "type": "string" }, "image": { "type": "string" }, "last_image": { "type": "string" } } });
        let refs = vec!["start".to_owned(), "other".to_owned()];
        let call = Call { prompt: "go", negative: "", refs: &refs, end_frame: Some("end".into()), media: Vec::new() };
        let input = build_input(&schema, map, "Kling 4", &HashMap::new(), &call).unwrap();
        assert_eq!((input["image"].as_str(), input["last_image"].as_str()), (Some("start"), Some("end")));

        let none: Vec<String> = Vec::new();
        let lonely = Call { prompt: "go", negative: "", refs: &none, end_frame: Some("end".into()), media: Vec::new() };
        assert!(build_input(&schema, map, "Kling 4", &HashMap::new(), &lonely).is_err());
        let no_end = mapping("wan-2.5").unwrap();
        assert!(build_input(&schema, no_end, "Wan 2.5", &HashMap::new(), &call).is_err());
    }

    /// Reads the real catalog and prices, for free (no generation):
    /// `WAVESPEED_API_KEY=… cargo test wavespeed -- --ignored`.
    #[test]
    #[ignore]
    fn every_mapping_builds_a_priced_request() {
        let Ok(key) = std::env::var("WAVESPEED_API_KEY") else { return };
        let ws = WaveSpeed { http: Client::new(), key };
        tauri::async_runtime::block_on(async {
            assert!(ws.balance().await.unwrap() >= 0.0);
            for map in MODELS {
                let label = models::find(map.model).unwrap().label;
                for (model, edit) in [(map.text, false), (map.edit, true)] {
                    let Some(model) = model else { continue };
                    let schema = ws.schema(model).await.unwrap();
                    assert!(!ws.settings(model).await.unwrap().iter().any(|s| MANAGED.contains(&s.key.as_str())), "{model}");
                    let refs = vec!["https://example.com/a.png".to_owned()];
                    let call = Call { prompt: "test", negative: "", refs: if edit { &refs } else { &[] }, end_frame: None, media: Vec::new() };
                    let params = HashMap::from([("modelId".to_owned(), map.model.to_owned())]);
                    let input = build_input(&schema, map, label, &params, &call).unwrap();
                    let price = ws.price(model, &input).await.unwrap_or_else(|e| panic!("{model}: {e}"));
                    assert!(price.cost > 0.0, "{model}");
                    eprintln!("{model}: ${:.3}", price.cost);
                }
            }
        });
    }

    #[test]
    fn recast_requests() {
        let wan = recast("wan-2.2-animate-replace").unwrap();
        let schema = json!({ "properties": {
            "image": { "type": "string" }, "video": { "type": "string" }, "prompt": { "type": "string" },
            "mode": { "type": "string", "enum": ["animate", "replace"] },
            "resolution": { "type": "string", "enum": ["480p", "720p"] }, "seed": { "type": "integer" }
        }});
        // fal's 580p doesn't exist here: dropped, WaveSpeed's default applies.
        let params = HashMap::from([("resolution".to_owned(), "580p".to_owned()), ("x:seed".to_owned(), "7".to_owned()), ("mode".to_owned(), "replace".to_owned())]);
        let input = recast_input(&schema, wan, &params, "keep the face", "img", "vid");
        assert_eq!((input["mode"].as_str(), input["image"].as_str(), input["video"].as_str()), (Some("replace"), Some("img"), Some("vid")));
        assert_eq!(input["seed"], 7);
        assert!(!input.contains_key("resolution"));
        assert_eq!(((wan.per_second)("720p"), (wan.per_second)("480p")), (0.08, 0.04));
        assert!(model_for("h3-max-recast", "H3 Max Recast", true).is_err());
        assert_eq!(model_for("kling-3-pro-motion", "Kling", true).unwrap(), "kwaivgi/kling-v3.0-pro/motion-control");
        for r in RECAST {
            assert!(models::find(r.model).is_some(), "{}", r.model);
        }
    }

    #[test]
    fn endpoints_by_mode() {
        let recraft = mapping("recraft-v4-pro").unwrap();
        assert!(recraft.endpoint("Recraft", false).is_ok());
        assert!(recraft.endpoint("Recraft", true).is_err());
    }
}
