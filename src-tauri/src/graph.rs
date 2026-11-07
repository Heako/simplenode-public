//! Graph execution: topological order, cached outputs, failure propagation.
//! Progress is streamed to the UI as `node-status` events. Several runs can go
//! at once; a node two of them need is executed once and shared.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use futures::future::try_join_all;
use futures::stream::{FuturesUnordered, StreamExt};
use tokio::sync::watch;

use crate::angles;
use crate::byteplus::{self, BytePlus};
use crate::error::{AppError, Result};
use crate::fal::{Fal, ModelCall};
use crate::models::{self, Category, MediaKind};
use crate::{account, compose, motion, recast, wavespeed};
use crate::storage::{self, CropSpec, View};

pub type Ports = HashMap<String, String>;

/// Outcome of a node execution, as seen by runs waiting for it.
type Outcome = Option<std::result::Result<Ports, String>>;

/// Nodes being executed by any run, keyed by id. A run that reaches one of
/// them waits for that result instead of executing (and paying for) it again.
fn in_flight() -> &'static Mutex<HashMap<String, watch::Receiver<Outcome>>> {
    static IN_FLIGHT: OnceLock<Mutex<HashMap<String, watch::Receiver<Outcome>>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(Default::default)
}

/// Stop signals of the nodes being executed, keyed by id.
fn stops() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static STOPS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    STOPS.get_or_init(Default::default)
}

/// Stops the given nodes, or every executing one. Their fal requests are
/// cancelled; what they had already produced is kept.
pub fn stop(ids: Option<&[String]>) {
    for (id, tx) in stops().lock().unwrap().iter() {
        if ids.map_or(true, |ids| ids.contains(id)) {
            tx.send_replace(true);
        }
    }
}

/// Frees a node's in-flight slot and stop signal however its execution ends.
struct Claim(String);

impl Drop for Claim {
    fn drop(&mut self) {
        in_flight().lock().unwrap().remove(&self.0);
        stops().lock().unwrap().remove(&self.0);
    }
}
/// Input ports can take several edges (e.g. multiple reference images).
type Inputs = HashMap<String, Vec<String>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub params: Ports,
    pub outputs: Ports,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub source_handle: String,
    pub target: String,
    pub target_handle: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeEvent<'a> {
    id: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    outputs: Option<&'a Ports>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Set on an error raised before any provider billed a generation, so a
    /// cost counted against the MCP budget can be given back.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    unbilled: bool,
}

/// Nodes that call fal or BytePlus (and cost money) are not re-run when their output is cached.
fn is_remote(kind: &str) -> bool {
    matches!(
        kind,
        "model" | "enhancer" | "describer" | "videoDescriber" | "motionPrompt" | "angles" | "recast" | "addAudio" | "upscale" | "upscaleImage" | "voice" | "avatar" | "bpPortrait" | "bpSeedance" | "bpSeedream"
    )
}

/// Several connected prompts are joined; the inline field is the fallback.
fn prompt_text(node: &GraphNode, inputs: &Inputs) -> String {
    match inputs.get("prompt").filter(|v| !v.is_empty()) {
        Some(texts) => texts.join("\n\n"),
        None => param(node, "prompt").to_owned(),
    }
}

fn unix_ms() -> String {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string()
}

/// Upstream node ids of `id`, including `id` itself.
fn ancestors(id: &str, edges: &[GraphEdge]) -> HashSet<String> {
    let mut seen = HashSet::from([id.to_owned()]);
    let mut stack = vec![id.to_owned()];
    while let Some(cur) = stack.pop() {
        for e in edges.iter().filter(|e| e.target == cur) {
            if seen.insert(e.source.clone()) {
                stack.push(e.source.clone());
            }
        }
    }
    seen
}

/// Kahn's algorithm restricted to `subset`. Nodes caught in a cycle are dropped.
fn topo_sort(nodes: &[GraphNode], subset: &HashSet<String>, edges: &[GraphEdge]) -> Vec<String> {
    let local: Vec<_> = edges.iter().filter(|e| subset.contains(&e.source) && subset.contains(&e.target)).collect();
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    for e in &local {
        *indegree.entry(e.target.as_str()).or_default() += 1;
    }
    // Seed in canvas order so independent nodes run predictably.
    let mut queue: VecDeque<&str> = nodes
        .iter()
        .map(|n| n.id.as_str())
        .filter(|id| subset.contains(*id) && !indegree.contains_key(id))
        .collect();
    let mut order = Vec::new();
    while let Some(id) = queue.pop_front() {
        order.push(id.to_owned());
        for e in local.iter().filter(|e| e.source == id) {
            let d = indegree.get_mut(e.target.as_str()).unwrap();
            *d -= 1;
            if *d == 0 {
                queue.push_back(&e.target);
            }
        }
    }
    order
}

fn param<'a>(node: &'a GraphNode, key: &str) -> &'a str {
    node.params.get(key).map(String::as_str).unwrap_or_default()
}

fn first<'a>(inputs: &'a Inputs, key: &str) -> Option<&'a str> {
    inputs.get(key).and_then(|v| v.first()).map(String::as_str)
}

/// A connected text input wins over the node's inline field.
fn text_or_param(node: &GraphNode, inputs: &Inputs, input: &str, param_key: &str) -> Result<String> {
    let text = match inputs.get(input).filter(|v| !v.is_empty()) {
        Some(texts) => texts.join("\n\n"),
        None => param(node, param_key).to_owned(),
    };
    if text.trim().is_empty() {
        return Err(AppError::Invalid("Missing input text".into()));
    }
    Ok(text)
}

fn require<'a>(inputs: &'a Inputs, key: &str, what: &str) -> Result<&'a str> {
    first(inputs, key).ok_or_else(|| AppError::Invalid(format!("Connect {what}")))
}

const ENHANCER_SYSTEM: &str = "You rewrite prompts for image generation models. Expand the user's idea into one rich, \
precise prompt: subject, composition, lighting, lens or medium, color palette, mood, style references. Keep every \
element the user asked for and invent nothing that contradicts it. Answer with the prompt only, no preamble, in the \
user's language.";

const DESCRIBER_SYSTEM: &str = "You describe images so they can be recreated by an image generation model. Cover subject, \
composition, framing, lighting, colors, materials, style and mood. Answer with the description only, no preamble, in \
English.";

/// Names declared on a Prompt node, comma-separated in `params.vars`.
fn declared_vars(node: &GraphNode) -> Vec<&str> {
    param(node, "vars").split(',').map(str::trim).filter(|v| !v.is_empty()).collect()
}

/// Replaces `{name}` for each declared variable with the value wired into its
/// `var:name` port (empty when unwired). Unknown `{…}` stays as typed.
/// Mirrors `fillTemplate` in src/lib/live.ts.
fn fill_template(text: &str, vars: &[&str], inputs: &Inputs) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}') {
            Some(close) if vars.contains(&&after[..close]) => {
                let name = &after[..close];
                out.push_str(first(inputs, &format!("var:{name}")).unwrap_or_default());
                rest = &after[close + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The List node's selected item. Items are a JSON array in `params.items`.
fn selected_item(node: &GraphNode) -> String {
    let items: Vec<String> = serde_json::from_str(param(node, "items")).unwrap_or_default();
    let index: usize = param(node, "selected").parse().unwrap_or(0);
    items.get(index).cloned().unwrap_or_default()
}

fn llm_params(node: &GraphNode) -> Ports {
    Ports::from([("model".to_owned(), param(node, "model").to_owned())])
}

/// The Video → Prompt LLM call, on the user's provider.
async fn describe_sheets(app: &AppHandle, http: &reqwest::Client, fal: &Fal, on_wavespeed: bool, sheets: &compose::Sheets, ask: &str) -> Result<String> {
    if on_wavespeed {
        let ws = wavespeed::WaveSpeed::from_account(http)?;
        let images = try_join_all(sheets.paths.iter().map(|p| ws.upload(p))).await?;
        let input = serde_json::json!({
            "prompt": ask,
            "system_prompt": motion::SYSTEM,
            "images": images,
            "model": motion::WAVESPEED_MODEL,
            "max_tokens": 4000,
        });
        let serde_json::Value::Object(input) = input else { unreachable!() };
        return ws.run(motion::WAVESPEED_ENDPOINT, input).await;
    }
    let refs = sheets.paths.iter().map(|p| storage::to_model_input(app, &p.to_string_lossy())).collect::<Result<Vec<_>>>()?;
    let def = models::find("llm").expect("llm model is registered");
    let params = Ports::from([("model".to_owned(), motion::FAL_MODEL.to_owned())]);
    Ok(fal.run_model(def, &params, ModelCall { system: motion::SYSTEM, refs: &refs, ..ModelCall::new(ask) }).await?.value)
}

/// The Upscale node's resolution, as both providers spell it; 1080p by default.
pub fn upscale_resolution(value: &str) -> &'static str {
    match value {
        "2k" => "2k",
        "4k" => "4k",
        _ => "1080p",
    }
}

/// A Crop node's crop, from its params: also used live, outside a run.
pub fn crop_spec(params: &Ports) -> Result<CropSpec> {
    let param = |k: &str| params.get(k).map(String::as_str).unwrap_or_default();
    let num = |k: &str, default: f64| param(k).parse::<f64>().unwrap_or(default);
    // A box framed by hand, whatever its ratio; older nodes only have a ratio.
    if param("box") == "1" {
        return Ok(CropSpec::Percent { x: num("x", 0.0), y: num("y", 0.0), w: num("w", 100.0), h: num("h", 100.0) });
    }
    match param("aspect") {
        "" | "free" => Ok(CropSpec::Percent { x: num("x", 0.0), y: num("y", 0.0), w: num("w", 100.0), h: num("h", 100.0) }),
        ratio => {
            let (a, b) = ratio.split_once(':').ok_or_else(|| AppError::Invalid(format!("Invalid ratio: {ratio}")))?;
            let (a, b): (f64, f64) = (a.parse().unwrap_or(1.0), b.parse().unwrap_or(1.0));
            Ok(CropSpec::Aspect(a / b))
        }
    }
}

/// One segment's render, tagged with its index (segments finish in any order).
/// Joins a recast's segments, in order, once every one is ready, so the
/// Preview node always shows the whole video. None while one is missing: it
/// is to be redone first. The segments stay on the node either way.
async fn assemble(app: &AppHandle, fal: &Fal, http: &reqwest::Client, node: &GraphNode, pieces: &[recast::Piece]) -> Result<Option<String>> {
    if pieces.iter().any(|p| p.video.is_empty()) {
        return Ok(None);
    }
    // Shown while the merge runs, and kept if it fails.
    let partial = Ports::from([("pieces".to_owned(), recast::encode_pieces(pieces))]);
    app.emit("node-status", NodeEvent { id: &node.id, status: "running", outputs: Some(&partial), error: None, unbilled: false })?;
    let uploads = pieces.iter().map(|p| async { fal.upload(&storage::owned_path(app, &p.video)?).await });
    let urls = try_join_all(uploads).await?;
    let url = fal.merge_videos(&urls).await?;
    Ok(Some(storage::download(app, http, &url).await?.to_string_lossy().into_owned()))
}

async fn render_piece(job: &recast::Job<'_>, index: usize, url: &str) -> (usize, Result<String>) {
    (index, job.render(url).await)
}

/// A registry model run on WaveSpeed: same inputs as on fal, sent the way
/// WaveSpeed's schema of the model expects them.
async fn run_on_wavespeed(
    app: &AppHandle,
    http: &reqwest::Client,
    node: &GraphNode,
    inputs: &Inputs,
    def: &models::ModelDef,
    map: &wavespeed::Mapping,
    prompt: &str,
) -> Result<Ports> {
    let wired_media = |key: &str| inputs.get(&format!("media:{key}")).filter(|v| !v.is_empty());
    if def.media.iter().any(|m| wired_media(m.key).is_some() && !map.media.iter().any(|(k, _, _)| *k == m.key)) {
        return Err(AppError::Invalid(format!("{} on WaveSpeed only takes images: unplug its video or audio inputs, or run it on fal", def.label)));
    }
    let ws = wavespeed::WaveSpeed::from_account(http)?;
    // Local files go up to WaveSpeed's storage; URLs pass as they are.
    let host = |value: &str| {
        let value = value.to_owned();
        let ws = &ws;
        async move {
            if value.starts_with("http") {
                Ok(value)
            } else {
                ws.upload(&storage::owned_path(app, &value)?).await
            }
        }
    };
    let numbered = (1..=def.max_refs).filter_map(|i| first(inputs, &format!("ref{i}")));
    let wired: Vec<&str> = inputs.get("refs").into_iter().flatten().map(String::as_str).chain(numbered).collect();
    let mut refs = Vec::with_capacity(wired.len());
    for value in wired {
        refs.push(host(value).await?);
    }
    let end_frame = match first(inputs, "endFrame") {
        Some(frame) => Some(host(frame).await?),
        None => None,
    };
    let negative = match inputs.get("negative").filter(|v| !v.is_empty()) {
        Some(texts) => texts.join(", "),
        None => param(node, "negative").to_owned(),
    };
    let mut media = Vec::new();
    for (key, field, many) in map.media {
        let Some(values) = wired_media(key) else { continue };
        let mut urls = Vec::with_capacity(values.len());
        for value in values {
            urls.push(host(value).await?);
        }
        media.push((*field, if *many { serde_json::json!(urls) } else { serde_json::json!(urls[0]) }));
    }
    let model = map.endpoint(def.label, !refs.is_empty())?;
    let schema = ws.schema(model).await?;
    let call = wavespeed::Call { prompt, negative: &negative, refs: &refs, end_frame, media };
    let input = wavespeed::build_input(&schema, map, def.label, &node.params, &call)?;
    let url = ws.run(model, input).await?;
    let port = match def.category {
        Category::Image => "image",
        Category::Video => "video",
        Category::Audio => "audio",
        Category::Llm => return Err(AppError::Invalid("LLMs only run on fal".into())),
    };
    let path = storage::download(app, http, &url).await?;
    Ok(Ports::from([(port.to_owned(), path.to_string_lossy().into_owned())]))
}

/// With WaveSpeed as the provider, nothing goes to fal: these nodes need it.
const FAL_ONLY: &[(&str, &str)] =
    &[("enhancer", "Prompt Enhancer"), ("describer", "Image Describer"), ("videoDescriber", "Video Describer"), ("angles", "Camera angles")];

fn fal_only(what: &str) -> AppError {
    AppError::Invalid(format!("{what} runs on fal.ai only: switch Provider to fal.ai in Settings to use it"))
}

/// One WaveSpeed Recast segment: uploaded, rendered, its result's URL.
async fn render_ws_piece(ws: &wavespeed::WaveSpeed, render: &WsRecast<'_>, index: usize, source: PathBuf) -> (usize, Result<String>) {
    let result = async {
        let video = ws.upload(&source).await?;
        ws.run(render.model.ws, wavespeed::recast_input(render.schema, render.model, render.params, render.prompt, render.image, &video)).await
    };
    (index, result.await)
}

/// What every segment of a WaveSpeed Recast shares.
struct WsRecast<'a> {
    model: &'static wavespeed::RecastModel,
    schema: &'a serde_json::Value,
    params: &'a HashMap<String, String>,
    prompt: &'a str,
    /// The character, hosted.
    image: &'a str,
}

/// A local copy of a node value: its own path, or a download of its URL.
async fn local_media(app: &AppHandle, http: &reqwest::Client, value: &str) -> Result<PathBuf> {
    if value.starts_with("http") {
        storage::download(app, http, value).await
    } else {
        storage::owned_path(app, value)
    }
}

/// Recast with WaveSpeed as the provider. Segments are cut and joined here,
/// with ffmpeg, instead of fal's tools: nothing goes to fal.
async fn recast_on_wavespeed(app: &AppHandle, http: &reqwest::Client, node: &GraphNode, inputs: &Inputs, def: &models::ModelDef) -> Result<Ports> {
    let model = wavespeed::recast(def.id).ok_or_else(|| fal_only(def.label))?;
    let characters = inputs.get("characters").map(Vec::as_slice).unwrap_or_default();
    match characters.len() {
        0 => return Err(AppError::Invalid("Connect a character image".into())),
        1 => {}
        _ => return Err(AppError::Invalid(format!("{} takes a single character", def.label))),
    }
    let ws = wavespeed::WaveSpeed::from_account(http)?;
    let image = if characters[0].starts_with("http") {
        characters[0].clone()
    } else {
        ws.upload(&storage::owned_path(app, &characters[0])?).await?
    };
    let prompt = match inputs.get("prompt").filter(|v| !v.is_empty()) {
        Some(texts) => texts.join("\n\n"),
        None => param(node, "prompt").to_owned(),
    };
    let redo = param(node, "redo").parse::<usize>().ok();
    let mut params = node.params.clone();
    if redo.is_none() && param(node, "x:seed").trim().is_empty() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
        params.insert("x:seed".into(), (nanos % 1_000_000).to_string());
    }
    let schema = ws.schema(model.ws).await?;
    let job = WsRecast { model, schema: &schema, params: &params, prompt: &prompt, image: &image };
    let mut out = Ports::new();
    // Joined here once every segment is ready.
    let join = |pieces: Vec<recast::Piece>| async move {
        if pieces.iter().any(|p| p.video.is_empty()) {
            return Ok::<_, AppError>((pieces, None));
        }
        let parts: Vec<PathBuf> = pieces.iter().map(|p| PathBuf::from(&p.video)).collect();
        let video = compose::concat(app, &parts).await?;
        Ok((pieces, Some(video.to_string_lossy().into_owned())))
    };

    if param(node, "redo") == "join" {
        let pieces = recast::decode_pieces(node.outputs.get("pieces").map(String::as_str).unwrap_or_default())?;
        let (pieces, video) = join(pieces).await?;
        out.insert("pieces".into(), recast::encode_pieces(&pieces));
        out.insert("video".into(), video.ok_or_else(|| AppError::Invalid("Redo the failed segments first".into()))?);
        return Ok(out);
    }
    if let Some(index) = redo {
        let mut pieces = recast::decode_pieces(node.outputs.get("pieces").map(String::as_str).unwrap_or_default())?;
        let piece = pieces.get_mut(index).ok_or_else(|| AppError::Invalid(format!("Segment {} not found", index + 1)))?;
        let (_, url) = render_ws_piece(&ws, &job, index, storage::owned_path(app, &piece.source)?).await;
        piece.video = storage::download(app, http, &url?).await?.to_string_lossy().into_owned();
        piece.error.clear();
        let (pieces, video) = join(pieces).await?;
        out.insert("pieces".into(), recast::encode_pieces(&pieces));
        if let Some(video) = video {
            out.insert("video".into(), video);
        }
        return Ok(out);
    }

    let source = local_media(app, http, require(inputs, "video", "a source video")?).await?;
    let duration = compose::duration(&source).await?;
    let cuts = recast::cuts(def, &params, duration);
    if cuts.len() == 1 {
        let (_, url) = render_ws_piece(&ws, &job, 0, source).await;
        out.insert("video".into(), storage::download(app, http, &url?).await?.to_string_lossy().into_owned());
        return Ok(out);
    }
    let mut pieces = Vec::with_capacity(cuts.len());
    for &(start, len) in &cuts {
        let part = compose::trim(app, &source, start, len).await?;
        pieces.push(recast::Piece { source: part.to_string_lossy().into_owned(), ..Default::default() });
    }
    // Four at a time, as on fal; each segment shows up as it lands.
    let sources: Vec<PathBuf> = pieces.iter().map(|p| PathBuf::from(&p.source)).collect();
    let mut queue = sources.into_iter().enumerate();
    let mut renders = FuturesUnordered::new();
    for (i, path) in queue.by_ref().take(4) {
        renders.push(render_ws_piece(&ws, &job, i, path));
    }
    while let Some((i, result)) = renders.next().await {
        if let Some((next, path)) = queue.next() {
            renders.push(render_ws_piece(&ws, &job, next, path));
        }
        match result {
            Ok(url) => match storage::download(app, http, &url).await {
                Ok(path) => pieces[i].video = path.to_string_lossy().into_owned(),
                Err(err) => pieces[i].error = err.to_string(),
            },
            Err(err) => pieces[i].error = err.to_string(),
        }
        let partial = Ports::from([("pieces".to_owned(), recast::encode_pieces(&pieces))]);
        app.emit("node-status", NodeEvent { id: &node.id, status: "running", outputs: Some(&partial), error: None, unbilled: false })?;
    }
    let (pieces, video) = join(pieces).await?;
    out.insert("pieces".into(), recast::encode_pieces(&pieces));
    if let Some(video) = video {
        out.insert("video".into(), video);
    }
    Ok(out)
}

async fn execute(app: &AppHandle, fal: &Fal, http: &reqwest::Client, node: &GraphNode, inputs: &Inputs) -> Result<Ports> {
    let mut out = Ports::new();
    let on_wavespeed = account::provider()? == account::Provider::WaveSpeed;
    if on_wavespeed {
        if let Some((_, what)) = FAL_ONLY.iter().find(|(kind, _)| *kind == node.kind) {
            return Err(fal_only(what));
        }
    }
    match node.kind.as_str() {
        "prompt" => {
            out.insert("text".into(), fill_template(param(node, "text"), &declared_vars(node), inputs));
        }
        "list" => {
            out.insert("text".into(), selected_item(node));
        }
        "image" => {
            let path = param(node, "path");
            if path.is_empty() {
                return Err(AppError::Invalid("No file imported".into()));
            }
            let port = if param(node, "media") == "video" { "video" } else { "image" };
            out.insert(port.into(), path.to_owned());
        }
        "preview" | "router" => {
            if let Some(v) = first(inputs, "value") {
                out.insert("value".into(), v.to_owned());
            }
        }
        "concat" => {
            let separator = match param(node, "separator") {
                "space" => " ",
                "comma" => ", ",
                _ => "\n",
            };
            let parts = inputs.get("texts").map(Vec::as_slice).unwrap_or_default();
            let text = parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(separator);
            out.insert("text".into(), text);
        }
        "frame" => {
            let source = require(inputs, "video", "a video")?;
            let at = param(node, "time").parse::<f64>().unwrap_or(0.0);
            let path = compose::frame(app, source, at).await?;
            out.insert("image".into(), path.to_string_lossy().into_owned());
        }
        "crop" => {
            let source = require(inputs, "image", "an image")?;
            let path = storage::crop(app, source, &crop_spec(&node.params)?)?;
            out.insert("image".into(), path.to_string_lossy().into_owned());
        }
        "angles" => {
            let reference = storage::to_model_input(app, require(inputs, "image", "a reference image")?)?;
            let context = first(inputs, "context").unwrap_or_default();
            let def = models::find(param(node, "modelId"))
                .filter(|m| m.category == Category::Image && m.edit_endpoint.is_some())
                .ok_or_else(|| AppError::Invalid("Choose an image model that takes a reference".into()))?;
            let (cols, rows) = angles::layout(param(node, "layout")).ok_or_else(|| AppError::Invalid("Unknown layout".into()))?;
            let ids: Vec<String> = serde_json::from_str(param(node, "shots")).unwrap_or_default();
            let shots = ids
                .iter()
                .take((cols * rows) as usize)
                .map(|id| angles::shot(id).ok_or_else(|| AppError::Invalid(format!("Unknown shot: {id}"))))
                .collect::<Result<Vec<_>>>()?;
            if shots.len() != (cols * rows) as usize {
                return Err(AppError::Invalid(format!("Choose {} shots", cols * rows)));
            }
            let panel = match param(node, "panel") {
                "1:1" => 1.0,
                "9:16" => 9.0 / 16.0,
                "4:3" => 4.0 / 3.0,
                _ => 16.0 / 9.0,
            };
            let resolution = match param(node, "resolution") {
                "" => "2K",
                r => r,
            };

            if param(node, "mode") == "separate" {
                let params = angles::call_params(def, panel, resolution);
                let prompts: Vec<String> = shots.iter().map(|shot| angles::single_prompt(shot, context)).collect();
                // Four calls at a time: much faster than one by one, gentle on fal's queue.
                let mut urls = Vec::with_capacity(prompts.len());
                for batch in prompts.chunks(4) {
                    let calls = batch.iter().map(|prompt| fal.run_model(def, &params, ModelCall { refs: std::slice::from_ref(&reference), ..ModelCall::new(prompt) }));
                    urls.extend(try_join_all(calls).await?.into_iter().map(|o| o.value));
                }
                let mut views = Vec::with_capacity(urls.len());
                for (url, shot) in urls.iter().zip(&shots) {
                    let path = storage::download(app, http, url).await?;
                    views.push(View { path: path.to_string_lossy().into_owned(), label: shot.label.to_owned() });
                }
                out.insert("views".into(), storage::encode_views(&views));
            } else {
                let params = angles::call_params(def, f64::from(cols) * panel / f64::from(rows), resolution);
                let prompt = angles::sheet_prompt(&shots, cols, rows, param(node, "labels") == "true", context);
                let url = fal.run_model(def, &params, ModelCall { refs: std::slice::from_ref(&reference), ..ModelCall::new(&prompt) }).await?.value;
                let sheet = storage::download(app, http, &url).await?;
                let sheet = sheet.to_string_lossy().into_owned();
                let inset = param(node, "inset").parse::<f64>().unwrap_or(0.0);
                let tiles = storage::grid_crop(app, &sheet, rows, cols, inset)?;
                let views: Vec<View> = tiles
                    .iter()
                    .zip(&shots)
                    .map(|(path, shot)| View { path: path.to_string_lossy().into_owned(), label: shot.label.to_owned() })
                    .collect();
                out.insert("views".into(), storage::encode_views(&views));
                // Not a port: kept for the node's own display and the project thumbnail.
                out.insert("sheet".into(), sheet);
            }
        }
        "gridCrop" => {
            let source = require(inputs, "image", "an image")?;
            let num = |k: &str| param(node, k).parse::<u32>().unwrap_or(2);
            let inset = param(node, "inset").parse::<f64>().unwrap_or(0.0);
            let tiles = storage::grid_crop(app, source, num("rows"), num("cols"), inset)?;
            let views: Vec<View> = tiles
                .iter()
                .enumerate()
                .map(|(i, path)| View { path: path.to_string_lossy().into_owned(), label: format!("View {}", i + 1) })
                .collect();
            out.insert("views".into(), storage::encode_views(&views));
        }
        "anglePick" => {
            let views = storage::decode_views(require(inputs, "views", "a set of shots")?)?;
            let index: usize = param(node, "selected").parse().unwrap_or(0);
            let view = views.get(index).or(views.first()).ok_or_else(|| AppError::Invalid("No shot received".into()))?;
            out.insert("image".into(), view.path.clone());
        }
        "angleExport" => {
            let views = storage::decode_views(require(inputs, "views", "a set of shots")?)?;
            let count = storage::export_views(app, &views, param(node, "folder"))?;
            out.insert("summary".into(), format!("{count} files exported"));
        }
        "enhancer" => {
            let prompt = text_or_param(node, inputs, "text", "text")?;
            let def = models::find("llm").expect("llm model is registered");
            let text = fal.run_model(def, &llm_params(node), ModelCall { system: ENHANCER_SYSTEM, ..ModelCall::new(&prompt) }).await?.value;
            out.insert("text".into(), text);
        }
        "describer" => {
            let image = storage::to_model_input(app, require(inputs, "image", "an image")?)?;
            let def = models::find("llm").expect("llm model is registered");
            let ask = if param(node, "detail") == "short" {
                "Describe this image in one or two sentences."
            } else {
                "Describe this image in detail."
            };
            let text = fal.run_model(def, &llm_params(node), ModelCall { system: DESCRIBER_SYSTEM, refs: std::slice::from_ref(&image), ..ModelCall::new(ask) })
                .await?
                .value;
            out.insert("text".into(), text);
        }
        "motionPrompt" => {
            let sheets = compose::contact_sheets(app, require(inputs, "video", "a video")?).await?;
            let notes = match inputs.get("notes").filter(|v| !v.is_empty()) {
                Some(texts) => texts.join("\n"),
                None => param(node, "notes").to_owned(),
            };
            let ask = motion::request(&sheets, &notes, param(node, "outfit") == "video");
            let text = describe_sheets(app, http, fal, on_wavespeed, &sheets, &ask).await;
            // The sheets were only for the LLM.
            for p in &sheets.paths {
                let _ = std::fs::remove_file(p);
            }
            out.insert("text".into(), text?.trim().to_owned());
        }
        "videoDescriber" => {
            let video = storage::owned_path(app, require(inputs, "video", "a video")?)?;
            let url = fal.upload(&video).await?;
            let question = match param(node, "question").trim() {
                "" => "Describe this video: subjects, actions, camera moves, lighting, style and mood.",
                q => q,
            };
            let text = fal.describe_video(&url, question, param(node, "detailed") == "true").await?;
            out.insert("text".into(), text);
        }
        "recast" => {
            let def = recast::model(param(node, "mode"), param(node, "modelId"))
                .ok_or_else(|| AppError::Invalid("Choose a model of this mode".into()))?;
            if on_wavespeed {
                return recast_on_wavespeed(app, http, node, inputs, def).await;
            }
            let characters = inputs.get("characters").map(Vec::as_slice).unwrap_or_default();
            if characters.is_empty() {
                return Err(AppError::Invalid("Connect at least one character image".into()));
            }
            // Refused rather than silently dropped: the extra person would just be missing.
            if characters.len() > def.max_refs as usize {
                let most = if def.max_refs == 1 { "a single character".to_owned() } else { format!("{} characters at most", def.max_refs) };
                return Err(AppError::Invalid(format!("{} takes {most}", def.label)));
            }
            let refs = characters.iter().map(|c| storage::to_model_input(app, c)).collect::<Result<Vec<_>>>()?;
            // Optional here: who becomes whom, what to keep or change.
            let prompt = match inputs.get("prompt").filter(|v| !v.is_empty()) {
                Some(texts) => texts.join("\n\n"),
                None => param(node, "prompt").to_owned(),
            };
            let redo = param(node, "redo").parse::<usize>().ok();
            // One seed for every segment of a run, so they render alike; a
            // redo draws a new one, or it would give the same result again.
            // Sent only where the endpoint's schema has a seed.
            let mut params = node.params.clone();
            if redo.is_none() && param(node, "x:seed").trim().is_empty() {
                let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
                params.insert("x:seed".into(), (nanos % 1_000_000).to_string());
            }
            let job = recast::Job { fal, def, params: &params, refs: &refs, prompt: &prompt };

            // Join the previous run's segments only: for those left unjoined,
            // after a failed merge or by an older version of the app.
            if param(node, "redo") == "join" {
                let pieces = recast::decode_pieces(node.outputs.get("pieces").map(String::as_str).unwrap_or_default())?;
                let video = assemble(app, fal, http, node, &pieces)
                    .await?
                    .ok_or_else(|| AppError::Invalid("Redo the failed segments first".into()))?;
                out.insert("pieces".into(), recast::encode_pieces(&pieces));
                out.insert("video".into(), video);
                return Ok(out);
            }

            // Redo one segment of the previous run; the others are kept.
            if let Some(index) = redo {
                let mut pieces = recast::decode_pieces(node.outputs.get("pieces").map(String::as_str).unwrap_or_default())?;
                let piece = pieces.get_mut(index).ok_or_else(|| AppError::Invalid(format!("Segment {} not found", index + 1)))?;
                let url = job.render(&fal.upload(&storage::owned_path(app, &piece.source)?).await?).await?;
                piece.video = storage::download(app, http, &url).await?.to_string_lossy().into_owned();
                piece.error.clear();
                out.insert("pieces".into(), recast::encode_pieces(&pieces));
                if let Some(video) = assemble(app, fal, http, node, &pieces).await? {
                    out.insert("video".into(), video);
                }
                return Ok(out);
            }

            let video = require(inputs, "video", "a source video")?;
            let (video_url, duration) = if video.starts_with("http") {
                (video.to_owned(), None)
            } else {
                let path = storage::owned_path(app, video)?;
                (fal.upload(&path).await?, storage::video_duration(&path))
            };
            match job.plan(&video_url, duration).await? {
                recast::Plan::Whole(url) => {
                    let path = storage::download(app, http, &url).await?;
                    out.insert("video".into(), path.to_string_lossy().into_owned());
                }
                recast::Plan::Pieces(urls) => {
                    // Local copies of the source segments, so one can be redone later.
                    let mut pieces = Vec::with_capacity(urls.len());
                    for url in &urls {
                        let source = storage::download(app, http, url).await?;
                        pieces.push(recast::Piece { source: source.to_string_lossy().into_owned(), ..Default::default() });
                    }
                    // Four calls at a time, as for camera angles. Each segment shows
                    // up as it lands; a failed one doesn't lose the others.
                    let mut queue = urls.iter().enumerate();
                    let mut renders = FuturesUnordered::new();
                    for (i, url) in queue.by_ref().take(4) {
                        renders.push(render_piece(&job, i, url));
                    }
                    while let Some((i, result)) = renders.next().await {
                        if let Some((next, url)) = queue.next() {
                            renders.push(render_piece(&job, next, url));
                        }
                        match result {
                            Ok(url) => match storage::download(app, http, &url).await {
                                Ok(path) => pieces[i].video = path.to_string_lossy().into_owned(),
                                Err(err) => pieces[i].error = err.to_string(),
                            },
                            Err(err) => pieces[i].error = err.to_string(),
                        }
                        let partial = Ports::from([("pieces".to_owned(), recast::encode_pieces(&pieces))]);
                        app.emit("node-status", NodeEvent { id: &node.id, status: "running", outputs: Some(&partial), error: None, unbilled: false })?;
                    }
                    out.insert("pieces".into(), recast::encode_pieces(&pieces));
                    if let Some(video) = assemble(app, fal, http, node, &pieces).await? {
                        out.insert("video".into(), video);
                    }
                }
            }
        }
        "model" => {
            let def = models::find(param(node, "modelId"))
                .ok_or_else(|| AppError::Invalid(format!("Unknown model: {}", param(node, "modelId"))))?;
            // Several connected prompts are joined; the inline field is the fallback.
            let prompt = match inputs.get("prompt").filter(|v| !v.is_empty()) {
                Some(texts) => texts.join("\n\n"),
                None => param(node, "prompt").to_owned(),
            };
            if prompt.trim().is_empty() {
                return Err(AppError::Invalid("Missing prompt".into()));
            }
            if on_wavespeed {
                return match wavespeed::mapping(def.id) {
                    Some(map) => run_on_wavespeed(app, http, node, inputs, def, map, &prompt).await,
                    None => Err(fal_only(def.label)),
                };
            }
            // Numbered inputs (Image 1, Image 2…) in their order; `refs`
            // for single-reference models and projects saved before.
            let numbered = (1..=def.max_refs).filter_map(|i| first(inputs, &format!("ref{i}")));
            let refs = inputs
                .get("refs")
                .into_iter()
                .flatten()
                .map(String::as_str)
                .chain(numbered)
                .map(|r| storage::to_model_input(app, r))
                .collect::<Result<Vec<_>>>()?;
            let system = if def.category == Category::Llm { param(node, "system") } else { "" };

            let end_frame = first(inputs, "endFrame").map(|f| storage::to_model_input(app, f)).transpose()?;
            let negative = match inputs.get("negative").filter(|v| !v.is_empty()) {
                Some(texts) => texts.join(", "),
                None => param(node, "negative").to_owned(),
            };
            // Extra media ports: images inline as data URIs, video and audio
            // uploaded to fal storage (too large to inline).
            let mut media = Vec::new();
            for input in def.media {
                let Some(values) = inputs.get(&format!("media:{}", input.key)).filter(|v| !v.is_empty()) else { continue };
                let mut urls = Vec::with_capacity(values.len());
                for v in values {
                    urls.push(match input.kind {
                        MediaKind::Image => storage::to_model_input(app, v)?,
                        _ if v.starts_with("http") => v.clone(),
                        _ => fal.upload(&storage::owned_path(app, v)?).await?,
                    });
                }
                let value = if input.multiple { serde_json::json!(urls) } else { serde_json::json!(urls[0]) };
                media.push((input.key, input.mode, value));
            }
            let call = ModelCall { prompt: &prompt, system, refs: &refs, end_frame, negative: &negative, media };
            let result = fal.run_model(def, &node.params, call).await?;
            let value = result.value;
            match def.category {
                Category::Video => {
                    let path = storage::download(app, http, &value).await?;
                    out.insert("video".into(), path.to_string_lossy().into_owned());
                    if let Some(draft_id) = result.draft_id {
                        out.insert("draftId".into(), draft_id);
                        // fal keeps a draft 14 days: the node shows when it expires.
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                        out.insert("draftAt".into(), now.as_millis().to_string());
                    }
                }
                Category::Image => {
                    let path = storage::download(app, http, &value).await?;
                    out.insert("image".into(), path.to_string_lossy().into_owned());
                }
                Category::Llm => {
                    out.insert("text".into(), value);
                }
                Category::Audio => {
                    let path = storage::download(app, http, &value).await?;
                    out.insert("audio".into(), path.to_string_lossy().into_owned());
                }
            }
        }
        "voice" => {
            let text = text_or_param(node, inputs, "text", "text")?;
            let voice = match param(node, "voice").trim() {
                "" => "Matilda",
                v => v,
            };
            // Higher is steadier from one clip to the next; lower is more expressive.
            let stability = param(node, "stability").parse::<f64>().unwrap_or(0.5).clamp(0.0, 1.0);
            let url = if on_wavespeed {
                let ws = wavespeed::WaveSpeed::from_account(http)?;
                let input = serde_json::json!({ "text": text, "voice_id": voice, "stability": stability });
                let serde_json::Value::Object(input) = input else { unreachable!() };
                ws.run(wavespeed::VOICE, input).await?
            } else {
                fal.speak(&text, voice, stability).await?
            };
            out.insert("audio".into(), storage::download(app, http, &url).await?.to_string_lossy().into_owned());
        }
        "avatar" => {
            let image = require(inputs, "image", "an image of the character")?;
            let audio = require(inputs, "audio", "a voice (audio)")?;
            let prompt = match inputs.get("prompt").filter(|v| !v.is_empty()) {
                Some(texts) => texts.join("\n"),
                None => param(node, "prompt").to_owned(),
            };
            let url = if on_wavespeed {
                let ws = wavespeed::WaveSpeed::from_account(http)?;
                let host = |v: &str| {
                    let v = v.to_owned();
                    let ws = &ws;
                    async move { if v.starts_with("http") { Ok(v) } else { ws.upload(&storage::owned_path(app, &v)?).await } }
                };
                let (image, audio) = futures::try_join!(host(image), host(audio))?;
                let mut input = serde_json::json!({ "image": image, "audio": audio });
                if !prompt.trim().is_empty() {
                    input["prompt"] = serde_json::json!(prompt.trim());
                }
                let serde_json::Value::Object(input) = input else { unreachable!() };
                ws.run(wavespeed::AVATAR, input).await?
            } else {
                let image = storage::to_model_input(app, image)?;
                let audio = if audio.starts_with("http") { audio.to_owned() } else { fal.upload(&storage::owned_path(app, audio)?).await? };
                fal.talking_avatar(&image, &audio, &prompt).await?
            };
            out.insert("video".into(), storage::download(app, http, &url).await?.to_string_lossy().into_owned());
        }
        "upscale" => {
            let video = require(inputs, "video", "a video")?;
            let resolution = upscale_resolution(param(node, "resolution"));
            let pro = param(node, "quality") == "pro";
            let fps = param(node, "fps").parse::<u32>().ok().filter(|f| (12..=120).contains(f));
            let url = if on_wavespeed {
                let ws = wavespeed::WaveSpeed::from_account(http)?;
                let video = if video.starts_with("http") { video.to_owned() } else { ws.upload(&storage::owned_path(app, video)?).await? };
                let input = serde_json::json!({ "video": video, "target_resolution": resolution });
                let serde_json::Value::Object(input) = input else { unreachable!() };
                ws.run(wavespeed::upscale_model(pro), input).await?
            } else {
                let video = if video.starts_with("http") { video.to_owned() } else { fal.upload(&storage::owned_path(app, video)?).await? };
                let preset = match param(node, "look") {
                    p @ ("general" | "ugc" | "short_series" | "old_film") => p,
                    _ => "aigc",
                };
                let mut settings = serde_json::json!({
                    "target_resolution": resolution,
                    "enhancement_tier": if pro { "pro" } else { "standard" },
                    "enhancement_preset": preset,
                    "fidelity": if param(node, "fidelity") == "medium" { "medium" } else { "high" },
                });
                // fal interpolates the frame rate itself, better than ffmpeg.
                if let Some(fps) = fps {
                    settings["target_fps"] = serde_json::json!(fps);
                }
                fal.upscale_video(&video, settings).await?
            };
            let upscaled = storage::download(app, http, &url).await?;
            let export = compose::Export {
                format: match param(node, "format") {
                    f @ ("h265" | "prores") => f,
                    _ => "h264",
                },
                fps: if on_wavespeed { fps } else { None },
                sound: param(node, "sound") != "off",
            };
            let path = if export.is_plain() {
                upscaled
            } else {
                let path = compose::export(app, &upscaled, &export).await?;
                let _ = std::fs::remove_file(&upscaled);
                path
            };
            out.insert("video".into(), path.to_string_lossy().into_owned());
        }
        "upscaleImage" => {
            let image = require(inputs, "image", "an image")?;
            let resolution = match param(node, "resolution") {
                "2k" => "2k",
                "8k" => "8k",
                _ => "4k",
            };
            let format = match param(node, "format") {
                f @ ("jpg" | "webp") => f,
                _ => "png",
            };
            let url = if on_wavespeed {
                let ws = wavespeed::WaveSpeed::from_account(http)?;
                let image = if image.starts_with("http") { image.to_owned() } else { ws.upload(&storage::owned_path(app, image)?).await? };
                let format = if format == "jpg" { "jpeg" } else { format };
                let input = serde_json::json!({ "image": image, "target_resolution": resolution, "output_format": format });
                let serde_json::Value::Object(input) = input else { unreachable!() };
                ws.run(wavespeed::IMAGE_UPSCALER, input).await?
            } else {
                // SeedVR2 goes up to 2160p: 8K is WaveSpeed's only.
                let target = if resolution == "2k" { "1440p" } else { "2160p" };
                fal.upscale_image(&storage::to_model_input(app, image)?, target, format).await?
            };
            out.insert("image".into(), storage::download(app, http, &url).await?.to_string_lossy().into_owned());
        }
        "addAudio" => {
            let video = require(inputs, "video", "a video")?;
            let audio = require(inputs, "audio", "a sound")?;
            let offset = param(node, "offset").parse::<f64>().unwrap_or(0.0).max(0.0);
            // On WaveSpeed, done here with ffmpeg: fal isn't used.
            if on_wavespeed {
                let (video, audio) = futures::try_join!(local_media(app, http, video), local_media(app, http, audio))?;
                let path = compose::replace_sound(app, &video, &audio, offset).await?;
                out.insert("video".into(), path.to_string_lossy().into_owned());
                return Ok(out);
            }
            let host = |v: &str| {
                let v = v.to_owned();
                async move { if v.starts_with("http") { Ok(v) } else { fal.upload(&storage::owned_path(app, &v)?).await } }
            };
            let (video_url, audio_url) = futures::try_join!(host(video), host(audio))?;
            let url = fal.merge_audio_video(&video_url, &audio_url, offset).await?;
            out.insert("video".into(), storage::download(app, http, &url).await?.to_string_lossy().into_owned());
        }
        "compositor" => {
            let count = param(node, "layers").parse::<usize>().unwrap_or(1).min(compose::MAX_LAYERS);
            let mut places: HashMap<String, compose::Placement> = serde_json::from_str(param(node, "comp")).unwrap_or_default();
            // Bottom first: the user's order, then any port it doesn't list
            // in their own order (background, layer 1, 2…).
            let order: Vec<String> = serde_json::from_str(param(node, "order")).unwrap_or_default();
            let mut ports: Vec<String> = std::iter::once("bg".to_owned()).chain((1..=count).map(|i| format!("layer{i}"))).collect();
            ports.sort_by_key(|p| order.iter().position(|o| o == p).unwrap_or(usize::MAX));
            let layers: Vec<compose::Layer> = ports
                .into_iter()
                .filter_map(|port| {
                    let value = first(inputs, &port)?.to_owned();
                    Some(compose::Layer { value, place: places.remove(&port).unwrap_or_default(), cover: port == "bg" })
                })
                .collect();
            let size = |key: &str| param(node, key).parse::<u32>().ok().filter(|v| *v > 0);
            let canvas = compose::Canvas { width: size("width"), height: size("height"), timeline: param(node, "timeline") == "true" };
            let path = compose::render(app, &canvas, &layers).await?;
            out.insert("media".into(), path.to_string_lossy().into_owned());
        }
        "bpPortrait" => {
            let assets = byteplus::Assets::from_account(http)?;
            let previous = |k: &str| node.outputs.get(k).map(String::as_str).unwrap_or_default();
            // A portrait added elsewhere (BytePlus console): nothing to upload, only its review to follow.
            let existing = byteplus::existing_asset(param(node, "existing"))?;
            let source = match existing {
                Some(_) => "",
                None => require(inputs, "image", "an image of the character, or paste an existing asset ID")?,
            };
            // The same image was sent before: follow that portrait instead of
            // uploading it again (already validated, or review still going on).
            let id = if let Some(id) = existing {
                id
            } else if previous("source") == source && !previous("assetId").is_empty() {
                previous("assetId").to_owned()
            } else {
                // The library only takes a public URL: the image goes through fal storage.
                let url = if source.starts_with("http") { source.to_owned() } else { fal.upload(&storage::owned_path(app, source)?).await? };
                let name = match param(node, "name").trim() {
                    "" => "Portrait",
                    n => n,
                };
                let group = match param(node, "group").trim() {
                    "" => "SimpleNode",
                    g => g,
                };
                assets.create(group, &url, name).await?
            };
            out.insert("source".into(), source.to_owned());
            out.insert("assetId".into(), id.clone());
            out.insert("assetStatus".into(), "Processing".into());
            app.emit("node-status", NodeEvent { id: &node.id, status: "running", outputs: Some(&out), error: None, unbilled: false })?;
            if !assets.wait_reviewed(&id).await? {
                out.insert("assetStatus".into(), "Failed".into());
                app.emit("node-status", NodeEvent { id: &node.id, status: "running", outputs: Some(&out), error: None, unbilled: false })?;
                return Err(AppError::BytePlus(byteplus::PORTRAIT_REFUSED.into()));
            }
            out.insert("assetStatus".into(), "Active".into());
            out.insert("portrait".into(), format!("asset://{id}"));
        }
        "bpSeedance" => {
            let bp = BytePlus::from_account(http)?;
            let prompt = prompt_text(node, inputs);
            let start = first(inputs, "start").map(|v| byteplus::image_input(app, v)).transpose()?;
            let end = first(inputs, "end").map(|v| byteplus::image_input(app, v)).transpose()?;
            let portraits = inputs.get("portraits").map(Vec::as_slice).unwrap_or_default();
            if let Some(bad) = portraits.iter().find(|p| !p.starts_with("asset://")) {
                return Err(AppError::Invalid(format!("The Portraits input expects a validated AI Portrait, not {bad}")));
            }
            let images = inputs.get("refs").map(Vec::as_slice).unwrap_or_default();
            let refs = portraits
                .iter()
                .cloned()
                .map(Ok)
                .chain(images.iter().map(|v| byteplus::image_input(app, v)))
                .collect::<Result<Vec<_>>>()?;
            let body = byteplus::seedance_body(byteplus::SeedanceInput { prompt: &prompt, start, end, refs, params: &node.params })?;
            let video = bp.video(&body).await?;
            let path = storage::download(app, http, &video.url).await?;
            out.insert("video".into(), path.to_string_lossy().into_owned());
            if body.get("draft").is_some() {
                out.insert("draftId".into(), video.id);
                // BytePlus keeps a Draft 14 days from its creation.
                let at = if video.created_at > 0 { (video.created_at * 1000).to_string() } else { unix_ms() };
                out.insert("draftAt".into(), at);
            }
        }
        "bpSeedream" => {
            let bp = BytePlus::from_account(http)?;
            let prompt = prompt_text(node, inputs);
            let refs = inputs.get("refs").into_iter().flatten().map(|v| byteplus::image_input(app, v)).collect::<Result<Vec<_>>>()?;
            let url = bp.image(&byteplus::seedream_body(&node.params, &prompt, &refs)?).await?;
            let path = storage::download(app, http, &url).await?.to_string_lossy().into_owned();
            // Only text-to-image outputs are listed as trusted inputs for Seedance.
            if refs.is_empty() {
                byteplus::remember_trusted(app, &path, &url)?;
                out.insert("trustedAt".into(), unix_ms());
            }
            out.insert("image".into(), path);
        }
        other => return Err(AppError::Invalid(format!("Unknown node: {other}"))),
    }
    Ok(out)
}

/// Without a target, runs every node; with one, the target and its ancestors.
/// Either way a paid node that already has a result is skipped, unless it is
/// the target itself: re-running never re-bills work that is already done.
pub async fn run(
    app: &AppHandle,
    fal: &Fal,
    http: &reqwest::Client,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    target: Option<String>,
) -> Result<()> {
    let subset = match &target {
        Some(id) => ancestors(id, &edges),
        None => nodes.iter().map(|n| n.id.clone()).collect(),
    };
    let mut outputs: HashMap<String, Ports> = nodes.iter().map(|n| (n.id.clone(), n.outputs.clone())).collect();
    let mut failed = HashSet::new();
    let mut stopped = HashSet::new();

    for id in topo_sort(&nodes, &subset, &edges) {
        let node = nodes.iter().find(|n| n.id == id).unwrap();
        // A portrait still under review (or refused) has outputs but no
        // `asset://` yet: it runs again, to follow its review.
        let cached = !outputs[&id].is_empty() && (node.kind != "bpPortrait" || outputs[&id].contains_key("portrait"));
        if target.as_deref() != Some(id.as_str()) && cached && is_remote(&node.kind) {
            continue;
        }
        let emit = |status: &str, outs: Option<&Ports>, error: Option<String>| {
            app.emit("node-status", NodeEvent { id: &id, status, outputs: outs, error, unbilled: false })
        };

        let incoming: Vec<_> = edges.iter().filter(|e| e.target == id).collect();
        // Downstream of a stopped node: not run, and not an error either.
        if incoming.iter().any(|e| stopped.contains(&e.source)) {
            stopped.insert(id.clone());
            emit("idle", None, None)?;
            continue;
        }
        if incoming.iter().any(|e| failed.contains(&e.source)) {
            failed.insert(id.clone());
            emit("error", None, Some("An upstream node failed".into()))?;
            continue;
        }
        let mut inputs = Inputs::new();
        for e in &incoming {
            if let Some(v) = outputs.get(&e.source).and_then(|o| o.get(&e.source_handle)) {
                inputs.entry(e.target_handle.clone()).or_default().push(v.clone());
            }
        }

        // Already executing in another run: take its result. That run sends
        // the node's statuses.
        let pending = {
            let mut map = in_flight().lock().unwrap();
            match map.get(&id) {
                Some(rx) => Err(rx.clone()),
                None => {
                    let (tx, rx) = watch::channel(None);
                    map.insert(id.clone(), rx);
                    Ok(tx)
                }
            }
        };
        let tx = match pending {
            Ok(tx) => tx,
            Err(mut rx) => {
                let shared = rx.wait_for(Option::is_some).await.ok().and_then(|o| o.clone()).and_then(|r| r.ok());
                match shared {
                    Some(outs) => {
                        outputs.insert(id.clone(), outs);
                    }
                    None => {
                        failed.insert(id.clone());
                    }
                }
                continue;
            }
        };
        let (stop_tx, mut stop_rx) = watch::channel(false);
        stops().lock().unwrap().insert(id.clone(), stop_tx);
        let _claim = Claim(id.clone());

        emit("running", None, None)?;
        // Stopping drops the execution, which cancels its fal requests.
        let work = std::pin::pin!(execute(app, fal, http, node, &inputs));
        let stop = std::pin::pin!(stop_rx.wait_for(|s| *s));
        let result = match futures::future::select(work, stop).await {
            futures::future::Either::Left((result, _)) => result,
            futures::future::Either::Right(_) => {
                tx.send_replace(Some(Err("Stopped".into())));
                stopped.insert(id.clone());
                emit("idle", None, None)?;
                continue;
            }
        };
        tx.send_replace(Some(result.as_ref().map(Clone::clone).map_err(ToString::to_string)));
        match result {
            Ok(outs) => {
                emit("done", Some(&outs), None)?;
                outputs.insert(id.clone(), outs);
            }
            Err(err) => {
                failed.insert(id.clone());
                let event = NodeEvent { id: &id, status: "error", outputs: None, error: Some(err.to_string()), unbilled: err.unbilled() };
                app.emit("node-status", event)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> GraphNode {
        GraphNode { id: id.into(), kind: "prompt".into(), params: Ports::new(), outputs: Ports::new() }
    }

    fn edge(source: &str, target: &str) -> GraphEdge {
        GraphEdge { source: source.into(), source_handle: "text".into(), target: target.into(), target_handle: "prompt".into() }
    }

    #[test]
    fn crop_follows_the_framed_box_or_centers_the_ratio() {
        let mut n = node("c");
        n.params = Ports::from([("aspect".into(), "3:4".into())]);
        assert!(matches!(crop_spec(&n.params).unwrap(), CropSpec::Aspect(r) if (r - 0.75).abs() < 1e-9));
        for (k, v) in [("box", "1"), ("x", "10"), ("y", "5"), ("w", "50"), ("h", "60")] {
            n.params.insert(k.into(), v.into());
        }
        assert!(matches!(crop_spec(&n.params).unwrap(), CropSpec::Percent { x, y, w, h } if (x, y, w, h) == (10.0, 5.0, 50.0, 60.0)));
    }

    #[test]
    fn topo_sort_respects_dependencies() {
        let nodes = vec![node("c"), node("b"), node("a")];
        let edges = vec![edge("a", "b"), edge("b", "c")];
        let all = nodes.iter().map(|n| n.id.clone()).collect();
        assert_eq!(topo_sort(&nodes, &all, &edges), ["a", "b", "c"]);
    }

    #[test]
    fn ancestors_excludes_siblings_and_descendants() {
        let edges = vec![edge("a", "b"), edge("x", "b"), edge("b", "c"), edge("y", "c")];
        let up = ancestors("b", &edges);
        assert_eq!(up, HashSet::from(["a".into(), "x".into(), "b".into()]));
    }

    #[test]
    fn fill_template_replaces_only_declared_vars() {
        let inputs = Inputs::from([("var:sujet".to_owned(), vec!["un renard".to_owned()])]);
        let vars = ["sujet", "style"];
        assert_eq!(fill_template("{sujet}, {style}, {autre}", &vars, &inputs), "un renard, , {autre}");
        assert_eq!(fill_template("{{sujet}} {", &vars, &inputs), "{un renard} {");
    }

    #[test]
    fn list_returns_selected_item_or_empty() {
        let mut node = node("l");
        node.params.insert("items".into(), r#"["a","b","c"]"#.into());
        node.params.insert("selected".into(), "1".into());
        assert_eq!(selected_item(&node), "b");
        node.params.insert("selected".into(), "9".into());
        assert_eq!(selected_item(&node), "");
    }

    #[test]
    fn topo_sort_drops_cycles() {
        let nodes = vec![node("a"), node("b"), node("c")];
        let edges = vec![edge("a", "b"), edge("b", "a")];
        let all = nodes.iter().map(|n| n.id.clone()).collect();
        assert_eq!(topo_sort(&nodes, &all, &edges), ["c"]);
    }
}
