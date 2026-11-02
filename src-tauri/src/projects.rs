//! Projects are JSON files under `$APPDATA/projects/<id>.json`. The graph
//! itself (nodes, edges) is opaque to Rust: the frontend owns its shape.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub title: String,
    /// Milliseconds since the Unix epoch, set on every save.
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub trashed: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    #[serde(flatten)]
    pub meta: ProjectMeta,
    pub nodes: Value,
    pub edges: Value,
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("projects");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Ids come from the frontend; restricting the charset rules out path tricks.
fn project_path(app: &AppHandle, id: &str) -> Result<PathBuf> {
    let valid = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(AppError::Invalid(format!("Invalid project id: {id}")));
    }
    Ok(projects_dir(app)?.join(format!("{id}.json")))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

/// Newest first. Unreadable files are skipped rather than failing the list.
pub fn list(app: &AppHandle) -> Result<Vec<ProjectMeta>> {
    let mut metas: Vec<ProjectMeta> = std::fs::read_dir(projects_dir(app)?)?
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()? != "json" {
                return None;
            }
            let project: Project = serde_json::from_slice(&std::fs::read(&path).ok()?).ok()?;
            Some(project.meta)
        })
        .collect();
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

pub fn load(app: &AppHandle, id: &str) -> Result<Project> {
    let bytes = std::fs::read(project_path(app, id)?)?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::Invalid(format!("Unreadable project: {e}")))
}

/// Writes to a temp file then renames, so a crash never leaves a half-written project.
pub fn save(app: &AppHandle, mut project: Project) -> Result<ProjectMeta> {
    project.meta.updated_at = now_ms();
    let path = project_path(app, &project.meta.id)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&project).map_err(|e| AppError::Invalid(e.to_string()))?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, &path)?;
    Ok(project.meta)
}

/// Raw JSON of every project, for media garbage collection.
pub fn all_text(app: &AppHandle) -> Result<String> {
    let mut text = String::new();
    for entry in std::fs::read_dir(projects_dir(app)?)? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "json") {
            text.push_str(&std::fs::read_to_string(&path)?);
        }
    }
    Ok(text)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<()> {
    Ok(std::fs::remove_file(project_path(app, id)?)?)
}
