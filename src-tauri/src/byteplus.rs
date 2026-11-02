//! BytePlus ModelArk, next to fal: Seedance 2.5 video and Seedream image tasks
//! (API key), and the private virtual portrait library (OpenAPI signed with an
//! Access Key / Secret Key). Every endpoint and field used here is documented;
//! the sources are listed in docs/byteplus-notes.md.
//!
//! Faces: Seedance refuses images with a realistic face unless they come
//! through one of BytePlus's own ways, a validated portrait (`asset://…`) or
//! a recent Seedream text-to-image output of the same account. Nothing here
//! alters an image to get past that check.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    Client, Response, StatusCode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::account;
use crate::error::{AppError, Result};
use crate::storage;

/// The only region the docs describe (ap-southeast-1, Johor).
pub const REGION: &str = "ap-southeast-1";
const ARK_URL: &str = "https://ark.ap-southeast.bytepluses.com/api/v3";
const OPENAPI_HOST: &str = "ark.ap-southeast-1.byteplusapi.com";
const SERVICE: &str = "ark";
const OPENAPI_VERSION: &str = "2024-01-01";
/// Assets are isolated per project; everything goes to the default one.
const PROJECT: &str = "default";

pub const SEEDANCE_25: &str = "dreamina-seedance-2-5-260628";
pub const SEEDREAM_PRO: &str = "dola-seedream-5-0-pro-260628";
pub const SEEDREAM_FLASH: &str = "dola-seedream-5-0-flash-260915";

/// Seedance 2.5: reference images per task, and output length in seconds.
pub const MAX_REFS: usize = 30;
const MIN_SECONDS: i64 = 4;
const MAX_SECONDS: i64 = 30;
/// Seedream: reference images per request.
pub const MAX_IMAGE_REFS: usize = 10;

const TASK_POLL: Duration = Duration::from_secs(5);
/// A task left queued or running longer is expired by BytePlus itself
/// (`execution_expires_after`, 3600 s is the documented minimum)…
const TASK_EXPIRES_AFTER: u64 = 3600;
/// …so the app stops waiting a little after that.
const TASK_TIMEOUT: Duration = Duration::from_secs(TASK_EXPIRES_AFTER + 300);
const ASSET_POLL: Duration = Duration::from_secs(3);
/// Portrait review has no SLA; past this the node can be run again to resume.
const ASSET_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Output URLs are valid 24 hours.
const URL_LIFETIME_MS: u128 = 24 * 3600 * 1000;

const FACE_REFUSED: &str =
    "Image refused by the face filter: use a validated AI Portrait or a BytePlus Seedream image (text-to-image, under 30 days old).";

// ---------------------------------------------------------------------------
// Errors

/// French message for a BytePlus error code and message.
fn explain(status: Option<StatusCode>, code: &str, message: &str) -> String {
    let text = format!("{code} {message}").to_ascii_lowercase();
    if text.contains("sensitive") || text.contains("real person") || text.contains("likeness") || text.contains("face") {
        return FACE_REFUSED.to_owned();
    }
    if text.contains("draft") && (text.contains("expire") || text.contains("not found") || text.contains("invalid")) {
        return "Draft expired or not found: BytePlus only keeps it 14 days.".to_owned();
    }
    match status {
        Some(StatusCode::UNAUTHORIZED) => "API key refused (invalid or revoked). Check it in Settings → BytePlus ModelArk".to_owned(),
        Some(StatusCode::FORBIDDEN) => format!("access denied (model not activated on the BytePlus account?): {message}"),
        Some(StatusCode::TOO_MANY_REQUESTS) => "quota or request limit (QPM) exceeded: try again in a moment".to_owned(),
        Some(StatusCode::NOT_FOUND) => format!("address not found (wrong region?): {message}"),
        _ if code.is_empty() => message.to_owned(),
        _ => format!("{message} ({code})"),
    }
}

/// An error answer of the model API. A refused creation was not billed.
async fn ark_error(res: Response, creating: bool) -> AppError {
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let code = body["error"]["code"].as_str().unwrap_or_default();
    let message = body["error"]["message"].as_str().map(str::to_owned).unwrap_or_else(|| status.to_string());
    let text = explain(Some(status), code, &message);
    if creating && status.is_client_error() {
        AppError::Refused(format!("BytePlus: {text}"))
    } else {
        AppError::BytePlus(text)
    }
}

// ---------------------------------------------------------------------------
// Model API (API key)

#[derive(Deserialize)]
struct TaskError {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Deserialize, Default)]
struct TaskContent {
    #[serde(default)]
    video_url: String,
}

#[derive(Deserialize)]
struct Task {
    status: String,
    #[serde(default)]
    content: Option<TaskContent>,
    #[serde(default)]
    error: Option<TaskError>,
    #[serde(default)]
    created_at: i64,
}

/// A finished video task.
pub struct Video {
    pub id: String,
    pub url: String,
    /// Unix seconds; a Draft is valid 14 days from then.
    pub created_at: i64,
}

/// Cancels a task whose wait is dropped (the node was stopped). BytePlus only
/// cancels a task still queued; a running one goes on and is billed.
struct CancelOnDrop {
    http: Client,
    key: String,
    id: Option<String>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let (http, key) = (self.http.clone(), std::mem::take(&mut self.key));
            tauri::async_runtime::spawn(async move {
                let _ = http.delete(format!("{ARK_URL}/contents/generations/tasks/{id}")).bearer_auth(key).send().await;
            });
        }
    }
}

pub struct BytePlus {
    http: Client,
    key: String,
}

impl BytePlus {
    /// With the API key saved in Settings.
    pub fn from_account(http: &Client) -> Result<Self> {
        Ok(Self { http: http.clone(), key: account::byteplus_key()? })
    }

    /// Checks the key with a read-only call: listing tasks.
    pub async fn test(&self) -> Result<()> {
        let res = self.http.get(format!("{ARK_URL}/contents/generations/tasks")).query(&[("page_size", "1")]).bearer_auth(&self.key).send().await?;
        match res.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(ark_error(res, false).await),
            // Anything else went past authentication.
            _ => Ok(()),
        }
    }

    async fn create_task(&self, body: &Value) -> Result<String> {
        let res = self.http.post(format!("{ARK_URL}/contents/generations/tasks")).bearer_auth(&self.key).json(body).send().await?;
        if !res.status().is_success() {
            return Err(ark_error(res, true).await);
        }
        let created: Value = res.json().await?;
        created["id"].as_str().map(str::to_owned).ok_or_else(|| AppError::BytePlus("response without a task id".into()))
    }

    /// Creates a video task and waits for its video.
    pub async fn video(&self, body: &Value) -> Result<Video> {
        let id = self.create_task(body).await?;
        let mut cancel = CancelOnDrop { http: self.http.clone(), key: self.key.clone(), id: Some(id.clone()) };
        let started = Instant::now();
        loop {
            if started.elapsed() > TASK_TIMEOUT {
                return Err(AppError::BytePlus("timed out: the task didn't finish in time".into()));
            }
            tokio::time::sleep(TASK_POLL).await;
            let res = self.http.get(format!("{ARK_URL}/contents/generations/tasks/{id}")).bearer_auth(&self.key).send().await?;
            if !res.status().is_success() {
                return Err(ark_error(res, false).await);
            }
            let task: Task = res.json().await?;
            match task.status.as_str() {
                "succeeded" => {
                    cancel.id = None;
                    let url = task.content.unwrap_or_default().video_url;
                    if url.is_empty() {
                        return Err(AppError::BytePlus("task finished without a video".into()));
                    }
                    return Ok(Video { id, url, created_at: task.created_at });
                }
                "failed" => {
                    cancel.id = None;
                    let e = task.error.unwrap_or(TaskError { code: String::new(), message: "failed without details".into() });
                    return Err(AppError::BytePlus(explain(None, &e.code, &e.message)));
                }
                "expired" => {
                    cancel.id = None;
                    return Err(AppError::BytePlus("timed out: BytePlus expired the task".into()));
                }
                "cancelled" => {
                    cancel.id = None;
                    return Err(AppError::BytePlus("task cancelled".into()));
                }
                _ => {}
            }
        }
    }

    /// Generates one image. Returns its URL (valid 24 hours).
    pub async fn image(&self, body: &Value) -> Result<String> {
        let res = self.http.post(format!("{ARK_URL}/images/generations")).bearer_auth(&self.key).json(body).send().await?;
        if !res.status().is_success() {
            return Err(ark_error(res, true).await);
        }
        let out: Value = res.json().await?;
        if let Some(url) = out["data"][0]["url"].as_str() {
            return Ok(url.to_owned());
        }
        let e = &out["data"][0]["error"];
        let message = e["message"].as_str().or(out["error"]["message"].as_str()).unwrap_or("response without an image");
        Err(AppError::BytePlus(explain(None, e["code"].as_str().unwrap_or_default(), message)))
    }
}

/// What a Seedance 2.5 task is made of, with media already as URLs, data URIs
/// or `asset://` URIs.
pub struct SeedanceInput<'a> {
    pub prompt: &'a str,
    pub start: Option<String>,
    pub end: Option<String>,
    /// Portraits first, then reference images: "Image 1, Image 2…" in that order.
    pub refs: Vec<String>,
    pub params: &'a HashMap<String, String>,
}

fn param<'a>(params: &'a HashMap<String, String>, key: &str) -> &'a str {
    params.get(key).map(String::as_str).unwrap_or_default()
}

/// Output length: 4 to 30 seconds, or -1 to let the model pick ("auto").
pub fn seedance_duration(params: &HashMap<String, String>) -> i64 {
    match param(params, "duration").parse::<i64>() {
        Ok(s) if (MIN_SECONDS..=MAX_SECONDS).contains(&s) => s,
        Ok(-1) => -1,
        _ => 5,
    }
}

/// The task body, or why it would be refused. First/last frames and
/// references can't be mixed in one Seedance 2.5 task.
pub fn seedance_body(input: SeedanceInput) -> Result<Value> {
    let SeedanceInput { prompt, start, end, refs, params } = input;
    let frames = start.is_some() || end.is_some();
    if frames && !refs.is_empty() {
        return Err(AppError::Invalid(
            "Seedance 2.5 can't mix a start/end image with references (portraits, images). Disconnect one of them: to keep the character, keep the portrait and describe the first shot in the prompt.".into(),
        ));
    }
    if end.is_some() && start.is_none() {
        return Err(AppError::Invalid("An end image also needs a start image".into()));
    }
    if refs.len() > MAX_REFS {
        return Err(AppError::Invalid(format!("{MAX_REFS} references at most (portraits and images)")));
    }
    if prompt.trim().is_empty() && !frames && refs.is_empty() {
        return Err(AppError::Invalid("Missing prompt".into()));
    }

    let mut content = Vec::new();
    if !prompt.trim().is_empty() {
        content.push(json!({ "type": "text", "text": prompt.trim() }));
    }
    let image = |url: String, role: &str| json!({ "type": "image_url", "image_url": { "url": url }, "role": role });
    if let Some(url) = start {
        content.push(image(url, "first_frame"));
    }
    if let Some(url) = end {
        content.push(image(url, "last_frame"));
    }
    for url in refs {
        content.push(image(url, "reference_image"));
    }

    let draft = param(params, "draft") != "false";
    let resolution = if draft {
        "480p"
    } else {
        match param(params, "resolution") {
            r @ ("480p" | "720p" | "1080p") => r,
            _ => "720p",
        }
    };
    // From a first frame, the model keeps that image's ratio: only "adaptive" is accepted.
    let ratio = match param(params, "ratio") {
        _ if frames => "adaptive",
        r @ ("16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9") => r,
        _ => "adaptive",
    };
    let mut body = json!({
        "model": SEEDANCE_25,
        "content": content,
        "resolution": resolution,
        "ratio": ratio,
        "duration": seedance_duration(params),
        "generate_audio": param(params, "audio") != "false",
        "watermark": false,
        "execution_expires_after": TASK_EXPIRES_AFTER,
    });
    if draft {
        body["draft"] = json!(true);
    }
    if let Ok(seed) = param(params, "seed").trim().parse::<i64>() {
        if (0..=2_147_483_647).contains(&seed) {
            body["seed"] = json!(seed);
        }
    }
    Ok(body)
}

/// Renders a Draft in 1080p. Prompt, references, duration, ratio, seed and
/// sound are reused by the model and must not be sent again.
pub fn finalize_body(draft_id: &str) -> Value {
    json!({
        "model": SEEDANCE_25,
        "content": [{ "type": "draft_task", "draft_task": { "id": draft_id } }],
        "resolution": "1080p",
        "watermark": false,
        "execution_expires_after": TASK_EXPIRES_AFTER,
    })
}

pub fn seedream_body(params: &HashMap<String, String>, prompt: &str, refs: &[String]) -> Result<Value> {
    if prompt.trim().is_empty() {
        return Err(AppError::Invalid("Missing prompt".into()));
    }
    if refs.len() > MAX_IMAGE_REFS {
        return Err(AppError::Invalid(format!("{MAX_IMAGE_REFS} reference images at most")));
    }
    let model = if param(params, "model") == "flash" { SEEDREAM_FLASH } else { SEEDREAM_PRO };
    let size = match param(params, "size") {
        "1K" => "1K",
        _ => "2K",
    };
    let mut body = json!({
        "model": model,
        "prompt": prompt.trim(),
        "size": size,
        "output_format": "png",
        "response_format": "url",
        "watermark": false,
    });
    if !refs.is_empty() {
        body["image"] = json!(refs);
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// Trusted outputs: Seedream text-to-image results with a face are accepted by
// Seedance when they are the original output of the same account, under 30
// days old. The original URL is kept while it lives (24 h), so it can be sent
// as is; after that the downloaded file, byte for byte the original, is sent.

#[derive(Serialize, Deserialize, Default)]
struct TrustedFile {
    /// Local path → (original URL, generation time in Unix ms).
    #[serde(default)]
    outputs: HashMap<String, (String, u128)>,
}

fn trusted_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("byteplus-trusted.json"))
}

static TRUSTED_LOCK: Mutex<()> = Mutex::new(());

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

/// Remembers where a Seedream output came from.
pub fn remember_trusted(app: &AppHandle, path: &str, url: &str) -> Result<()> {
    let _guard = TRUSTED_LOCK.lock().unwrap();
    let file_path = trusted_path(app)?;
    let mut file: TrustedFile = std::fs::read(&file_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let now = now_ms();
    // Past 30 days an output is no longer trusted: forget it.
    file.outputs.retain(|_, (_, at)| now.saturating_sub(*at) < 30 * 24 * 3600 * 1000);
    file.outputs.insert(path.to_owned(), (url.to_owned(), now));
    std::fs::write(&file_path, serde_json::to_vec(&file).map_err(|e| AppError::Invalid(e.to_string()))?)?;
    Ok(())
}

fn trusted_url(app: &AppHandle, path: &str) -> Option<String> {
    let _guard = TRUSTED_LOCK.lock().unwrap();
    let file: TrustedFile = serde_json::from_slice(&std::fs::read(trusted_path(app).ok()?).ok()?).ok()?;
    let (url, at) = file.outputs.get(path)?;
    (now_ms().saturating_sub(*at) < URL_LIFETIME_MS).then(|| url.clone())
}

/// A node value as a BytePlus image: `asset://` and URLs pass through, a
/// Seedream output still online goes by its original URL, any other local
/// image as a data URI.
pub fn image_input(app: &AppHandle, value: &str) -> Result<String> {
    if value.starts_with("asset://") || value.starts_with("http://") || value.starts_with("https://") {
        return Ok(value.to_owned());
    }
    if let Some(url) = trusted_url(app, value) {
        return Ok(url);
    }
    storage::to_model_input(app, value)
}

// ---------------------------------------------------------------------------
// Portrait library (OpenAPI, AK/SK)

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// HMAC-SHA256 (RFC 2104).
fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let pad = |byte: u8| block.iter().map(|b| b ^ byte).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(data).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

/// `20260328T000000Z` for a Unix time in seconds.
fn x_date(secs: u64) -> String {
    let date = account::civil_date((secs / 86_400) as i64).replace('-', "");
    let t = secs % 86_400;
    format!("{date}T{:02}{:02}{:02}Z", t / 3600, t % 3600 / 60, t % 60)
}

/// The `Authorization` header of a signed OpenAPI POST (HMAC-SHA256, as in
/// the CreateAsset reference), with the `X-Date` and `X-Content-Sha256` it signs.
fn sign(ak: &str, sk: &str, action: &str, body: &[u8], secs: u64) -> (String, String, String) {
    let date = x_date(secs);
    let day = &date[..8];
    let payload = sha256_hex(body);
    let query = format!("Action={action}&Version={OPENAPI_VERSION}");
    let signed = "content-type;host;x-content-sha256;x-date";
    let headers = format!("content-type:application/json\nhost:{OPENAPI_HOST}\nx-content-sha256:{payload}\nx-date:{date}\n");
    let canonical = format!("POST\n/\n{query}\n{headers}\n{signed}\n{payload}");
    let scope = format!("{day}/{REGION}/{SERVICE}/request");
    let to_sign = format!("HMAC-SHA256\n{date}\n{scope}\n{}", sha256_hex(canonical.as_bytes()));
    let mut key = hmac(sk.as_bytes(), day.as_bytes());
    for part in [REGION, SERVICE, "request"] {
        key = hmac(&key, part.as_bytes());
    }
    let signature = hex(&hmac(&key, to_sign.as_bytes()));
    (format!("HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed}, Signature={signature}"), date, payload)
}

/// A portrait's state in the library.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetState {
    pub id: String,
    /// "Processing", "Active" or "Failed".
    pub status: String,
}

pub struct Assets {
    http: Client,
    ak: String,
    sk: String,
}

impl Assets {
    /// With the Access Key / Secret Key saved in Settings.
    pub fn from_account(http: &Client) -> Result<Self> {
        let (ak, sk) = account::byteplus_aksk()?;
        Ok(Self { http: http.clone(), ak, sk })
    }

    /// `Filter` with its `GroupType` is required by the List* actions (AIGC: virtual portraits).
    async fn call(&self, action: &str, body: Value) -> Result<Value> {
        let bytes = serde_json::to_vec(&body).map_err(|e| AppError::Invalid(e.to_string()))?;
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let (auth, date, payload) = sign(&self.ak, &self.sk, action, &bytes, secs);
        let res = self
            .http
            .post(format!("https://{OPENAPI_HOST}/"))
            .query(&[("Action", action), ("Version", OPENAPI_VERSION)])
            .header(CONTENT_TYPE, "application/json")
            .header("X-Date", date)
            .header("X-Content-Sha256", payload)
            .header(AUTHORIZATION, auth)
            .body(bytes)
            .send()
            .await?;
        let status = res.status();
        let out: Value = res.json().await.unwrap_or(Value::Null);
        let error = &out["ResponseMetadata"]["Error"];
        if !status.is_success() || error.is_object() {
            let code = error["Code"].as_str().unwrap_or_default();
            let message = error["Message"].as_str().map(str::to_owned).unwrap_or_else(|| status.to_string());
            let text = if status == StatusCode::UNAUTHORIZED || code.contains("Signature") || code.contains("AccessKey") {
                "Access Key or Secret Key refused. Check them in Settings → BytePlus ModelArk".to_owned()
            } else if message.to_ascii_lowercase().contains("not authorized to perform") {
                format!("{message} — the IAM user of these keys lacks this permission. In the console: IAM → User → Authorize, attach a policy allowing ark:*Asset*, valid for the \"default\" project (or all projects).")
            } else if code.contains("Authoriz") || message.to_ascii_lowercase().contains("authoriz") {
                format!("{message} — on the first group creation, BytePlus asks you to sign the authorization letter in the console (Advanced Creation Rights).")
            } else {
                explain(Some(status), code, &message)
            };
            return Err(AppError::BytePlus(text));
        }
        Ok(out["Result"].clone())
    }

    /// Checks the keys with a read-only call.
    pub async fn test(&self) -> Result<()> {
        self.call("ListAssetGroups", json!({ "Filter": { "GroupType": "AIGC" }, "MaxResults": 1, "ProjectName": PROJECT })).await.map(|_| ())
    }

    /// The id of the portrait group with this name, created if needed.
    async fn group(&self, name: &str) -> Result<String> {
        let found = self.call("ListAssetGroups", json!({ "Filter": { "GroupType": "AIGC", "Name": name }, "MaxResults": 100, "ProjectName": PROJECT })).await?;
        // Name is a fuzzy filter: keep the exact match only.
        let existing = found["Items"].as_array().into_iter().flatten().find(|g| g["Name"].as_str() == Some(name));
        if let Some(id) = existing.and_then(|g| g["Id"].as_str()) {
            return Ok(id.to_owned());
        }
        let created = self
            .call("CreateAssetGroup", json!({ "Name": name, "Description": "Virtual portraits (SimpleNode)", "GroupType": "AIGC", "ProjectName": PROJECT }))
            .await?;
        created["Id"].as_str().map(str::to_owned).ok_or_else(|| AppError::BytePlus("group created without an id".into()))
    }

    /// Uploads a portrait from a public URL into the group. Returns its id.
    /// The content pre-filter stays on (no `Moderation` override).
    pub async fn create(&self, group: &str, url: &str, name: &str) -> Result<String> {
        let group_id = self.group(group).await?;
        let created = self
            .call("CreateAsset", json!({ "GroupId": group_id, "URL": url, "AssetType": "Image", "Name": name, "ProjectName": PROJECT }))
            .await?;
        created["Id"].as_str().map(str::to_owned).ok_or_else(|| AppError::BytePlus("portrait uploaded without an id".into()))
    }

    pub async fn state(&self, id: &str) -> Result<AssetState> {
        let asset = self.call("GetAsset", json!({ "Id": id, "ProjectName": PROJECT })).await?;
        Ok(AssetState { id: id.to_owned(), status: asset["Status"].as_str().unwrap_or("Processing").to_owned() })
    }

    /// Waits for the review: true once validated, false if refused.
    pub async fn wait_reviewed(&self, id: &str) -> Result<bool> {
        let started = Instant::now();
        loop {
            match self.state(id).await?.status.as_str() {
                "Active" => return Ok(true),
                "Failed" => return Ok(false),
                _ if started.elapsed() > ASSET_TIMEOUT => {
                    return Err(AppError::BytePlus("review still in progress: run the node again later to resume following it".into()))
                }
                _ => tokio::time::sleep(ASSET_POLL).await,
            }
        }
    }
}

/// BytePlus documents no field giving why a portrait failed its review, so a
/// refusal reminds the conditions instead.
pub const PORTRAIT_REFUSED: &str = "Portrait refused by the BytePlus review (no reason is given). It must be an AI character that resembles no real person, with no logo or brand; jpeg, png or webp, sides of 300 to 6000 px, under 30 MB.";

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2.
        let mac = hmac(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: a key longer than the block is hashed first.
        let mac = hmac(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(hex(&mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn signature_has_the_documented_shape() {
        let (auth, date, payload) = sign("AKLTtest", "secret", "GetAsset", b"{}", 1_774_656_000);
        assert_eq!(date, "20260328T000000Z");
        assert_eq!(payload, sha256_hex(b"{}"));
        assert!(auth.starts_with("HMAC-SHA256 Credential=AKLTtest/20260328/ap-southeast-1/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature="));
        // Deterministic for the same input, different for another action.
        assert_eq!(auth, sign("AKLTtest", "secret", "GetAsset", b"{}", 1_774_656_000).0);
        assert_ne!(auth, sign("AKLTtest", "secret", "CreateAsset", b"{}", 1_774_656_000).0);
    }

    #[test]
    fn frames_and_references_are_not_mixed() {
        let p = params(&[]);
        let err = seedance_body(SeedanceInput { prompt: "x", start: Some("data:a".into()), end: None, refs: vec!["asset://a".into()], params: &p });
        assert!(matches!(err, Err(AppError::Invalid(_))));
        let err = seedance_body(SeedanceInput { prompt: "x", start: None, end: Some("data:b".into()), refs: vec![], params: &p });
        assert!(matches!(err, Err(AppError::Invalid(_))));
    }

    #[test]
    fn draft_is_480p_and_references_keep_their_order() {
        let p = params(&[("duration", "5"), ("ratio", "9:16")]);
        let refs = vec!["asset://asset-1".to_owned(), "https://x/2.png".to_owned()];
        let body = seedance_body(SeedanceInput { prompt: "The woman in Image 1", start: None, end: None, refs, params: &p }).unwrap();
        assert_eq!(body["model"], SEEDANCE_25);
        assert_eq!(body["draft"], true);
        assert_eq!(body["resolution"], "480p");
        assert_eq!(body["ratio"], "9:16");
        assert_eq!(body["duration"], 5);
        assert_eq!(body["content"][1]["image_url"]["url"], "asset://asset-1");
        assert_eq!(body["content"][1]["role"], "reference_image");
        assert_eq!(body["content"][2]["image_url"]["url"], "https://x/2.png");
    }

    #[test]
    fn first_frame_forces_adaptive_and_full_render_keeps_resolution() {
        let p = params(&[("draft", "false"), ("resolution", "1080p"), ("ratio", "16:9"), ("duration", "99")]);
        let body = seedance_body(SeedanceInput { prompt: "", start: Some("data:a".into()), end: Some("data:b".into()), refs: vec![], params: &p }).unwrap();
        assert!(body.get("draft").is_none());
        assert_eq!(body["resolution"], "1080p");
        assert_eq!(body["ratio"], "adaptive");
        assert_eq!(body["duration"], 5, "out of range falls back to 5 s");
        assert_eq!(body["content"][0]["role"], "first_frame");
        assert_eq!(body["content"][1]["role"], "last_frame");
    }

    #[test]
    fn finalizing_sends_only_the_draft_and_1080p() {
        let body = finalize_body("cgt-123");
        assert_eq!(body["resolution"], "1080p");
        assert_eq!(body["content"][0]["draft_task"]["id"], "cgt-123");
        for reused in ["duration", "ratio", "seed", "generate_audio", "draft"] {
            assert!(body.get(reused).is_none(), "{reused} must not be sent again");
        }
    }

    #[test]
    fn face_errors_are_explained() {
        assert_eq!(explain(None, "InputImageSensitiveContentDetected", "may contain real person"), FACE_REFUSED);
        assert!(explain(Some(StatusCode::TOO_MANY_REQUESTS), "", "").contains("QPM"));
    }
}
