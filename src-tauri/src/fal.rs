//! Minimal client for the fal.ai queue REST API: submit, poll status, fetch result.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    Client, Response,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::error::{AppError, Result};
use crate::models::{self, Category, ModelDef, Mode, ParamKind, RefField};
use crate::schema;
use crate::storage;

const QUEUE_URL: &str = "https://queue.fal.run";
const STORAGE_INITIATE_URL: &str = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const VIDEO_UNDERSTANDING_ENDPOINT: &str = "fal-ai/video-understanding";
const SEEDANCE_DRAFT_COMPLETE_ENDPOINT: &str = "bytedance/seedance-2.5/draft/complete";
pub const TRIM_VIDEO_ENDPOINT: &str = "fal-ai/workflow-utilities/trim-video";
pub const MERGE_VIDEOS_ENDPOINT: &str = "fal-ai/ffmpeg-api/merge-videos";
pub const MERGE_AUDIO_VIDEO_ENDPOINT: &str = "fal-ai/ffmpeg-api/merge-audio-video";

/// What one model call sends besides the model's own params.
pub struct ModelCall<'a> {
    pub prompt: &'a str,
    pub system: &'a str,
    /// Reference images; switches to the edit / image-to-video endpoint.
    pub refs: &'a [String],
    pub end_frame: Option<String>,
    pub negative: &'a str,
    /// Extra media inputs, already as fal URLs, with the endpoint(s) they go to.
    pub media: Vec<(&'static str, Mode, Value)>,
}

impl<'a> ModelCall<'a> {
    pub fn new(prompt: &'a str) -> Self {
        Self { prompt, system: "", refs: &[], end_frame: None, negative: "", media: Vec::new() }
    }
}

pub struct ModelOutput {
    /// Media URL, or the text for LLMs.
    pub value: String,
    /// Set by draft-mode video models; finalize with [`Fal::complete_draft`].
    pub draft_id: Option<String>,
}
const POLL_INTERVAL: Duration = Duration::from_millis(800);
const TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Deserialize)]
struct Submitted {
    status_url: String,
    response_url: String,
    #[serde(default)]
    cancel_url: Option<String>,
}

/// Cancels a fal request whose wait is dropped before it completes: the node
/// was stopped. Without it fal would finish the job, and bill it, unseen.
struct CancelOnDrop {
    http: Client,
    auth: String,
    url: Option<String>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(url) = self.url.take() {
            let (http, auth) = (self.http.clone(), std::mem::take(&mut self.auth));
            tauri::async_runtime::spawn(async move {
                let _ = http.put(url).header(AUTHORIZATION, auth).send().await;
            });
        }
    }
}

#[derive(Deserialize)]
struct UploadTarget {
    upload_url: String,
    file_url: String,
}

#[derive(Deserialize)]
struct Status {
    status: String,
}

pub struct Fal {
    http: Client,
    key: String,
}

async fn check(res: Response) -> Result<Response> {
    if res.status().is_success() {
        return Ok(res);
    }
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let detail = match &body["detail"] {
        Value::String(s) => s.clone(),
        // Validation errors come back as a list of {loc, msg}.
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i["msg"].as_str())
            .collect::<Vec<_>>()
            .join("; "),
        Value::Null => status.to_string(),
        other => other.to_string(),
    };
    Err(AppError::Fal(detail))
}

/// Keeps only declared params whose value is one of the allowed options,
/// typed the way the endpoint expects.
fn model_params(def: &ModelDef, params: &HashMap<String, String>, edit: bool) -> Map<String, Value> {
    def.params
        .iter()
        .filter(|p| !(edit && p.text_only))
        .map(|p| {
            let value = params.get(p.key).map(String::as_str).filter(|v| p.options.contains(v)).unwrap_or(p.default);
            let typed = match p.kind {
                ParamKind::Enum => json!(value),
                ParamKind::Int => json!(value.parse::<i64>().unwrap_or_default()),
                ParamKind::Bool => json!(value == "true"),
            };
            (p.key.to_owned(), typed)
        })
        .collect()
}

impl Fal {
    pub fn new(http: Client, key: String) -> Self {
        Self { http, key }
    }

    fn auth(&self) -> String {
        format!("Key {}", self.key)
    }

    pub async fn subscribe(&self, endpoint: &str, input: Value) -> Result<Value> {
        let res = self
            .http
            .post(format!("{QUEUE_URL}/{endpoint}"))
            .header(AUTHORIZATION, self.auth())
            .json(&input)
            .send()
            .await?;
        let job: Submitted = check(res).await?.json().await?;
        let mut cancel = CancelOnDrop { http: self.http.clone(), auth: self.auth(), url: job.cancel_url.clone() };

        let started = Instant::now();
        loop {
            if started.elapsed() > TIMEOUT {
                return Err(AppError::Fal("délai dépassé".into()));
            }
            tokio::time::sleep(POLL_INTERVAL).await;
            let res = self.http.get(&job.status_url).header(AUTHORIZATION, self.auth()).send().await?;
            let status: Status = check(res).await?.json().await?;
            if status.status == "COMPLETED" {
                break;
            }
        }
        cancel.url = None;

        // A failed job surfaces its error on the result endpoint.
        let res = self.http.get(&job.response_url).header(AUTHORIZATION, self.auth()).send().await?;
        Ok(check(res).await?.json().await?)
    }

    /// Uploads a local file to fal storage (same protocol as the official JS client).
    pub async fn upload(&self, path: &Path) -> Result<String> {
        let mime = storage::mime_for(&storage::extension(path)).unwrap_or("application/octet-stream");
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("upload");
        let res = self
            .http
            .post(STORAGE_INITIATE_URL)
            .header(AUTHORIZATION, self.auth())
            .json(&json!({ "content_type": mime, "file_name": name }))
            .send()
            .await?;
        let target: UploadTarget = check(res).await?.json().await?;
        let bytes = tokio::fs::read(path).await?;
        let res = self.http.put(&target.upload_url).header(CONTENT_TYPE, mime).body(bytes).send().await?;
        check(res).await?;
        Ok(target.file_url)
    }

    /// Turns a Seedance draft into the 1080p video. Returns the video URL.
    pub async fn complete_draft(&self, draft_id: &str) -> Result<String> {
        let input = json!({ "draft_id": draft_id, "resolution": "1080p" });
        let out = self.subscribe(SEEDANCE_DRAFT_COMPLETE_ENDPOINT, input).await?;
        out["video"]["url"].as_str().map(str::to_owned).ok_or_else(|| AppError::Fal("réponse vide".into()))
    }

    /// Cuts `duration` seconds from `start` out of a hosted video. Returns the
    /// piece's URL and the source's full length.
    pub async fn trim_video(&self, video_url: &str, start: f64, duration: f64) -> Result<(String, f64)> {
        let input = json!({ "video_url": video_url, "start_time": start, "duration": duration });
        let out = self.subscribe(TRIM_VIDEO_ENDPOINT, input).await?;
        let url = out["video"]["url"].as_str().ok_or_else(|| AppError::Fal("réponse vide".into()))?;
        Ok((url.to_owned(), out["original_duration"].as_f64().unwrap_or_default()))
    }

    /// Joins hosted videos end to end, in order. Returns the result's URL.
    /// Puts an audio track on a hosted video, from `offset` seconds. Returns the video URL.
    pub async fn merge_audio_video(&self, video_url: &str, audio_url: &str, offset: f64) -> Result<String> {
        let input = json!({ "video_url": video_url, "audio_url": audio_url, "start_offset": offset });
        let out = self.subscribe(MERGE_AUDIO_VIDEO_ENDPOINT, input).await?;
        out["video"]["url"].as_str().map(str::to_owned).ok_or_else(|| AppError::Fal("réponse vide".into()))
    }

    pub async fn merge_videos(&self, urls: &[String]) -> Result<String> {
        let out = self.subscribe(MERGE_VIDEOS_ENDPOINT, json!({ "video_urls": urls })).await?;
        out["video"]["url"].as_str().map(str::to_owned).ok_or_else(|| AppError::Fal("réponse vide".into()))
    }

    pub async fn describe_video(&self, video_url: &str, prompt: &str, detailed: bool) -> Result<String> {
        let input = json!({ "video_url": video_url, "prompt": prompt, "detailed_analysis": detailed });
        let out = self.subscribe(VIDEO_UNDERSTANDING_ENDPOINT, input).await?;
        out["output"].as_str().map(str::to_owned).ok_or_else(|| AppError::Fal("réponse vide".into()))
    }

    /// Runs a registry model. With references it uses the edit (or
    /// image-to-video) endpoint, otherwise the text endpoint. Returns a media
    /// URL or the LLM text.
    pub async fn run_model(
        &self,
        def: &ModelDef,
        params: &HashMap<String, String>,
        call: ModelCall<'_>,
    ) -> Result<ModelOutput> {
        let ModelCall { prompt, system, refs, end_frame, negative, media } = call;
        let endpoint = if refs.is_empty() {
            def.text_endpoint.ok_or_else(|| AppError::Invalid(format!("{} exige une image de référence", def.label)))?
        } else {
            def.edit_endpoint.ok_or_else(|| AppError::Invalid(format!("{} n'accepte pas d'image", def.label)))?
        };

        let mut input = model_params(def, params, !refs.is_empty());
        // Inspector settings (`x:<key>`), checked against the endpoint's own
        // schema. The registry's params above keep precedence; if the schema
        // can't be fetched, the call still goes through without them.
        if let Ok(settings) = schema::settings(&self.http, endpoint).await {
            for (key, value) in schema::extras(&settings, params) {
                input.entry(key).or_insert(value);
            }
        }
        // Empty only where the prompt is optional (recast models).
        if !prompt.trim().is_empty() {
            input.insert(models::prompt_key(def).into(), json!(prompt));
        }
        if !system.is_empty() {
            input.insert("system_prompt".into(), json!(system));
        }
        if def.draft {
            input.insert("draft".into(), json!(true));
        }
        for (key, mode, value) in media {
            if mode == Mode::Both || !refs.is_empty() {
                input.insert(key.into(), value);
            }
        }
        // Only to models that take it; an empty one keeps fal's own default.
        if def.negative && !negative.trim().is_empty() {
            input.insert("negative_prompt".into(), json!(negative.trim()));
        }
        if !refs.is_empty() {
            let refs = &refs[..refs.len().min(def.max_refs as usize)];
            match def.ref_field {
                RefField::Urls => input.insert("image_urls".into(), json!(refs)),
                RefField::Url => input.insert("image_url".into(), json!(refs[0])),
                RefField::StartImage => input.insert("start_image_url".into(), json!(refs[0])),
                RefField::ReferenceUrls => input.insert("reference_image_urls".into(), json!(refs)),
            };
        }
        match (end_frame, def.end_field) {
            (Some(_), _) if refs.is_empty() => {
                return Err(AppError::Invalid("Une image de fin demande aussi une image de départ".into()));
            }
            (Some(frame), Some(field)) => {
                input.insert(field.into(), json!(frame));
            }
            (Some(_), None) => return Err(AppError::Invalid(format!("{} n'accepte pas d'image de fin", def.label))),
            (None, _) => {}
        }

        let out = self.subscribe(endpoint, Value::Object(input)).await?;
        let value = match def.category {
            Category::Image => out["images"][0]["url"].as_str(),
            Category::Video => out["video"]["url"].as_str(),
            Category::Llm => out["output"].as_str(),
            Category::Audio => out["audio"]["url"].as_str(),
        };
        let value = value.map(str::to_owned).ok_or_else(|| AppError::Fal("réponse vide".into()))?;
        let draft_id = out["draft_id"].as_str().map(str::to_owned);
        Ok(ModelOutput { value, draft_id })
    }
}
