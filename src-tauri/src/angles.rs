//! "Camera angles" node: re-shoots a reference image as several classic shot
//! types, either as one contact sheet cut into tiles (one model call) or as
//! one image per shot.

use std::collections::HashMap;

use serde::Serialize;

use crate::models::{ModelDef, ParamKind};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub id: &'static str,
    pub label: &'static str,
    /// What the model is asked for; English prompts follow instructions best.
    #[serde(skip)]
    pub prompt: &'static str,
}

pub static SHOTS: &[Shot] = &[
    Shot { id: "close", label: "Gros plan", prompt: "close-up on the face and shoulders" },
    Shot { id: "extreme", label: "Très gros plan", prompt: "extreme close-up on the eyes" },
    Shot { id: "pov", label: "Plan subjectif", prompt: "point-of-view shot through the subject's eyes, showing what they see" },
    Shot { id: "medium", label: "Plan moyen", prompt: "medium shot from the waist up" },
    Shot { id: "low", label: "Contre-plongée", prompt: "low-angle shot, camera below the subject looking up" },
    Shot { id: "ots", label: "Par-dessus l'épaule", prompt: "over-the-shoulder shot framed past a blurred foreground shoulder" },
    Shot { id: "high", label: "Plongée", prompt: "high-angle shot, camera above the subject looking down" },
    Shot { id: "tracking", label: "Travelling", prompt: "tracking shot of the subject in motion, background with slight motion blur" },
    Shot { id: "reveal", label: "Plan de révélation", prompt: "reveal shot, the subject partly hidden behind a foreground element" },
    Shot { id: "wide", label: "Plan large", prompt: "wide establishing shot, the subject small within the full environment" },
    Shot { id: "dutch", label: "Plan débullé", prompt: "dutch angle, camera tilted about 20 degrees" },
    Shot { id: "birdseye", label: "Vue aérienne", prompt: "bird's-eye view from directly overhead" },
    Shot { id: "long", label: "Plan d'ensemble", prompt: "long shot showing the subject head to toe" },
    Shot { id: "cowboy", label: "Plan américain", prompt: "cowboy shot framing the subject from mid-thigh up" },
    Shot { id: "tight", label: "Plan serré", prompt: "tight close-up filling the frame with the face" },
    Shot { id: "cutaway", label: "Plan de coupe", prompt: "cutaway detail shot of an object from the same scene, without the subject" },
    Shot { id: "profile", label: "Profil", prompt: "side profile shot" },
    Shot { id: "threequarter", label: "Trois-quarts", prompt: "three-quarter view of the subject" },
    Shot { id: "back", label: "De dos", prompt: "shot from behind the subject" },
];

pub fn shot(id: &str) -> Option<&'static Shot> {
    SHOTS.iter().find(|s| s.id == id)
}

/// Offered grid layouts as (columns, rows).
pub const LAYOUTS: &[(u32, u32)] = &[(2, 2), (3, 2), (2, 3), (3, 3), (3, 4), (2, 6), (4, 4)];

/// Parses "3x4" (columns × rows) into an offered layout.
pub fn layout(value: &str) -> Option<(u32, u32)> {
    let (c, r) = value.split_once('x')?;
    let layout = (c.parse().ok()?, r.parse().ok()?);
    LAYOUTS.contains(&layout).then_some(layout)
}

fn ratio(value: &str) -> Option<f64> {
    let (w, h) = value.split_once(':')?;
    Some(w.parse::<f64>().ok()? / h.parse::<f64>().ok()?)
}

/// fal `image_size` presets and their width / height ratio.
const IMAGE_SIZES: &[(&str, f64)] = &[
    ("square_hd", 1.0),
    ("landscape_4_3", 4.0 / 3.0),
    ("landscape_16_9", 16.0 / 9.0),
    ("portrait_4_3", 3.0 / 4.0),
    ("portrait_16_9", 9.0 / 16.0),
];

/// Picks the model's output shape closest to `target` (width / height),
/// comparing on a log scale so 2:1 and 1:2 are equally far from 1:1.
/// Returns the param key and value to send.
pub fn output_shape(def: &ModelDef, target: f64) -> Option<(&'static str, &'static str)> {
    let distance = |r: f64| (r.ln() - target.ln()).abs();
    let closest = |candidates: Vec<(&'static str, f64)>| {
        candidates.into_iter().min_by(|a, b| distance(a.1).total_cmp(&distance(b.1))).map(|(v, _)| v)
    };
    for p in def.params.iter().filter(|p| p.kind == ParamKind::Enum) {
        match p.key {
            "aspect_ratio" => {
                let value = closest(p.options.iter().filter_map(|o| Some((*o, ratio(o)?))).collect())?;
                return Some(("aspect_ratio", value));
            }
            "image_size" => {
                let value = closest(IMAGE_SIZES.iter().filter(|(v, _)| p.options.contains(v)).copied().collect())?;
                return Some(("image_size", value));
            }
            _ => {}
        }
    }
    None
}

/// Params for one call: output shape, plus the highest resolution offered up
/// to `resolution` (sheets need it: each panel gets a fraction of the pixels).
pub fn call_params(def: &ModelDef, target_ratio: f64, resolution: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    if let Some((key, value)) = output_shape(def, target_ratio) {
        params.insert(key.to_owned(), value.to_owned());
    }
    if let Some(p) = def.params.iter().find(|p| p.key == "resolution") {
        let value = if p.options.contains(&resolution) { resolution } else { p.default };
        params.insert("resolution".to_owned(), value.to_owned());
    }
    params
}

const KEEP: &str = "Keep exactly the same character (face, hair, body, outfit), the same location, \
the same lighting and the same color grade as the reference image.";

pub fn sheet_prompt(shots: &[&Shot], cols: u32, rows: u32, labels: bool, context: &str) -> String {
    let list = shots.iter().enumerate().map(|(i, s)| format!("{}. {}", i + 1, s.prompt)).collect::<Vec<_>>().join("; ");
    let text = if labels {
        "Write each shot's name in bold white capital letters at the bottom-left of its panel."
    } else {
        "No text, no captions, no labels, no numbers anywhere."
    };
    let context = if context.trim().is_empty() { String::new() } else { format!(" Scene: {}.", context.trim()) };
    format!(
        "A cinematic contact sheet: one image divided into a grid of {cols} columns by {rows} rows, \
         {n} equal panels separated by thin uniform black gutters. Every panel is a different camera \
         shot of the same moment. {KEEP}{context} Panels, left to right then top to bottom: {list}. {text}",
        n = cols * rows,
    )
}

pub fn single_prompt(shot: &Shot, context: &str) -> String {
    let context = if context.trim().is_empty() { String::new() } else { format!(" Scene: {}.", context.trim()) };
    format!("Re-shoot the reference image as a {}. {KEEP}{context} Cinematic still, no text.", shot.prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models;

    #[test]
    fn layouts_parse_only_offered_grids() {
        assert_eq!(layout("3x4"), Some((3, 4)));
        assert_eq!(layout("2x6"), Some((2, 6)));
        assert_eq!(layout("5x5"), None);
        assert_eq!(layout("nope"), None);
    }

    #[test]
    fn shape_picks_closest_ratio_per_model() {
        let nano = models::find("nano-banana-pro").unwrap();
        // 3 columns of 16:9 panels over 4 rows ≈ 1.33 -> 4:3
        assert_eq!(output_shape(nano, 3.0 * 16.0 / 9.0 / 4.0), Some(("aspect_ratio", "4:3")));
        let seedream = models::find("seedream-4.5").unwrap();
        assert_eq!(output_shape(seedream, 9.0 / 16.0), Some(("image_size", "portrait_16_9")));
    }

    #[test]
    fn sheet_prompt_lists_panels_in_order() {
        let shots = [shot("close").unwrap(), shot("wide").unwrap()];
        let p = sheet_prompt(&shots, 2, 1, false, "");
        assert!(p.contains("2 columns by 1 rows"));
        assert!(p.contains("1. close-up") && p.contains("2. wide"));
        assert!(p.contains("No text"));
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<_> = SHOTS.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), SHOTS.len());
    }
}
