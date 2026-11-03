//! Video → Prompt: a video turned into a timed text prompt for a video model,
//! so the motion can be generated again from reference images alone, without
//! sending the video (and the real person in it) to the model.
//!
//! The video is sampled locally into contact sheets (`compose::contact_sheets`)
//! and read by a vision LLM: fal any-llm/vision, or WaveSpeed's.

use crate::compose::Sheets;

/// Vision models used, one per provider.
pub const FAL_MODEL: &str = "google/gemini-2.5-pro";
pub const WAVESPEED_ENDPOINT: &str = "wavespeed-ai/any-llm/vision";
pub const WAVESPEED_MODEL: &str = "google/gemini-3.1-flash-lite";

pub const SYSTEM: &str = "You turn a reference video into a text prompt for an AI video model (such as Seedance 2.5). \
The model will NOT see the video: it generates a new video from your prompt and from reference images of another person, \
called @Image1. Your prompt must let it recreate the same action, timing, camera and setting.\n\
Write in English, with no preamble, no title and no markdown, in this order:\n\
1. One paragraph: the shot (one continuous take or the cuts), its length, the camera (static, handheld, pan, tilt, \
dolly, zoom, its height and distance), the framing, the setting and the light, then the outfit as the user's request \
says. Refer to the performer as \"the person from @Image1\" (or \"the woman / the man from @Image1\"), and say once \
that the other reference images show the same person: their face, hair and outfit come from all of them.\n\
2. The action as timed beats, one per line, like \"[0-4s] …\", covering the whole video without gaps. In each beat, \
describe the body precisely: where each hand and foot is, what it holds or touches, the direction the body faces, \
up or down, bent or straight, weight and balance, the speed and the rhythm of the movement, and how props react.\n\
3. One line on physics and realism: contacts and grips that must hold, what never touches the floor, no extra people.\n\
Never describe the face, hair, skin tone, age, ethnicity, body type or any identifying trait of the people in the \
video: identity comes only from @Image1. Ignore people who only pass in the background. Describe only what is visible. \
Stay under 2,500 characters.";

/// What the LLM is asked, with how to read the sheets in time.
pub fn request(sheets: &Sheets, notes: &str, video_outfit: bool) -> String {
    let mut text = format!(
        "The {n} attached image{s} {are} contact sheet{s} of a {d:.1}-second video. Each sheet is a grid of {c} columns × {r} rows, \
read left to right, then top to bottom; each tile is one frame, one every {step} seconds, starting at 0 s.",
        n = sheets.paths.len(),
        s = if sheets.paths.len() > 1 { "s" } else { "" },
        are = if sheets.paths.len() > 1 { "are" } else { "is" },
        d = sheets.duration,
        c = sheets.cols,
        r = sheets.rows,
        step = trim(sheets.step),
    );
    let per = (sheets.cols * sheets.rows) as f64;
    for i in 0..sheets.paths.len() {
        let from = i as f64 * per * sheets.step;
        let to = ((i as f64 + 1.0) * per - 1.0) * sheets.step;
        text.push_str(&format!(" Sheet {} covers {}–{} s.", i + 1, trim(from), trim(to.min(sheets.duration))));
    }
    text.push_str(if video_outfit {
        " Outfit: describe the clothes and shoes worn in the video precisely, as what the person from @Image1 wears."
    } else {
        " Outfit: do not describe the clothes or shoes worn in the video; write only that the person wears the outfit \
shown in the reference images, and when a beat depends on clothing, describe the body instead."
    });
    text.push_str(" Write the prompt.");
    if !notes.trim().is_empty() {
        text.push_str(&format!("\n\nThe user's notes, to follow: {}", notes.trim()));
    }
    text
}

fn trim(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_request_says_when_each_sheet_is() {
        let sheets = Sheets { paths: vec![PathBuf::from("a"), PathBuf::from("b")], step: 0.5, duration: 11.0, cols: 4, rows: 3 };
        let text = request(&sheets, "  keep the hoop  ", false);
        assert!(text.contains("2 attached images are contact sheets of a 11.0-second video"));
        assert!(text.contains("one every 0.5 seconds"));
        assert!(text.contains("Sheet 1 covers 0–5.5 s. Sheet 2 covers 6–11 s."));
        assert!(text.ends_with("follow: keep the hoop"));
        assert!(text.contains("do not describe the clothes"));
        assert!(request(&sheets, "", true).contains("describe the clothes and shoes worn in the video"));
    }
}
