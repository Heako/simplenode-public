//! Media lives under `$APPDATA/images`, which the asset protocol is scoped to.
//! Node outputs hold absolute paths there. fal sees images as data URIs and
//! videos as uploaded URLs (too large to inline).

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::GenericImageView;
use reqwest::Client;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// fal's single-request upload limit is 90 MB.
const MAX_VIDEO_BYTES: u64 = 90 * 1024 * 1024;

fn images_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_data_dir()?.join("images");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "ogg" => Some("audio/ogg"),
        _ => None,
    }
}

pub fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

pub fn new_path(app: &AppHandle, ext: &str) -> Result<PathBuf> {
    Ok(images_dir(app)?.join(format!("{}.{ext}", uuid::Uuid::new_v4())))
}

/// Resolves a node value to a file we own, whatever the frontend sends;
/// canonicalize defeats `..`.
pub fn owned_path(app: &AppHandle, value: &str) -> Result<PathBuf> {
    let path = std::fs::canonicalize(value)?;
    if !path.starts_with(std::fs::canonicalize(images_dir(app)?)?) {
        return Err(AppError::Invalid("Path outside the app's storage".into()));
    }
    Ok(path)
}

/// Length in seconds of an MP4 or MOV file, read from its `moov/mvhd` box
/// without decoding anything. None for other formats or a malformed file.
pub fn video_duration(path: &Path) -> Option<f64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut pos = 0;
    // Top-level boxes: `moov` may come before or after the media data.
    while pos + 8 <= len {
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut header = [0u8; 16];
        file.read_exact(&mut header[..8]).ok()?;
        let size32 = u32::from_be_bytes(header[..4].try_into().ok()?) as u64;
        let (size, header_len) = match size32 {
            0 => (len - pos, 8),
            1 => {
                file.read_exact(&mut header[8..]).ok()?;
                (u64::from_be_bytes(header[8..].try_into().ok()?), 16)
            }
            n => (n, 8),
        };
        if size < header_len {
            return None;
        }
        if &header[4..8] == b"moov" {
            let mut moov = vec![0u8; (size - header_len) as usize];
            file.read_exact(&mut moov).ok()?;
            return mvhd_duration(&moov);
        }
        pos += size;
    }
    None
}

/// Duration from the `mvhd` child of a `moov` box's content.
fn mvhd_duration(moov: &[u8]) -> Option<f64> {
    let mut pos = 0;
    while pos + 8 <= moov.len() {
        let size = u32::from_be_bytes(moov[pos..pos + 4].try_into().ok()?) as usize;
        if size < 8 || pos + size > moov.len() {
            return None;
        }
        if &moov[pos + 4..pos + 8] == b"mvhd" {
            let body = &moov[pos + 8..pos + size];
            let be32 = |at: usize| body.get(at..at + 4).map(|b| u32::from_be_bytes(b.try_into().unwrap()) as u64);
            // Version 1 has 64-bit creation, modification and duration fields.
            let (timescale, duration) = if body.first()? == &1 {
                (be32(20)?, u64::from_be_bytes(body.get(24..32)?.try_into().ok()?))
            } else {
                (be32(12)?, be32(16)?)
            };
            return (timescale > 0).then(|| duration as f64 / timescale as f64);
        }
        pos += size;
    }
    None
}

/// Copies a user-picked file into app storage so it survives the original moving.
pub fn import(app: &AppHandle, source: &Path) -> Result<PathBuf> {
    let ext = extension(source);
    let mime = mime_for(&ext)
        .ok_or_else(|| AppError::Invalid("Unsupported format (png, jpg, webp, gif, mp4, mov, webm, mp3, wav, m4a, aac, ogg)".into()))?;
    let (limit, label) = if mime.starts_with("image/") {
        (MAX_IMAGE_BYTES, "Image too large (20 MB max)")
    } else {
        (MAX_VIDEO_BYTES, "File too large (90 MB max)")
    };
    if std::fs::metadata(source)?.len() > limit {
        return Err(AppError::Invalid(label.into()));
    }
    let dest = new_path(app, &ext)?;
    std::fs::copy(source, &dest)?;
    Ok(dest)
}

/// fal result URLs expire, so generated media is downloaded right away.
pub async fn download(app: &AppHandle, http: &Client, url: &str) -> Result<PathBuf> {
    let res = http.get(url).send().await?.error_for_status()?;
    let ext = match res.headers().get("content-type").and_then(|v| v.to_str().ok()) {
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("video/mp4") => "mp4",
        Some("video/webm") => "webm",
        Some("video/quicktime") => "mov",
        Some("audio/mpeg" | "audio/mp3") => "mp3",
        Some("audio/wav" | "audio/x-wav" | "audio/wave") => "wav",
        Some("audio/ogg" | "audio/opus") => "ogg",
        Some("audio/mp4" | "audio/x-m4a") => "m4a",
        // Some CDNs serve media as octet-stream; trust the URL then.
        _ if url.ends_with(".mp4") => "mp4",
        _ if url.ends_with(".mp3") => "mp3",
        _ if url.ends_with(".wav") => "wav",
        _ => "png",
    };
    let bytes = res.bytes().await?;
    let dest = new_path(app, ext)?;
    std::fs::write(&dest, bytes)?;
    Ok(dest)
}

/// Turns a stored image path into something a fal model accepts as an image URL.
pub fn to_model_input(app: &AppHandle, value: &str) -> Result<String> {
    if value.starts_with("http://") || value.starts_with("https://") {
        return Ok(value.to_owned());
    }
    let path = owned_path(app, value)?;
    let mime = mime_for(&extension(&path))
        .filter(|m| m.starts_with("image/"))
        .ok_or_else(|| AppError::Invalid("Not an image".into()))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(std::fs::read(&path)?)))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUsage {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
}

fn media_files(app: &AppHandle) -> Result<Vec<(PathBuf, u64)>> {
    Ok(std::fs::read_dir(images_dir(app)?)?
        .filter_map(|e| {
            let e = e.ok()?;
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| (e.path(), meta.len()))
        })
        .collect())
}

pub fn usage(app: &AppHandle) -> Result<MediaUsage> {
    let files = media_files(app)?;
    Ok(MediaUsage {
        path: images_dir(app)?.to_string_lossy().into_owned(),
        files: files.len(),
        bytes: files.iter().map(|(_, b)| b).sum(),
    })
}

/// Deletes media no project references. `projects_text` is the raw JSON of
/// every saved project (trashed ones included); file names are random UUIDs,
/// so a name appearing anywhere in it means the file is in use.
pub fn clean_unused(app: &AppHandle, projects_text: &str) -> Result<MediaUsage> {
    let mut freed = MediaUsage { path: images_dir(app)?.to_string_lossy().into_owned(), files: 0, bytes: 0 };
    for (path, bytes) in media_files(app)? {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !projects_text.contains(name) {
            std::fs::remove_file(&path)?;
            freed.files += 1;
            freed.bytes += bytes;
        }
    }
    Ok(freed)
}

pub fn reveal(app: &AppHandle) -> Result<()> {
    let dir = images_dir(app)?;
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(&dir).spawn()?;
    Ok(())
}

/// Crop rectangle, either a fixed aspect ratio (largest centered rect) or
/// free percentages of the source.
pub enum CropSpec {
    Aspect(f64),
    Percent { x: f64, y: f64, w: f64, h: f64 },
}

fn crop_rect(width: u32, height: u32, spec: &CropSpec) -> (u32, u32, u32, u32) {
    let (w, h) = (width as f64, height as f64);
    let (x, y, cw, ch) = match *spec {
        CropSpec::Aspect(ratio) => {
            let (cw, ch) = if w / h > ratio { (h * ratio, h) } else { (w, w / ratio) };
            ((w - cw) / 2.0, (h - ch) / 2.0, cw, ch)
        }
        CropSpec::Percent { x, y, w: pw, h: ph } => {
            let x = (x.clamp(0.0, 100.0) / 100.0) * w;
            let y = (y.clamp(0.0, 100.0) / 100.0) * h;
            let cw = (pw.clamp(0.1, 100.0) / 100.0 * w).min(w - x);
            let ch = (ph.clamp(0.1, 100.0) / 100.0 * h).min(h - y);
            (x, y, cw, ch)
        }
    };
    (x.round() as u32, y.round() as u32, (cw.round() as u32).max(1), (ch.round() as u32).max(1))
}

pub fn crop(app: &AppHandle, value: &str, spec: &CropSpec) -> Result<PathBuf> {
    let source = owned_path(app, value)?;
    let img = image::open(&source).map_err(|e| AppError::Invalid(format!("Unreadable image: {e}")))?;
    let (x, y, w, h) = crop_rect(img.width(), img.height(), spec);
    let dest = new_path(app, "png")?;
    img.view(x, y, w, h)
        .to_image()
        .save(&dest)
        .map_err(|e| AppError::Invalid(format!("Cannot write: {e}")))?;
    Ok(dest)
}

/// One image of a set travelling on a "views" port (camera angles, grid tiles).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct View {
    pub path: String,
    pub label: String,
}

/// A set of views as it travels between nodes: a JSON string, like every port value.
pub fn encode_views(views: &[View]) -> String {
    serde_json::to_string(views).unwrap_or_else(|_| "[]".into())
}

pub fn decode_views(value: &str) -> Result<Vec<View>> {
    serde_json::from_str(value).map_err(|_| AppError::Invalid("Expected input: a set of shots".into()))
}

/// File-name friendly version of a label: "Contre-plongée" -> "contre-plongee".
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}

/// Saves one stored file where the user chose (the "download" button).
pub fn save_copy(app: &AppHandle, value: &str, dest: &Path) -> Result<()> {
    if !dest.is_absolute() {
        return Err(AppError::Invalid("Invalid destination".into()));
    }
    std::fs::copy(owned_path(app, value)?, dest)?;
    Ok(())
}

/// Copies every view into `folder` as `01-gros-plan.png`, … Returns the files written.
pub fn export_views(app: &AppHandle, views: &[View], folder: &str) -> Result<usize> {
    let folder = PathBuf::from(folder);
    if !folder.is_absolute() {
        return Err(AppError::Invalid("Choose an export folder".into()));
    }
    std::fs::create_dir_all(&folder)?;
    for (i, view) in views.iter().enumerate() {
        let source = owned_path(app, &view.path)?;
        let name = format!("{:02}-{}.{}", i + 1, slug(&view.label), extension(&source));
        std::fs::copy(&source, folder.join(name))?;
    }
    Ok(views.len())
}

/// Largest grid the Grid Crop node offers (6×6).
pub const MAX_GRID: u32 = 6;

/// Cell rectangles of a `rows`×`cols` grid, row-major. Edge cells absorb the
/// pixels left over by integer division. `inset` (percent of a cell) trims
/// each cell's borders, to drop the gutters models draw between panels.
fn grid_cells(width: u32, height: u32, rows: u32, cols: u32, inset: f64) -> Vec<(u32, u32, u32, u32)> {
    let mut cells = Vec::new();
    for r in 0..rows {
        let (y0, y1) = (r * height / rows, (r + 1) * height / rows);
        for c in 0..cols {
            let (x0, x1) = (c * width / cols, (c + 1) * width / cols);
            let (w, h) = (x1 - x0, y1 - y0);
            let dx = ((w as f64) * inset.clamp(0.0, 20.0) / 100.0).round() as u32;
            let dy = ((h as f64) * inset.clamp(0.0, 20.0) / 100.0).round() as u32;
            cells.push((x0 + dx, y0 + dy, (w - 2 * dx).max(1), (h - 2 * dy).max(1)));
        }
    }
    cells
}

/// Splits a contact sheet into one image per cell, row-major.
pub fn grid_crop(app: &AppHandle, value: &str, rows: u32, cols: u32, inset: f64) -> Result<Vec<PathBuf>> {
    if !(1..=MAX_GRID).contains(&rows) || !(1..=MAX_GRID).contains(&cols) {
        return Err(AppError::Invalid(format!("Grid from 1×1 to {MAX_GRID}×{MAX_GRID}")));
    }
    let source = owned_path(app, value)?;
    let img = image::open(&source).map_err(|e| AppError::Invalid(format!("Unreadable image: {e}")))?;
    grid_cells(img.width(), img.height(), rows, cols, inset)
        .into_iter()
        .map(|(x, y, w, h)| {
            let dest = new_path(app, "png")?;
            let tile = img.view(x, y, w, h).to_image();
            let (tx, ty, tw, th) = gutter_trim(&tile);
            image::imageops::crop_imm(&tile, tx, ty, tw, th)
                .to_image()
                .save(&dest)
                .map_err(|e| AppError::Invalid(format!("Cannot write: {e}")))?;
            Ok(dest)
        })
        .collect()
}

/// Most a gutter can take from one side of a tile.
const GUTTER_MAX: f64 = 0.04;

/// A row or column of a sheet's gutter: one flat color, near black or near white.
fn is_gutter_line<I: Iterator<Item = u8>>(lumas: I) -> bool {
    let (mut min, mut max, mut sum, mut n) = (u8::MAX, 0u8, 0u32, 0u32);
    for l in lumas {
        min = min.min(l);
        max = max.max(l);
        sum += u32::from(l);
        n += 1;
    }
    if n == 0 {
        return false;
    }
    let mean = sum / n;
    max - min < 24 && !(40..=235).contains(&mean)
}

/// The tile without the gutter lines a generated sheet leaves on its edges
/// (models draw dark or white bands between panels, which an even split
/// keeps). Returns x, y, width, height; at most `GUTTER_MAX` per side.
fn gutter_trim(tile: &image::RgbaImage) -> (u32, u32, u32, u32) {
    let (w, h) = tile.dimensions();
    let luma = |x: u32, y: u32| {
        let p = tile.get_pixel(x, y);
        ((u32::from(p[0]) * 299 + u32::from(p[1]) * 587 + u32::from(p[2]) * 114) / 1000) as u8
    };
    let max_x = (f64::from(w) * GUTTER_MAX) as u32;
    let max_y = (f64::from(h) * GUTTER_MAX) as u32;
    // Columns first, then rows between the kept columns only: where two
    // bands of different colors meet, a full row would mix both.
    let col = |x: u32| is_gutter_line((0..h).map(move |y| luma(x, y)));
    let mut left = (0..max_x).take_while(|&x| col(x)).count() as u32;
    let mut right = (0..max_x).take_while(|&i| col(w - 1 - i)).count() as u32;
    // Then the seam: the band's edge, cut through a pixel, leaves a line or
    // two blended with the picture, too varied to be a flat band but much
    // darker (or lighter) than the picture just inside.
    let col_mean = |x: u32| (0..h).map(|y| u32::from(luma(x, y))).sum::<u32>() / h.max(1);
    left += seam(|i| col_mean(left + i));
    right += seam(|i| col_mean(w - 1 - right - i));
    let row = |y: u32| is_gutter_line((left..w - right).map(move |x| luma(x, y)));
    let mut top = (0..max_y).take_while(|&y| row(y)).count() as u32;
    let mut bottom = (0..max_y).take_while(|&i| row(h - 1 - i)).count() as u32;
    let row_mean = |y: u32| (left..w - right).map(|x| u32::from(luma(x, y))).sum::<u32>() / (w - left - right).max(1);
    top += seam(|i| row_mean(top + i));
    bottom += seam(|i| row_mean(h - 1 - bottom - i));
    (left, top, w - left - right, h - top - bottom)
}

/// Seam lines on one side, at most `SEAM_MAX`: `mean(i)` is the mean luma of
/// the i-th line inward. A line is a seam when it stands out from the
/// picture a few lines further in.
const SEAM_MAX: u32 = 2;

fn seam(mean: impl Fn(u32) -> u32) -> u32 {
    let inner = mean(SEAM_MAX + 2);
    (0..SEAM_MAX)
        .take_while(|&i| {
            let line = mean(i);
            (inner >= line + 30 && line * 10 < inner * 7) || (line >= inner + 30 && line > 200)
        })
        .count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gutters_are_trimmed_but_not_the_picture() {
        // A 100×100 tile: a 3 px black band on the left, a 2 px white band on top, a busy picture elsewhere.
        let tile = image::RgbaImage::from_fn(100, 100, |x, y| {
            if x < 3 {
                image::Rgba([5, 5, 5, 255])
            } else if y < 2 {
                image::Rgba([250, 250, 250, 255])
            } else {
                let v = ((x * 7 + y * 13) % 200) as u8 + 30;
                image::Rgba([v, v / 2, 255 - v, 255])
            }
        });
        assert_eq!(gutter_trim(&tile), (3, 2, 97, 98));
        // A blended seam line (darker, but not flat) next to the picture goes too.
        let seamed = image::RgbaImage::from_fn(100, 100, |x, y| {
            let v = if y == 0 { 40 + (x % 30) as u8 } else { 140 + ((x * 3 + y) % 40) as u8 };
            image::Rgba([v, v, v, 255])
        });
        assert_eq!(gutter_trim(&seamed), (0, 1, 100, 99));
        // An all-black tile loses 4 % per side at most.
        let dark = image::RgbaImage::from_pixel(100, 100, image::Rgba([0, 0, 0, 255]));
        assert_eq!(gutter_trim(&dark), (4, 4, 92, 92));
    }

    #[test]
    fn grid_cells_cover_the_image_row_major() {
        let cells = grid_cells(1000, 600, 2, 3, 0.0);
        assert_eq!(cells.len(), 6);
        assert_eq!(cells[0], (0, 0, 333, 300));
        assert_eq!(cells[2], (666, 0, 334, 300));
        assert_eq!(cells[5], (666, 300, 334, 300));
    }

    #[test]
    fn slug_makes_safe_file_names() {
        assert_eq!(slug("Contre-plongée"), "contre-plongee");
        assert_eq!(slug("Par-dessus l'épaule"), "par-dessus-l-epaule");
        assert_eq!(slug("Vue 3"), "vue-3");
    }

    #[test]
    fn views_round_trip() {
        let views = vec![View { path: "/a.png".into(), label: "Gros plan".into() }];
        assert_eq!(decode_views(&encode_views(&views)).unwrap(), views);
        assert!(decode_views("not json").is_err());
    }

    #[test]
    fn grid_inset_trims_each_cell() {
        assert_eq!(grid_cells(200, 200, 2, 2, 5.0)[0], (5, 5, 90, 90));
    }

    #[test]
    fn aspect_crop_is_centered_and_maximal() {
        assert_eq!(crop_rect(1920, 1080, &CropSpec::Aspect(1.0)), (420, 0, 1080, 1080));
        assert_eq!(crop_rect(1000, 1000, &CropSpec::Aspect(2.0)), (0, 250, 1000, 500));
    }

    #[test]
    fn percent_crop_stays_inside_the_image() {
        let spec = CropSpec::Percent { x: 50.0, y: 50.0, w: 100.0, h: 100.0 };
        assert_eq!(crop_rect(200, 100, &spec), (100, 50, 100, 50));
    }
}
