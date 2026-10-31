//! "Recast" node: a source video and character images make a new video.
//! Two modes, as in Higgsfield's Genjutsu: replace the people in the video
//! (scene, light, camera and sound kept), or move the characters, with their
//! own setting, the way the video moves.

use std::collections::HashMap;

use futures::future::try_join_all;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, Result};
use crate::fal::{Fal, ModelCall};
use crate::models::{self, ModelDef, Mode as InputMode};

/// fal input key of the source video, the same on every recast endpoint.
pub const VIDEO_KEY: &str = "video_url";

/// Node param: the longest segment the user wants, in seconds, or "auto".
/// Shorter segments keep the character closer to the photo: each one starts
/// again from it, where one long call drifts away from it over time.
pub const SEGMENT_KEY: &str = "segment";

/// Longest source one call takes, in seconds; a longer one is cut into equal
/// pieces, each processed on its own, which the user may then join.
fn max_piece(def: &ModelDef, params: &HashMap<String, String>) -> Option<f64> {
    let wanted = params.get(SEGMENT_KEY).and_then(|v| v.parse::<f64>().ok()).filter(|&s| s > 0.0);
    match (model_max(def, params), wanted) {
        (Some(max), Some(wanted)) => Some(max.min(wanted)),
        (max, wanted) => max.or(wanted),
    }
}

/// Shortest source a model takes, in seconds.
fn min_piece(def: &ModelDef) -> f64 {
    if def.id == "h3-max-recast" { 5.0 } else { 3.0 }
}

/// The model's own limit, from fal's docs.
fn model_max(def: &ModelDef, params: &HashMap<String, String>) -> Option<f64> {
    match def.id {
        // fal's limit is per shot, see `Job::plan`.
        "h3-max-recast" => Some(15.0),
        "kling-3-pro-motion" | "kling-3-standard-motion" => {
            Some(if params.get("character_orientation").map(String::as_str) == Some("image") { 10.0 } else { 30.0 })
        }
        _ => None,
    }
}

/// Equal pieces of at most `max` seconds covering `duration`, as (start, length).
/// Equal rather than `max` plus a remainder, so no piece is too short to process;
/// fewer, slightly longer pieces when equal ones would fall under `min`.
fn pieces(duration: f64, max: f64, min: f64) -> Vec<(f64, f64)> {
    let mut n = (duration / max).ceil().max(1.0) as usize;
    while n > 1 && duration / (n as f64) < min {
        n -= 1;
    }
    let len = duration / n as f64;
    (0..n).map(|i| (i as f64 * len, len)).collect()
}

/// One segment of a source cut into pieces. Kept in the node's `pieces`
/// output, so each can be watched, redone or downloaded before the user
/// decides to join them.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    /// Local copy of the source segment, uploaded again to redo it.
    pub source: String,
    /// Local result; empty while pending or after a failure.
    #[serde(default)]
    pub video: String,
    #[serde(default)]
    pub error: String,
}

pub fn encode_pieces(pieces: &[Piece]) -> String {
    serde_json::to_string(pieces).expect("pieces serialize")
}

pub fn decode_pieces(value: &str) -> Result<Vec<Piece>> {
    serde_json::from_str(value).map_err(|_| AppError::Invalid("Aucun segment à refaire : exécutez d'abord le nœud".into()))
}

/// What a first pass over the source gives.
pub enum Plan {
    /// Processed in one call: the result's URL.
    Whole(String),
    /// Too long for one call: the hosted source segments, in order, still to process.
    Pieces(Vec<String>),
}

/// Everything a recast call sends besides the source video.
pub struct Job<'a> {
    pub fal: &'a Fal,
    pub def: &'a ModelDef,
    pub params: &'a HashMap<String, String>,
    pub refs: &'a [String],
    /// Optional; empty sends none.
    pub prompt: &'a str,
}

impl Job<'_> {
    /// Runs the model on one hosted video. Returns the result's URL.
    pub async fn render(&self, video_url: &str) -> Result<String> {
        let media = vec![(VIDEO_KEY, InputMode::Both, json!(video_url))];
        let call = ModelCall { refs: self.refs, media, ..ModelCall::new(self.prompt) };
        Ok(self.fal.run_model(self.def, self.params, call).await?.value)
    }

    /// Processes the source in one call when the model takes it, otherwise
    /// cuts it into segments. `duration` is measured by fal when not known.
    pub async fn plan(&self, video_url: &str, duration: Option<f64>) -> Result<Plan> {
        let Some(max) = max_piece(self.def, self.params) else { return self.render(video_url).await.map(Plan::Whole) };
        let duration = match duration {
            Some(d) => d,
            None => self.fal.trim_video(video_url, 0.0, 1.0).await?.1,
        };
        if duration <= max {
            return self.render(video_url).await.map(Plan::Whole);
        }
        // H3 only refuses shots over 15 s: a source up to 30 s whose cuts are
        // shorter goes whole, and is cut only if fal refuses it. Not when the
        // user asked for shorter segments.
        let auto = !self.params.get(SEGMENT_KEY).is_some_and(|v| v.parse::<f64>().is_ok());
        if auto && self.def.id == "h3-max-recast" && duration <= 30.0 {
            match self.render(video_url).await {
                Err(AppError::Fal(detail)) if detail.contains("15 seconds") => {}
                other => return other.map(Plan::Whole),
            }
        }
        let cuts = pieces(duration, max, min_piece(self.def));
        let urls = try_join_all(cuts.iter().map(|&(start, len)| async move { self.fal.trim_video(video_url, start, len).await.map(|(url, _)| url) })).await?;
        Ok(Plan::Pieces(urls))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    /// Instructions a new node starts with; without them the model tends to
    /// keep the video's outfit, or to lose the face over time. Editable.
    pub prompt: &'static str,
    /// Best first.
    pub models: &'static [Choice],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    /// Registry id from `models::RECAST_MODELS`.
    pub id: &'static str,
    /// The endpoint's limits, from fal's docs; fal rejects inputs beyond them.
    pub note: &'static str,
}

pub static MODES: &[Mode] = &[
    Mode {
        id: "replace",
        label: "Remplacer",
        hint: "Garde la scène, la lumière, la caméra et le son ; remplace les personnes par vos personnages.",
        prompt: "Replace the person in the video with the person in the reference photo. \
                 Keep their face, hair and outfit exactly as in the photo in every frame.",
        models: &[
            Choice {
                id: "h3-max-recast",
                note: "Jusqu'à 4 personnages, associés aux personnes de gauche à droite. Vidéo de 5 s minimum ; si un plan dépasse 15 s, \
                       elle est découpée en segments égaux, à assembler ensuite si le résultat vous convient.",
            },
            Choice { id: "wan-2.2-animate-replace", note: "Un personnage. Moins cher, 720p au plus." },
        ],
    },
    Mode {
        id: "motion",
        label: "Mouvement",
        hint: "Anime votre personnage, dans son propre décor, avec les gestes et la caméra de la vidéo.",
        prompt: "Keep the character's face, hair and outfit exactly as in the reference photo in every frame.",
        models: &[
            Choice {
                id: "kling-3-pro-motion",
                note: "Un personnage. Au-delà de 30 s (10 s en cadrage « image »), la vidéo est découpée en segments, à assembler ensuite.",
            },
            Choice {
                id: "kling-3-standard-motion",
                note: "Un personnage, version économique. Au-delà de 30 s (10 s en cadrage « image »), la vidéo est découpée en segments, à assembler ensuite.",
            },
        ],
    },
];

/// The node's model, which must belong to its mode.
pub fn model(mode: &str, model_id: &str) -> Option<&'static ModelDef> {
    let mode = MODES.iter().find(|m| m.id == mode)?;
    mode.models.iter().any(|c| c.id == model_id).then(|| models::find(model_id)).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Category, RECAST_MODELS};

    #[test]
    fn modes_use_recast_models() {
        for mode in MODES {
            assert!(!mode.models.is_empty(), "{} has no model", mode.id);
            for Choice { id, .. } in mode.models {
                let def = RECAST_MODELS.iter().find(|m| m.id == *id).unwrap_or_else(|| panic!("{id} is not a recast model"));
                assert_eq!(def.category, Category::Video, "{id}");
                assert!(def.text_endpoint.is_none() && def.edit_endpoint.is_some(), "{id}: recast models are video-to-video");
            }
        }
        for def in RECAST_MODELS {
            assert!(MODES.iter().any(|m| m.models.iter().any(|c| c.id == def.id)), "{} belongs to no mode", def.id);
        }
    }

    #[test]
    fn pieces_are_equal_and_cover_the_source() {
        assert_eq!(pieces(12.0, 15.0, 5.0), [(0.0, 12.0)]);
        assert_eq!(pieces(20.0, 15.0, 5.0), [(0.0, 10.0), (10.0, 10.0)]);
        // 6 s asked of 15.6 s: three pieces of 5.2 s, not four under H3's 5 s minimum.
        assert_eq!(pieces(15.6, 5.0, 5.0).len(), 3);
        let cuts = pieces(46.0, 15.0, 5.0);
        assert_eq!(cuts.len(), 4);
        assert!(cuts.iter().all(|&(_, len)| len <= 15.0 && len >= 5.0));
        let (start, len) = cuts[3];
        assert!((start + len - 46.0).abs() < 1e-9);
    }

    #[test]
    fn user_segment_never_exceeds_the_model_limit() {
        let h3 = models::find("h3-max-recast").unwrap();
        let with = |v: &str| HashMap::from([(SEGMENT_KEY.to_owned(), v.to_owned())]);
        assert_eq!(max_piece(h3, &HashMap::new()), Some(15.0));
        assert_eq!(max_piece(h3, &with("auto")), Some(15.0));
        assert_eq!(max_piece(h3, &with("6")), Some(6.0));
        assert_eq!(max_piece(h3, &with("40")), Some(15.0));
        let wan = models::find("wan-2.2-animate-replace").unwrap();
        assert_eq!(max_piece(wan, &HashMap::new()), None);
        assert_eq!(max_piece(wan, &with("10")), Some(10.0));
    }

    #[test]
    fn model_must_match_mode() {
        assert_eq!(model("replace", "h3-max-recast").map(|m| m.id), Some("h3-max-recast"));
        assert!(model("motion", "h3-max-recast").is_none());
        assert!(model("unknown", "h3-max-recast").is_none());
    }
}
