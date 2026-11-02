mod account;
mod angles;
mod byteplus;
mod compose;
mod error;
mod fal;
mod graph;
mod mcp;
mod models;
mod projects;
mod recast;
mod schema;
mod storage;

use std::path::PathBuf;

use tauri::{AppHandle, State};

use account::KeyKind;
use error::{CommandError, Result};
use graph::{GraphEdge, GraphNode};

struct AppState {
    http: reqwest::Client,
}

#[tauri::command]
fn key_status() -> Result<account::KeyStatus> {
    account::key_status()
}

#[tauri::command]
fn set_fal_key(kind: KeyKind, key: String) -> Result<()> {
    account::set_key(kind, &key)
}

#[tauri::command]
async fn test_fal_key(state: State<'_, AppState>, kind: KeyKind) -> Result<()> {
    account::test_key(&state.http, kind).await
}

#[tauri::command]
async fn model_prices(state: State<'_, AppState>) -> Result<Vec<account::PriceRow>> {
    let prices = account::prices(&state.http).await;
    if let Err(e) = &prices {
        log::warn!("model_prices: {e}");
    }
    prices
}

#[tauri::command]
async fn fal_spend(state: State<'_, AppState>, days: u32) -> Result<account::Spend> {
    account::spend(&state.http, days).await
}

#[tauri::command]
fn media_usage(app: AppHandle) -> Result<storage::MediaUsage> {
    storage::usage(&app)
}

#[tauri::command]
fn clean_unused_media(app: AppHandle) -> Result<storage::MediaUsage> {
    storage::clean_unused(&app, &projects::all_text(&app)?)
}

#[tauri::command]
fn reveal_media_folder(app: AppHandle) -> Result<()> {
    storage::reveal(&app)
}

#[tauri::command]
fn list_models() -> Vec<&'static models::ModelDef> {
    models::all().collect()
}

#[tauri::command]
fn camera_shots() -> &'static [angles::Shot] {
    angles::SHOTS
}

#[tauri::command]
fn recast_modes() -> &'static [recast::Mode] {
    recast::MODES
}

/// Every setting of a fal endpoint, from its published schema.
#[tauri::command]
async fn model_settings(state: State<'_, AppState>, endpoint: String) -> Result<Vec<schema::Setting>> {
    schema::settings(&state.http, &endpoint).await
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Result<Vec<projects::ProjectMeta>> {
    projects::list(&app)
}

#[tauri::command]
fn load_project(app: AppHandle, id: String) -> Result<projects::Project> {
    projects::load(&app, &id)
}

#[tauri::command]
fn save_project(app: AppHandle, project: projects::Project) -> Result<projects::ProjectMeta> {
    projects::save(&app, project)
}

#[tauri::command]
fn delete_project(app: AppHandle, id: String) -> Result<()> {
    projects::delete(&app, &id)
}

#[tauri::command]
fn save_media(app: AppHandle, source: String, dest: PathBuf) -> Result<()> {
    storage::save_copy(&app, &source, &dest)
}

#[tauri::command]
fn import_image(app: AppHandle, path: PathBuf) -> Result<String> {
    Ok(storage::import(&app, &path)?.to_string_lossy().into_owned())
}

#[tauri::command]
async fn run_graph(
    app: AppHandle,
    state: State<'_, AppState>,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    target: Option<String>,
) -> Result<()> {
    // Runs may overlap: graph::run shares the nodes they have in common.
    // The fal key is only required by nodes that call fal (BytePlus nodes don't).
    let fal = fal::Fal::new(state.http.clone(), account::main_key().unwrap_or_default());
    graph::run(&app, &fal, &state.http, nodes, edges, target).await
}

/// Crops as a Crop node's params say, as soon as they change: the node is live.
/// Decoding a large image takes a moment, so off the main thread.
#[tauri::command]
async fn crop_image(app: AppHandle, value: String, params: std::collections::HashMap<String, String>) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = graph::crop_spec(&params)?;
        Ok(storage::crop(&app, &value, &spec)?.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| error::AppError::Invalid(format!("Crop interrupted: {e}")))?
}

#[tauri::command]
fn mcp_status(app: AppHandle) -> mcp::McpStatus {
    mcp::status(&app)
}

#[tauri::command]
async fn mcp_configure(app: AppHandle, config: mcp::McpConfig) -> Result<mcp::McpStatus> {
    mcp::configure(&app, config).await
}

#[tauri::command]
async fn mcp_regenerate_token(app: AppHandle) -> Result<mcp::McpStatus> {
    mcp::regenerate_token(&app).await
}

/// The window's answer to an MCP tool call.
#[tauri::command]
fn mcp_reply(id: u64, ok: bool, result: serde_json::Value) {
    mcp::reply(id, ok, result);
}

/// Stops the given nodes, or all running ones; their fal requests are cancelled.
#[tauri::command]
fn stop_nodes(ids: Option<Vec<String>>) {
    graph::stop(ids.as_deref());
}

/// Renders a Seedance draft in 1080p and stores it locally.
#[tauri::command]
async fn finalize_draft(app: AppHandle, state: State<'_, AppState>, draft_id: String) -> std::result::Result<String, CommandError> {
    let fal = fal::Fal::new(state.http.clone(), account::main_key()?);
    let url = fal.complete_draft(&draft_id).await?;
    Ok(storage::download(&app, &state.http, &url).await?.to_string_lossy().into_owned())
}

/// Renders a BytePlus Seedance 2.5 Draft in 1080p and stores it locally.
#[tauri::command]
async fn finalize_byteplus_draft(app: AppHandle, state: State<'_, AppState>, draft_id: String) -> std::result::Result<String, CommandError> {
    let bp = byteplus::BytePlus::from_account(&state.http)?;
    let video = bp.video(&byteplus::finalize_body(&draft_id)).await?;
    Ok(storage::download(&app, &state.http, &video.url).await?.to_string_lossy().into_owned())
}

/// "Test connection": the API key, and the AK/SK when they are saved.
#[tauri::command]
async fn test_byteplus(state: State<'_, AppState>, which: String) -> Result<()> {
    match which.as_str() {
        "aksk" => byteplus::Assets::from_account(&state.http)?.test().await,
        _ => byteplus::BytePlus::from_account(&state.http)?.test().await,
    }
}

/// A portrait's review status in the BytePlus library.
#[tauri::command]
async fn byteplus_asset_status(state: State<'_, AppState>, asset_id: String) -> Result<byteplus::AssetState> {
    byteplus::Assets::from_account(&state.http)?.state(&asset_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { http: reqwest::Client::new() })
        .setup(|app| {
            account::init(tauri::Manager::path(app).app_config_dir()?);
            // The MCP server, when enabled in Settings.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { mcp::apply(&handle).await });
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            key_status,
            set_fal_key,
            test_fal_key,
            model_prices,
            fal_spend,
            media_usage,
            clean_unused_media,
            reveal_media_folder,
            list_models,
            camera_shots,
            recast_modes,
            model_settings,
            list_projects,
            load_project,
            save_project,
            delete_project,
            import_image,
            save_media,
            run_graph,
            stop_nodes,
            crop_image,
            mcp_status,
            mcp_configure,
            mcp_regenerate_token,
            mcp_reply,
            finalize_draft,
            finalize_byteplus_draft,
            test_byteplus,
            byteplus_asset_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
