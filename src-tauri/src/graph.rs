//! Graph execution: topological order, cached outputs, failure propagation.
//! Progress is streamed to the UI as `node-status` events.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use futures::future::try_join_all;

use crate::angles;
use crate::error::{AppError, Result};
use crate::fal::{Fal, ModelCall};
use crate::models::{self, Category, MediaKind};
use crate::storage::{self, CropSpec, View};

pub type Ports = HashMap<String, String>;
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
}

/// Nodes that call fal (and cost money) are not re-run when their output is cached.
fn is_remote(kind: &str) -> bool {
    matches!(kind, "model" | "enhancer" | "describer" | "videoDescriber" | "angles")
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
        return Err(AppError::Invalid("Texte d'entrée manquant".into()));
    }
    Ok(text)
}

fn require<'a>(inputs: &'a Inputs, key: &str, what: &str) -> Result<&'a str> {
    first(inputs, key).ok_or_else(|| AppError::Invalid(format!("Reliez {what}")))
}

const ENHANCER_SYSTEM: &str = "You rewrite prompts for image generation models. Expand the user's idea into one rich, \
precise prompt: subject, composition, lighting, lens or medium, color palette, mood, style references. Keep every \
element the user asked for and invent nothing that contradicts it. Answer with the prompt only, no preamble, in the \
user's language.";

const DESCRIBER_SYSTEM: &str = "You describe images so they can be recreated by an image generation model. Cover subject, \
composition, framing, lighting, colors, materials, style and mood. Answer with the description only, no preamble, in \
French.";

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

fn crop_spec(node: &GraphNode) -> Result<CropSpec> {
    let num = |k: &str, default: f64| param(node, k).parse::<f64>().unwrap_or(default);
    match param(node, "aspect") {
        "" | "free" => Ok(CropSpec::Percent { x: num("x", 0.0), y: num("y", 0.0), w: num("w", 100.0), h: num("h", 100.0) }),
        ratio => {
            let (a, b) = ratio.split_once(':').ok_or_else(|| AppError::Invalid(format!("Format invalide : {ratio}")))?;
            let (a, b): (f64, f64) = (a.parse().unwrap_or(1.0), b.parse().unwrap_or(1.0));
            Ok(CropSpec::Aspect(a / b))
        }
    }
}

async fn execute(app: &AppHandle, fal: &Fal, http: &reqwest::Client, node: &GraphNode, inputs: &Inputs) -> Result<Ports> {
    let mut out = Ports::new();
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
                return Err(AppError::Invalid("Aucun fichier importé".into()));
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
        "crop" => {
            let source = require(inputs, "image", "une image")?;
            let path = storage::crop(app, source, &crop_spec(node)?)?;
            out.insert("image".into(), path.to_string_lossy().into_owned());
        }
        "angles" => {
            let reference = storage::to_model_input(app, require(inputs, "image", "une image de référence")?)?;
            let context = first(inputs, "context").unwrap_or_default();
            let def = models::find(param(node, "modelId"))
                .filter(|m| m.category == Category::Image && m.edit_endpoint.is_some())
                .ok_or_else(|| AppError::Invalid("Choisissez un modèle d'image qui accepte une référence".into()))?;
            let (cols, rows) = angles::layout(param(node, "layout")).ok_or_else(|| AppError::Invalid("Disposition inconnue".into()))?;
            let ids: Vec<String> = serde_json::from_str(param(node, "shots")).unwrap_or_default();
            let shots = ids
                .iter()
                .take((cols * rows) as usize)
                .map(|id| angles::shot(id).ok_or_else(|| AppError::Invalid(format!("Plan inconnu : {id}"))))
                .collect::<Result<Vec<_>>>()?;
            if shots.len() != (cols * rows) as usize {
                return Err(AppError::Invalid(format!("Choisissez {} plans", cols * rows)));
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
            let source = require(inputs, "image", "une image")?;
            let num = |k: &str| param(node, k).parse::<u32>().unwrap_or(2);
            let inset = param(node, "inset").parse::<f64>().unwrap_or(0.0);
            let tiles = storage::grid_crop(app, source, num("rows"), num("cols"), inset)?;
            let views: Vec<View> = tiles
                .iter()
                .enumerate()
                .map(|(i, path)| View { path: path.to_string_lossy().into_owned(), label: format!("Vue {}", i + 1) })
                .collect();
            out.insert("views".into(), storage::encode_views(&views));
        }
        "anglePick" => {
            let views = storage::decode_views(require(inputs, "views", "un ensemble de plans")?)?;
            let index: usize = param(node, "selected").parse().unwrap_or(0);
            let view = views.get(index).or(views.first()).ok_or_else(|| AppError::Invalid("Aucun plan reçu".into()))?;
            out.insert("image".into(), view.path.clone());
        }
        "angleExport" => {
            let views = storage::decode_views(require(inputs, "views", "un ensemble de plans")?)?;
            let count = storage::export_views(app, &views, param(node, "folder"))?;
            out.insert("summary".into(), format!("{count} fichiers exportés"));
        }
        "enhancer" => {
            let prompt = text_or_param(node, inputs, "text", "text")?;
            let def = models::find("llm").expect("llm model is registered");
            let text = fal.run_model(def, &llm_params(node), ModelCall { system: ENHANCER_SYSTEM, ..ModelCall::new(&prompt) }).await?.value;
            out.insert("text".into(), text);
        }
        "describer" => {
            let image = storage::to_model_input(app, require(inputs, "image", "une image")?)?;
            let def = models::find("llm").expect("llm model is registered");
            let ask = if param(node, "detail") == "short" {
                "Décris cette image en une ou deux phrases."
            } else {
                "Décris cette image en détail."
            };
            let text = fal.run_model(def, &llm_params(node), ModelCall { system: DESCRIBER_SYSTEM, refs: std::slice::from_ref(&image), ..ModelCall::new(ask) })
                .await?
                .value;
            out.insert("text".into(), text);
        }
        "videoDescriber" => {
            let video = storage::owned_path(app, require(inputs, "video", "une vidéo")?)?;
            let url = fal.upload(&video).await?;
            let question = match param(node, "question").trim() {
                "" => "Décris cette vidéo : sujets, actions, mouvements de caméra, lumière, style et ambiance. Réponds en français.",
                q => q,
            };
            let text = fal.describe_video(&url, question, param(node, "detailed") == "true").await?;
            out.insert("text".into(), text);
        }
        "model" => {
            let def = models::find(param(node, "modelId"))
                .ok_or_else(|| AppError::Invalid(format!("Modèle inconnu : {}", param(node, "modelId"))))?;
            // Several connected prompts are joined; the inline field is the fallback.
            let prompt = match inputs.get("prompt").filter(|v| !v.is_empty()) {
                Some(texts) => texts.join("\n\n"),
                None => param(node, "prompt").to_owned(),
            };
            if prompt.trim().is_empty() {
                return Err(AppError::Invalid("Prompt manquant".into()));
            }
            let refs = inputs
                .get("refs")
                .map(|v| v.iter().map(|r| storage::to_model_input(app, r)).collect::<Result<Vec<_>>>())
                .transpose()?
                .unwrap_or_default();
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
                    }
                }
                Category::Image => {
                    let path = storage::download(app, http, &value).await?;
                    out.insert("image".into(), path.to_string_lossy().into_owned());
                }
                Category::Llm => {
                    out.insert("text".into(), value);
                }
            }
        }
        other => return Err(AppError::Invalid(format!("Nœud inconnu : {other}"))),
    }
    Ok(out)
}

/// Without a target, runs every node. With a target, runs it plus any model
/// ancestor lacking cached outputs, so re-running never re-bills upstream work.
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

    for id in topo_sort(&nodes, &subset, &edges) {
        let node = nodes.iter().find(|n| n.id == id).unwrap();
        let cached = !outputs[&id].is_empty();
        if target.as_deref().is_some_and(|t| t != id) && cached && is_remote(&node.kind) {
            continue;
        }
        let emit = |status: &str, outs: Option<&Ports>, error: Option<String>| {
            app.emit("node-status", NodeEvent { id: &id, status, outputs: outs, error })
        };

        let incoming: Vec<_> = edges.iter().filter(|e| e.target == id).collect();
        if incoming.iter().any(|e| failed.contains(&e.source)) {
            failed.insert(id.clone());
            emit("error", None, Some("Un nœud en amont a échoué".into()))?;
            continue;
        }
        let mut inputs = Inputs::new();
        for e in &incoming {
            if let Some(v) = outputs.get(&e.source).and_then(|o| o.get(&e.source_handle)) {
                inputs.entry(e.target_handle.clone()).or_default().push(v.clone());
            }
        }

        emit("running", None, None)?;
        match execute(app, fal, http, node, &inputs).await {
            Ok(outs) => {
                emit("done", Some(&outs), None)?;
                outputs.insert(id.clone(), outs);
            }
            Err(err) => {
                failed.insert(id.clone());
                emit("error", None, Some(err.to_string()))?;
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
