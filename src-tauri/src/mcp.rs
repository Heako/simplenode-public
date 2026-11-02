//! MCP server, so Claude Code (or any MCP client) can drive SimpleNode.
//!
//! Streamable HTTP on 127.0.0.1, behind a bearer token, off until enabled in
//! Settings. Rust only speaks the protocol: each tool call is handed to the
//! frontend (`mcp-request` event), which acts on the open graph like the
//! user would, so the canvas shows every change, and answers through the
//! `mcp_reply` command. The frontend also enforces the spending cap.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::error::{AppError, Result};

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Longest a tool call may take: `wait_for_run` waits up to 10 minutes.
const CALL_TIMEOUT: Duration = Duration::from_secs(11 * 60);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    /// Dollars Claude Code may spend on generations per app session.
    pub budget: f64,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self { enabled: false, port: 7710, token: new_token(), budget: 5.0 }
    }
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir()?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("mcp.json"))
}

pub fn load(app: &AppHandle) -> McpConfig {
    let saved = config_path(app).ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<McpConfig>(&b).ok());
    let mut config = saved.unwrap_or_default();
    if config.token.len() < 32 {
        config.token = new_token();
    }
    config
}

fn save(app: &AppHandle, config: &McpConfig) -> Result<()> {
    let path = config_path(app)?;
    std::fs::write(&path, serde_json::to_vec_pretty(config).expect("config serializes"))?;
    // The token grants control of the app: readable by this account only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    #[serde(flatten)]
    pub config: McpConfig,
    /// Listening right now.
    pub running: bool,
    pub error: Option<String>,
}

struct Server {
    shutdown: oneshot::Sender<()>,
}

fn server() -> &'static Mutex<Option<Server>> {
    static SERVER: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
    SERVER.get_or_init(|| Mutex::new(None))
}

fn last_error() -> &'static Mutex<Option<String>> {
    static ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ERROR.get_or_init(|| Mutex::new(None))
}

pub fn status(app: &AppHandle) -> McpStatus {
    McpStatus { config: load(app), running: server().lock().unwrap().is_some(), error: last_error().lock().unwrap().clone() }
}

/// Saves the settings and starts, restarts or stops the server to match.
pub async fn configure(app: &AppHandle, config: McpConfig) -> Result<McpStatus> {
    if config.port < 1024 {
        return Err(AppError::Invalid("Port invalide : choisissez-en un au-dessus de 1024".into()));
    }
    save(app, &config)?;
    apply(app).await;
    Ok(status(app))
}

pub async fn regenerate_token(app: &AppHandle) -> Result<McpStatus> {
    let config = McpConfig { token: new_token(), ..load(app) };
    configure(app, config).await
}

/// Starts the server when enabled (at launch, and after each change).
pub async fn apply(app: &AppHandle) {
    if let Some(old) = server().lock().unwrap().take() {
        let _ = old.shutdown.send(());
    }
    *last_error().lock().unwrap() = None;
    let config = load(app);
    if !config.enabled {
        return;
    }
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", config.port)).await {
        Ok(l) => l,
        Err(e) => {
            *last_error().lock().unwrap() = Some(format!("Port {} indisponible : {e}", config.port));
            return;
        }
    };
    let (tx, rx) = oneshot::channel();
    let state = AppState { app: app.clone(), token: config.token.clone() };
    let router = Router::new().route("/mcp", post(handle).get(not_allowed).delete(not_allowed)).with_state(state);
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    *server().lock().unwrap() = Some(Server { shutdown: tx });
    log::info!("MCP server on 127.0.0.1:{}", config.port);
}

#[derive(Clone)]
struct AppState {
    app: AppHandle,
    token: String,
}

async fn not_allowed() -> StatusCode {
    // No server-initiated stream: every answer comes with its request.
    StatusCode::METHOD_NOT_ALLOWED
}

/// Pages in a browser could reach a local port: only local origins, if any.
fn origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get("origin").and_then(|v| v.to_str().ok()) {
        None => true,
        Some(origin) => ["http://127.0.0.1", "http://localhost"].iter().any(|o| origin == *o || origin.starts_with(&format!("{o}:"))),
    }
}

async fn handle(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let authorized = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| t == state.token);
    if !authorized || !origin_allowed(&headers) {
        return (StatusCode::UNAUTHORIZED, "Jeton MCP invalide").into_response();
    }
    match body {
        Value::Array(batch) => {
            let mut answers = Vec::new();
            for message in batch {
                if let Some(answer) = respond(&state.app, message).await {
                    answers.push(answer);
                }
            }
            if answers.is_empty() { StatusCode::ACCEPTED.into_response() } else { Json(Value::Array(answers)).into_response() }
        }
        message => match respond(&state.app, message).await {
            Some(answer) => Json(answer).into_response(),
            // Notifications and responses get no body.
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

/// One JSON-RPC message; None for notifications.
async fn respond(app: &AppHandle, message: Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message["method"].as_str().unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or_default();
            let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "simplenode", "version": app.package_info().version.to_string() },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default().to_owned();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let (text, is_error) = match call(app, &name, args).await {
                Ok(value) => (serde_json::to_string_pretty(&value).unwrap_or_default(), false),
                Err(e) => (e, true),
            };
            Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
        }
        other => Err(json!({ "code": -32601, "message": format!("Méthode inconnue : {other}") })),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) => json!({ "jsonrpc": "2.0", "id": id, "error": error }),
    })
}

// --- Bridge to the frontend -------------------------------------------------

/// A tool call's answer: the result, or the error shown to the client.
type Answer = std::result::Result<Value, String>;

fn pending() -> &'static Mutex<HashMap<u64, oneshot::Sender<Answer>>> {
    static PENDING: OnceLock<Mutex<HashMap<u64, oneshot::Sender<Answer>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize, Clone)]
struct Request {
    id: u64,
    tool: String,
    args: Value,
}

async fn call(app: &AppHandle, tool: &str, args: Value) -> Answer {
    if !tools().iter().any(|t| t["name"] == tool) {
        return Err(format!("Outil inconnu : {tool}"));
    }
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pending().lock().unwrap().insert(id, tx);
    if app.emit("mcp-request", Request { id, tool: tool.to_owned(), args }).is_err() {
        pending().lock().unwrap().remove(&id);
        return Err("SimpleNode n'a pas pu transmettre la demande à sa fenêtre".into());
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(answer)) => answer,
        _ => {
            pending().lock().unwrap().remove(&id);
            Err("Pas de réponse de la fenêtre SimpleNode : est-elle ouverte ?".into())
        }
    }
}

/// The frontend's answer to a tool call.
pub fn reply(id: u64, ok: bool, result: Value) {
    if let Some(tx) = pending().lock().unwrap().remove(&id) {
        let answer = if ok { Ok(result) } else { Err(result.as_str().map(str::to_owned).unwrap_or_else(|| result.to_string())) };
        let _ = tx.send(answer);
    }
}

// --- Tools ------------------------------------------------------------------

const INSTRUCTIONS: &str = "SimpleNode is a node canvas for AI image, video and audio generation through fal.ai. \
Workflow: list_projects / open_project or create_project, then get_graph to see nodes, their ports and edges. \
list_node_types gives the node kinds and models you can add. Build with add_node, connect, update_node. \
Port values are strings: file paths for media. import_media adds a local file as an Import node. \
Generations cost money: estimate_cost first, then run (refused beyond the spending cap the user set in SimpleNode), \
then wait_for_run to get results; outputs are local file paths you can read. Nodes that already have a result are \
not re-run by a run of the whole graph; run a node by id to redo it. The canvas updates live in front of the user. \
Seedance 2.5 Draft renders a cheap 480p preview: get_graph shows its \"draft\" (1080p cost, expiry; fal keeps it 14 days); \
finalize_draft renders that same video in 1080p, counted against the same spending cap.";

fn tools() -> Vec<Value> {
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({ "name": name, "description": description, "inputSchema": { "type": "object", "properties": properties, "required": required } })
    };
    let id = json!({ "type": "string", "description": "Node id, from get_graph or add_node" });
    vec![
        tool("list_projects", "Projects in SimpleNode, most recent first, with the open one marked.", json!({}), &[]),
        tool("open_project", "Opens a project on the canvas.", json!({ "id": { "type": "string" } }), &["id"]),
        tool("create_project", "Creates an empty project and opens it.", json!({ "title": { "type": "string" } }), &[]),
        tool(
            "get_graph",
            "The open project: nodes (kind, model, params, ports, outputs, status, errors) and edges.",
            json!({}),
            &[],
        ),
        tool(
            "list_node_types",
            "Node kinds and models that add_node accepts, with each model's main settings and options.",
            json!({}),
            &[],
        ),
        tool(
            "get_model_settings",
            "Every fal setting of a model (from fal's schema). Set them with update_node as params \"x:<key>\".",
            json!({ "model_id": { "type": "string" } }),
            &["model_id"],
        ),
        tool(
            "add_node",
            "Adds a node. kind from list_node_types; model_id for kind \"model\". params are merged over the defaults (e.g. {\"prompt\": \"…\"}).",
            json!({
                "kind": { "type": "string" },
                "model_id": { "type": "string" },
                "params": { "type": "object", "additionalProperties": { "type": "string" } },
                "title": { "type": "string" },
                "x": { "type": "number" },
                "y": { "type": "number" }
            }),
            &["kind"],
        ),
        tool(
            "update_node",
            "Changes a node's params (merged; a null value removes the key) and/or title.",
            json!({ "id": id, "params": { "type": "object" }, "title": { "type": "string" } }),
            &["id"],
        ),
        tool("delete_node", "Removes a node and its links.", json!({ "id": id }), &["id"]),
        tool(
            "connect",
            "Links an output port to an input port. Without handles, picks the first compatible ones (an image goes to the next free Image n).",
            json!({
                "source": { "type": "string" },
                "source_handle": { "type": "string" },
                "target": { "type": "string" },
                "target_handle": { "type": "string" }
            }),
            &["source", "target"],
        ),
        tool(
            "disconnect",
            "Removes the links into one input port of a node.",
            json!({ "target": { "type": "string" }, "target_handle": { "type": "string" } }),
            &["target", "target_handle"],
        ),
        tool(
            "import_media",
            "Copies a local image, video or audio file into SimpleNode as an Import node.",
            json!({ "path": { "type": "string", "description": "Absolute path" }, "x": { "type": "number" }, "y": { "type": "number" } }),
            &["path"],
        ),
        tool(
            "estimate_cost",
            "Estimated fal cost of running a node (with the ancestors it needs) or the whole graph, and the budget left.",
            json!({ "node_id": { "type": "string" } }),
            &[],
        ),
        tool(
            "run",
            "Starts a run of a node (and the ancestors without a result) or of the whole graph. Refused when its estimated cost exceeds the budget left. Returns at once: then call wait_for_run.",
            json!({ "node_id": { "type": "string" } }),
            &[],
        ),
        tool(
            "wait_for_run",
            "Waits until nothing is running (or the timeout), then returns each node's status, outputs and errors.",
            json!({ "timeout_seconds": { "type": "number", "description": "Up to 600, default 120" } }),
            &[],
        ),
        tool(
            "finalize_draft",
            "Renders a Seedance 2.5 Draft node's 480p draft as the same video in 1080p, and makes it the node's result. Waits for the video. Refused when its estimated cost exceeds the budget left, or once the draft expired (fal keeps it 14 days).",
            json!({ "node_id": id }),
            &["node_id"],
        ),
        tool("stop", "Stops a running node, or every one; their fal requests are cancelled.", json!({ "node_id": { "type": "string" } }), &[]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_are_well_formed() {
        let tools = tools();
        let mut names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        for t in &tools {
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
            for req in t["inputSchema"]["required"].as_array().unwrap() {
                assert!(t["inputSchema"]["properties"].get(req.as_str().unwrap()).is_some(), "{}: {req} not declared", t["name"]);
            }
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), tools.len(), "duplicate tool names");
    }

    #[test]
    fn only_local_origins() {
        let mut h = HeaderMap::new();
        assert!(origin_allowed(&h));
        h.insert("origin", "http://localhost:3000".parse().unwrap());
        assert!(origin_allowed(&h));
        h.insert("origin", "https://evil.example".parse().unwrap());
        assert!(!origin_allowed(&h));
        h.insert("origin", "http://localhost.evil.example".parse().unwrap());
        assert!(!origin_allowed(&h));
    }
}
