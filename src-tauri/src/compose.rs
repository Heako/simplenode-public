//! "Compositor" node: images, videos and sounds stacked as layers on a
//! canvas, each placed, sized and, in timeline mode, timed. Rendered locally
//! with ffmpeg, so it costs nothing on fal and uploads nothing.

use std::path::{Path, PathBuf};

use futures::future::try_join_all;
use serde::Deserialize;
use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::storage;

/// Layer inputs a node may have, besides its background.
pub const MAX_LAYERS: usize = 12;
const FPS: u32 = 30;
/// Fade every sound gets at both ends, too short to hear: cutting a wave
/// mid-cycle is what clicks.
const ANTI_CLICK: f64 = 0.02;
/// Overlap of a looped sound with its next repetition, so the seam doesn't jump.
const LOOP_CROSSFADE: f64 = 1.0;
/// Length of a video made of images only, when nothing sets one.
const STILL_SECONDS: f64 = 5.0;

/// How the user placed one layer, in canvas pixels and seconds. Unset fields
/// fall back to defaults: the background covers the canvas, other layers fit
/// in it, centered; everything starts at 0 and lasts as long as its media.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Placement {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    /// 0 to 1.
    pub opacity: Option<f64>,
    /// Timeline mode only.
    pub start: Option<f64>,
    pub duration: Option<f64>,
    /// 0 to 2; sound of videos and audio layers.
    pub volume: Option<f64>,
    /// Seconds over which picture and sound fade in from nothing, and out.
    pub fade_in: Option<f64>,
    pub fade_out: Option<f64>,
    /// Sounds and videos: repeated to fill their duration, or the result.
    #[serde(rename = "loop")]
    pub repeat: bool,
    pub hidden: bool,
}

pub struct Layer {
    pub value: String,
    pub place: Placement,
    /// The background: covers the canvas by default, where layers fit in it.
    pub cover: bool,
}

pub struct Canvas {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub timeline: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Image,
    Video,
    Audio,
}

#[derive(Clone, Debug)]
struct Probe {
    kind: Kind,
    width: u32,
    height: u32,
    duration: Option<f64>,
    audio: bool,
}

/// ffmpeg and ffprobe: apps started from the Finder don't get Homebrew's PATH.
fn tool(name: &str) -> Result<PathBuf> {
    let dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].into_iter().map(PathBuf::from);
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    dirs.chain(path_dirs)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| AppError::Invalid(format!("{name} not found: install it with `brew install ffmpeg`")))
}

fn kind_of(value: &str) -> Result<Kind> {
    let path = value.split(['?', '#']).next().unwrap_or(value);
    let mime = storage::mime_for(&storage::extension(Path::new(path))).unwrap_or_default();
    match mime.split('/').next() {
        Some("image") => Ok(Kind::Image),
        Some("video") => Ok(Kind::Video),
        Some("audio") => Ok(Kind::Audio),
        _ => Err(AppError::Invalid(format!("Media not supported by the compositor: {value}"))),
    }
}

async fn probe(value: &str) -> Result<Probe> {
    let kind = kind_of(value)?;
    let out = tokio::process::Command::new(tool("ffprobe")?)
        .args(["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", value])
        .kill_on_drop(true)
        .output()
        .await?;
    if !out.status.success() {
        return Err(AppError::Invalid(format!("Unreadable media: {value}")));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let picture = streams.iter().find(|s| s["codec_type"] == "video");
    let size = |key: &str| picture.and_then(|s| s[key].as_u64()).unwrap_or(0) as u32;
    let duration = json["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).filter(|d| *d > 0.0);
    Ok(Probe {
        kind,
        width: size("width"),
        height: size("height"),
        duration: if kind == Kind::Image { None } else { duration },
        audio: streams.iter().any(|s| s["codec_type"] == "audio"),
    })
}

fn even(n: f64) -> u32 {
    ((n.round() as u32).max(2) / 2) * 2
}

fn num(v: f64) -> String {
    if v.abs() < 0.0005 {
        return "0".to_owned();
    }
    format!("{:.3}", v).trim_end_matches('0').trim_end_matches('.').to_owned()
}

/// The ffmpeg arguments that render `layers` (bottom first) into `out`, and
/// whether the result is a video; a still otherwise.
fn plan(canvas: &Canvas, layers: &[(&Layer, Probe)], out: &Path) -> (Vec<String>, bool) {
    let visual = |p: &Probe| p.kind != Kind::Audio && p.width > 0;
    let (cw, ch) = match (canvas.width, canvas.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (even(w as f64), even(h as f64)),
        _ => layers
            .iter()
            .find(|(_, p)| visual(p))
            .map(|(_, p)| (even(p.width as f64), even(p.height as f64)))
            .unwrap_or((1024, 1024)),
    };

    // Repeated to fill their time: sounds and videos whose length is known.
    let looped: Vec<bool> = layers.iter().map(|(l, p)| l.place.repeat && p.kind != Kind::Image && p.duration.is_some()).collect();
    // The duration the user set, in timeline mode.
    let wanted: Vec<Option<f64>> = layers.iter().map(|(l, _)| if canvas.timeline { l.place.duration.filter(|d| *d > 0.0) } else { None }).collect();
    // When each layer shows, and for how long (None: as long as the result).
    let mut timing: Vec<(f64, Option<f64>)> = layers
        .iter()
        .enumerate()
        .map(|(i, (l, p))| {
            let start = if canvas.timeline { l.place.start.unwrap_or(0.0).max(0.0) } else { 0.0 };
            let len = match (wanted[i], p.duration) {
                (w, _) if looped[i] => w,
                // A medium never plays longer than it lasts.
                (Some(w), Some(d)) => Some(w.min(d)),
                (w, d) => w.or(d),
            };
            (start, len)
        })
        .collect();
    let mut total = timing.iter().filter_map(|(s, len)| len.map(|l| s + l)).fold(0.0, f64::max);
    if total == 0.0 {
        // Only loops without a duration: they play once.
        total = layers.iter().zip(&timing).filter_map(|((_, p), (s, _))| p.duration.map(|d| s + d)).fold(0.0, f64::max);
    }
    // Loops without a duration fill the result.
    for (i, t) in timing.iter_mut().enumerate() {
        if looped[i] && t.1.is_none() {
            t.1 = Some((total - t.0).max(0.0));
        }
    }
    let moving = layers.iter().any(|(_, p)| p.kind != Kind::Image);
    let video = moving || (canvas.timeline && total > 0.0);
    let total = if total > 0.0 { total } else { STILL_SECONDS };

    let s = |v: &str| v.to_owned();
    let mut args = vec![s("-y"), s("-v"), s("error"), s("-f"), s("lavfi"), s("-i")];
    args.push(if video {
        format!("color=c=black:s={cw}x{ch}:r={FPS}:d={}", num(total))
    } else {
        format!("color=c=black@0.0:s={cw}x{ch},format=rgba")
    });
    let mut filters = Vec::new();
    let mut audio = Vec::new();
    let mut last = s("[0:v]");

    for (i, ((layer, probe), (start, len))) in layers.iter().zip(&timing).enumerate() {
        let k = i + 1;
        if probe.kind == Kind::Image && video {
            args.extend([s("-loop"), s("1"), s("-framerate"), FPS.to_string(), s("-t"), num(total)]);
        }
        if looped[i] && probe.kind == Kind::Video {
            args.extend([s("-stream_loop"), s("-1")]);
        }
        args.extend([s("-i"), layer.value.clone()]);
        let place = &layer.place;
        // Cut when the user set a duration, or when it loops.
        let trimmed = if looped[i] || wanted[i].is_some() { *len } else { None };
        // In the result's time; fades never take more than half the layer.
        let end = len.map(|l| start + l).unwrap_or(total);
        let half = (end - start).max(0.0) / 2.0;
        let fade_in = place.fade_in.unwrap_or(0.0).clamp(0.0, half);
        let fade_out = place.fade_out.unwrap_or(0.0).clamp(0.0, half);

        if visual(probe) {
            let mut chain = Vec::new();
            if probe.kind == Kind::Video {
                if let Some(d) = trimmed {
                    chain.push(format!("trim=duration={}", num(d)));
                }
                chain.push(s("setpts=PTS-STARTPTS"));
            }
            match (place.w, place.h) {
                (Some(w), Some(h)) if w >= 1.0 && h >= 1.0 => chain.push(format!("scale={}:{}", w.round(), h.round())),
                _ if layer.cover => chain.push(format!("scale={cw}:{ch}:force_original_aspect_ratio=increase,crop={cw}:{ch}")),
                _ => chain.push(format!("scale={cw}:{ch}:force_original_aspect_ratio=decrease")),
            }
            chain.push(s("format=rgba"));
            let opacity = place.opacity.unwrap_or(1.0).clamp(0.0, 1.0);
            if opacity < 1.0 {
                chain.push(format!("colorchannelmixer=aa={}", num(opacity)));
            }
            if probe.kind == Kind::Video && *start > 0.0 {
                chain.push(format!("setpts=PTS+{}/TB", num(*start)));
            }
            if video && fade_in > 0.0 {
                chain.push(format!("fade=t=in:st={}:d={}:alpha=1", num(*start), num(fade_in)));
            }
            if video && fade_out > 0.0 {
                chain.push(format!("fade=t=out:st={}:d={}:alpha=1", num(end - fade_out), num(fade_out)));
            }
            filters.push(format!("[{k}:v]{}[v{k}]", chain.join(",")));
            let x = place.x.map(|x| num(x.round())).unwrap_or_else(|| s("(main_w-overlay_w)/2"));
            let y = place.y.map(|y| num(y.round())).unwrap_or_else(|| s("(main_h-overlay_h)/2"));
            let enable = if canvas.timeline && video {
                format!(":enable='between(t,{},{})'", num(*start), num(end))
            } else {
                String::new()
            };
            // A still keeps the transparency of its layers.
            let format = if video { "" } else { ":format=auto" };
            filters.push(format!("{last}[v{k}]overlay=x={x}:y={y}:eof_action=pass{format}{enable}[o{k}]"));
            last = format!("[o{k}]");
        }

        let volume = place.volume.unwrap_or(1.0).clamp(0.0, 2.0);
        if video && probe.audio && volume > 0.0 {
            // A looped sound: copies end to end, each fading into the next.
            let mut source = format!("[{k}:a]");
            if let (true, Kind::Audio, Some(once), Some(length)) = (looped[i], probe.kind, probe.duration, *len) {
                if length > once {
                    let xf = LOOP_CROSSFADE.min(once / 4.0);
                    let n = (((length - xf) / (once - xf)).ceil() as usize).clamp(2, 500);
                    let copies: String = (0..n).map(|j| format!("[c{k}_{j}]")).collect();
                    filters.push(format!("[{k}:a]asplit={n}{copies}"));
                    let mut joined = format!("[c{k}_0]");
                    for j in 1..n {
                        filters.push(format!("{joined}[c{k}_{j}]acrossfade=d={}:c1=tri:c2=tri[j{k}_{j}]", num(xf)));
                        joined = format!("[j{k}_{j}]");
                    }
                    source = joined;
                }
            }
            let mut chain = Vec::new();
            if let Some(d) = trimmed {
                chain.push(format!("atrim=duration={}", num(d)));
            }
            chain.push(s("asetpts=PTS-STARTPTS"));
            if *start > 0.0 {
                chain.push(format!("adelay={}:all=1", (start * 1000.0).round()));
            }
            let (fade_in, fade_out) = (fade_in.max(ANTI_CLICK.min(half)), fade_out.max(ANTI_CLICK.min(half)));
            chain.push(format!("afade=t=in:st={}:d={}", num(*start), num(fade_in)));
            chain.push(format!("afade=t=out:st={}:d={}", num(end - fade_out), num(fade_out)));
            if volume != 1.0 {
                chain.push(format!("volume={}", num(volume)));
            }
            filters.push(format!("{source}{}[a{k}]", chain.join(",")));
            audio.push(format!("[a{k}]"));
        }
    }

    let out = out.to_string_lossy().into_owned();
    if video {
        filters.push(format!("{last}format=yuv420p[vout]"));
        if !audio.is_empty() {
            filters.push(format!("{}amix=inputs={}:duration=longest:normalize=0[aout]", audio.concat(), audio.len()));
        }
        args.extend([s("-filter_complex"), filters.join(";"), s("-map"), s("[vout]")]);
        if !audio.is_empty() {
            args.extend([s("-map"), s("[aout]"), s("-c:a"), s("aac"), s("-b:a"), s("192k")]);
        }
        args.extend([
            s("-t"),
            num(total),
            s("-r"),
            FPS.to_string(),
            s("-c:v"),
            s("libx264"),
            s("-preset"),
            s("veryfast"),
            s("-crf"),
            s("18"),
            s("-movflags"),
            s("+faststart"),
            out,
        ]);
    } else {
        filters.push(format!("{last}format=rgba[vout]"));
        args.extend([s("-filter_complex"), filters.join(";"), s("-map"), s("[vout]"), s("-frames:v"), s("1"), out]);
    }
    (args, video)
}

/// Renders the layers, bottom first, into a new file in app storage.
pub async fn render(app: &AppHandle, canvas: &Canvas, layers: &[Layer]) -> Result<PathBuf> {
    let shown: Vec<&Layer> = layers.iter().filter(|l| !l.place.hidden).collect();
    if shown.is_empty() {
        return Err(AppError::Invalid("Connect at least one image, video or sound".into()));
    }
    let probes = try_join_all(shown.iter().map(|l| probe(&l.value))).await?;
    let pairs: Vec<(&Layer, Probe)> = shown.into_iter().zip(probes).collect();
    // The extension decides the format; plan again once it is known.
    let (_, video) = plan(canvas, &pairs, Path::new("out"));
    let out = storage::new_path(app, if video { "mp4" } else { "png" })?;
    let (args, _) = plan(canvas, &pairs, &out);
    let result = tokio::process::Command::new(tool("ffmpeg")?).args(&args).kill_on_drop(true).output().await?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&out);
        let log = String::from_utf8_lossy(&result.stderr);
        let tail: Vec<&str> = log.lines().rev().take(3).collect();
        return Err(AppError::Invalid(format!("ffmpeg: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" "))));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(value: &str, cover: bool, place: Placement) -> Layer {
        Layer { value: value.into(), place, cover }
    }
    fn image(w: u32, h: u32) -> Probe {
        Probe { kind: Kind::Image, width: w, height: h, duration: None, audio: false }
    }
    fn clip(w: u32, h: u32, d: f64) -> Probe {
        Probe { kind: Kind::Video, width: w, height: h, duration: Some(d), audio: true }
    }
    fn arg_after<'a>(args: &'a [String], flag: &str) -> &'a str {
        let i = args.iter().position(|a| a == flag).unwrap();
        &args[i + 1]
    }
    const FREE: Canvas = Canvas { width: None, height: None, timeline: false };

    #[test]
    fn images_only_make_a_still_the_size_of_the_background() {
        let (bg, logo) = (layer("bg.png", true, Placement::default()), layer("logo.png", false, Placement::default()));
        let (args, video) = plan(&FREE, &[(&bg, image(1001, 800)), (&logo, image(200, 200))], Path::new("o.png"));
        assert!(!video);
        assert!(args.contains(&"color=c=black@0.0:s=1000x800,format=rgba".to_owned()));
        assert_eq!(arg_after(&args, "-frames:v"), "1");
    }

    #[test]
    fn a_video_layer_sets_the_length_and_keeps_its_sound() {
        let bg = layer("bg.png", true, Placement::default());
        let v = layer("v.mp4", false, Placement { x: Some(10.0), y: Some(20.0), w: Some(300.0), h: Some(200.0), ..Default::default() });
        let (args, video) = plan(&FREE, &[(&bg, image(1280, 720)), (&v, clip(640, 360, 7.5))], Path::new("o.mp4"));
        assert!(video);
        assert_eq!(arg_after(&args, "-t"), "7.5");
        let graph = arg_after(&args, "-filter_complex");
        assert!(graph.contains("scale=300:200"), "{graph}");
        assert!(graph.contains("overlay=x=10:y=20"), "{graph}");
        assert!(graph.contains("amix=inputs=1"), "{graph}");
    }

    #[test]
    fn timeline_layers_follow_each_other() {
        let tl = Canvas { width: Some(720), height: Some(1280), timeline: true };
        let a = layer("a.mp4", false, Placement { start: Some(0.0), duration: Some(4.0), ..Default::default() });
        let b = layer("b.mp4", false, Placement { start: Some(4.0), ..Default::default() });
        let (args, _) = plan(&tl, &[(&a, clip(720, 1280, 10.0)), (&b, clip(720, 1280, 6.0))], Path::new("o.mp4"));
        assert_eq!(arg_after(&args, "-t"), "10");
        let graph = arg_after(&args, "-filter_complex");
        assert!(graph.contains("trim=duration=4"), "{graph}");
        assert!(graph.contains("setpts=PTS+4/TB"), "{graph}");
        assert!(graph.contains("adelay=4000:all=1"), "{graph}");
        assert!(graph.contains("enable='between(t,4,10)'"), "{graph}");
    }

    #[test]
    fn numbers_are_never_empty() {
        assert_eq!(num(0.0), "0");
        assert_eq!(num(-0.0001), "0");
        assert_eq!(num(2.5), "2.5");
        assert_eq!(num(10.0), "10");
    }

    #[test]
    fn sounds_fade_and_never_click() {
        let tl = Canvas { width: Some(100), height: Some(100), timeline: true };
        let a = layer("a.mp4", false, Placement { start: Some(2.0), duration: Some(4.0), fade_out: Some(1.0), ..Default::default() });
        let (args, _) = plan(&tl, &[(&a, clip(100, 100, 10.0))], Path::new("o.mp4"));
        let graph = arg_after(&args, "-filter_complex");
        assert!(graph.contains("afade=t=in:st=2:d=0.02"), "{graph}");
        assert!(graph.contains("afade=t=out:st=5:d=1"), "{graph}");
        assert!(graph.contains("fade=t=out:st=5:d=1:alpha=1"), "{graph}");
    }

    #[test]
    fn a_short_sound_loops_to_the_end_of_the_video() {
        let tl = Canvas { width: Some(100), height: Some(100), timeline: true };
        let v = layer("v.mp4", false, Placement::default());
        let music = layer("m.mp3", false, Placement { repeat: true, ..Default::default() });
        let music_probe = Probe { kind: Kind::Audio, width: 0, height: 0, duration: Some(15.0), audio: true };
        let (args, _) = plan(&tl, &[(&v, clip(100, 100, 59.5)), (&music, music_probe.clone())], Path::new("o.mp4"));
        assert_eq!(arg_after(&args, "-t"), "59.5");
        let graph = arg_after(&args, "-filter_complex");
        // 15 s copies overlapping by 1 s: five of them cover 59.5 s.
        assert!(graph.contains("asplit=5"), "{graph}");
        assert!(graph.contains("atrim=duration=59.5"), "{graph}");

        // Not looped: a longer duration asked of it doesn't stretch it.
        let short = layer("m.mp3", false, Placement { duration: Some(48.8), ..Default::default() });
        let (args, _) = plan(&tl, &[(&short, music_probe)], Path::new("o.mp4"));
        assert!(arg_after(&args, "-filter_complex").contains("atrim=duration=15"));
    }

    #[test]
    fn muted_and_hidden_layers_add_nothing() {
        let v = layer("v.mp4", true, Placement { volume: Some(0.0), ..Default::default() });
        let (args, _) = plan(&FREE, &[(&v, clip(640, 360, 3.0))], Path::new("o.mp4"));
        assert!(!args.contains(&"[aout]".to_owned()));
    }
}

/// Runs the real ffmpeg on generated media: `cargo test compose -- --ignored`.
#[cfg(test)]
mod ffmpeg_tests {
    use super::*;

    fn run(args: &[String]) {
        let out = std::process::Command::new(tool("ffmpeg").unwrap()).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    #[ignore]
    fn renders_a_video_and_a_still() {
        let dir = std::env::temp_dir().join(format!("compose-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        let gen = |args: &str| run(&args.split(' ').map(String::from).collect::<Vec<_>>());
        gen(&format!("-y -v error -f lavfi -i testsrc=s=640x360:d=3:r=30 -f lavfi -i sine=d=3 -shortest -pix_fmt yuv420p {}", p("clip.mp4")));
        gen(&format!("-y -v error -f lavfi -i color=c=red:s=200x100 -frames:v 1 {}", p("logo.png")));
        gen(&format!("-y -v error -f lavfi -i sine=f=880:d=2 {}", p("beep.wav")));

        let block = tauri::async_runtime::block_on;
        let bg = Layer { value: p("clip.mp4"), place: Placement::default(), cover: true };
        let logo = Layer { value: p("logo.png"), place: Placement { x: Some(20.0), y: Some(20.0), opacity: Some(0.5), ..Default::default() }, cover: false };
        let beep = Layer { value: p("beep.wav"), place: Placement { start: Some(4.0), ..Default::default() }, cover: false };
        let layers = [&bg, &logo, &beep];
        let probes: Vec<Probe> = layers.iter().map(|l| block(probe(&l.value)).unwrap()).collect();
        let pairs: Vec<(&Layer, Probe)> = layers.into_iter().zip(probes.clone()).collect();

        let tl = Canvas { width: Some(720), height: Some(1280), timeline: true };
        let (args, video) = plan(&tl, &pairs, &dir.join("out.mp4"));
        assert!(video);
        run(&args);
        let out = block(probe(&p("out.mp4"))).unwrap();
        assert_eq!((out.width, out.height), (720, 1280));
        assert!((out.duration.unwrap() - 6.0).abs() < 0.2, "{:?}", out.duration);
        assert!(out.audio);

        let stills = [(&logo, probes[1].clone())];
        let (args, video) = plan(&FREE_CANVAS, &stills, &dir.join("out.png"));
        assert!(!video);
        run(&args);
        assert!(dir.join("out.png").is_file());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    #[ignore]
    fn loops_a_short_sound_over_a_longer_video() {
        let dir = std::env::temp_dir().join(format!("compose-loop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        let gen = |args: &str| run(&args.split(' ').map(String::from).collect::<Vec<_>>());
        gen(&format!("-y -v error -f lavfi -i testsrc=s=320x240:d=10:r=30 -pix_fmt yuv420p {}", p("clip.mp4")));
        gen(&format!("-y -v error -f lavfi -i sine=f=440:d=3 {}", p("tone.mp3")));
        let block = tauri::async_runtime::block_on;
        let v = Layer { value: p("clip.mp4"), place: Placement::default(), cover: true };
        let tone = Layer { value: p("tone.mp3"), place: Placement { repeat: true, ..Default::default() }, cover: false };
        let pairs: Vec<(&Layer, Probe)> = [&v, &tone].into_iter().map(|l| (l, block(probe(&l.value)).unwrap())).collect();
        let tl = Canvas { width: None, height: None, timeline: true };
        let (args, _) = plan(&tl, &pairs, &dir.join("out.mp4"));
        run(&args);
        // The sound runs to the end of the video.
        let out = std::process::Command::new(tool("ffprobe").unwrap())
            .args(["-v", "error", "-select_streams", "a", "-show_entries", "stream=duration", "-of", "csv=p=0", &p("out.mp4")])
            .output()
            .unwrap();
        let audio: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        assert!((audio - 10.0).abs() < 0.2, "{audio}");
        std::fs::remove_dir_all(dir).ok();
    }

    const FREE_CANVAS: Canvas = Canvas { width: Some(300), height: Some(300), timeline: false };
}
