mod account;
mod angles;
mod error;
mod fal;
mod graph;
mod models;
mod projects;
mod schema;
mod storage;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, State};

use account::KeyKind;
use error::{AppError, Result};
use graph::{GraphEdge, GraphNode};

struct AppState {
    http: reqwest::Client,
    running: AtomicBool,
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
    account::prices(&state.http).await
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
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(AppError::Invalid("Une exécution est déjà en cours".into()));
    }
    let result = async {
        let fal = fal::Fal::new(state.http.clone(), account::main_key()?);
        graph::run(&app, &fal, &state.http, nodes, edges, target).await
    }
    .await;
    state.running.store(false, Ordering::SeqCst);
    result
}

/// Renders a Seedance draft in 1080p and stores it locally.
#[tauri::command]
async fn finalize_draft(app: AppHandle, state: State<'_, AppState>, draft_id: String) -> Result<String> {
    let fal = fal::Fal::new(state.http.clone(), account::main_key()?);
    let url = fal.complete_draft(&draft_id).await?;
    Ok(storage::download(&app, &state.http, &url).await?.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { http: reqwest::Client::new(), running: AtomicBool::new(false) })
        .setup(|app| {
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
            model_settings,
            list_projects,
            load_project,
            save_project,
            delete_project,
            import_image,
            save_media,
            run_graph,
            finalize_draft
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
