//! Model settings read from fal's published OpenAPI schema of each endpoint,
//! so the inspector shows every setting a model takes without hand-written
//! lists. Schemas are fetched once per endpoint and cached for the session.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::error::{AppError, Result};

const SCHEMA_URL: &str = "https://fal.ai/api/openapi/queue/openapi.json";

/// Inputs the app fills itself (prompt, references, ...) or that would cost
/// without being used (extra images the node doesn't show).
const MANAGED: &[&str] = &[
    "prompt",
    "negative_prompt",
    "system_prompt",
    "image_url",
    "image_urls",
    "start_image_url",
    "end_image_url",
    "tail_image_url",
    "video_url",
    "video_urls",
    "audio_url",
    "audio_urls",
    "mask_url",
    "sync_mode",
    "num_images",
    "max_images",
    "draft",
    "model",
    // Identifiers, not settings.
    "end_user_id",
    "voice_id",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SettingKind {
    Select,
    Toggle,
    Integer,
    Number,
    Text,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub key: String,
    pub label: String,
    pub kind: SettingKind,
    pub options: Vec<String>,
    /// Select options are numbers on the wire.
    pub numeric_options: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub default: Option<String>,
    pub description: Option<String>,
}

fn cache() -> &'static Mutex<HashMap<String, Vec<Setting>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<Setting>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Settings of `endpoint`, from cache or fal.
pub async fn settings(http: &Client, endpoint: &str) -> Result<Vec<Setting>> {
    if let Some(hit) = cache().lock().unwrap().get(endpoint) {
        return Ok(hit.clone());
    }
    let res = http.get(SCHEMA_URL).query(&[("endpoint_id", endpoint)]).send().await?;
    if !res.status().is_success() {
        return Err(AppError::Fal(format!("schéma introuvable pour {endpoint}")));
    }
    let parsed = parse(&res.json().await?);
    cache().lock().unwrap().insert(endpoint.to_owned(), parsed.clone());
    Ok(parsed)
}

/// Every alternative a property allows, with `$ref`s resolved and `null` dropped.
fn variants<'a>(schema: &'a Value, components: &'a Value, out: &mut Vec<&'a Value>) {
    if let Some(r) = schema["$ref"].as_str() {
        if let Some(target) = r.rsplit('/').next().and_then(|name| components.get(name)) {
            variants(target, components, out);
        }
        return;
    }
    let mut nested = false;
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(list) = schema[key].as_array() {
            nested = true;
            for v in list {
                variants(v, components, out);
            }
        }
    }
    if !nested && schema["type"] != "null" {
        out.push(schema);
    }
}

fn label(key: &str, prop: &Value) -> String {
    prop["title"].as_str().map(str::to_owned).unwrap_or_else(|| {
        let mut s = key.replace('_', " ");
        if let Some(first) = s.get(..1) {
            s.replace_range(..1, &first.to_uppercase());
        }
        s
    })
}

fn as_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The schema the endpoint's POST body uses. A document can hold several
/// `…Input` components (nested element types), so follow the request's `$ref`
/// and fall back to the first `…Input` only when there's none.
fn request_schema(doc: &Value) -> Option<&Value> {
    let components = &doc["components"]["schemas"];
    let referenced = doc["paths"].as_object().and_then(|paths| {
        paths.values().find_map(|item| {
            let r = item["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"].as_str()?;
            components.get(r.rsplit('/').next()?)
        })
    });
    referenced.or_else(|| components.as_object()?.iter().find(|(name, _)| name.ends_with("Input")).map(|(_, v)| v))
}

pub fn parse(doc: &Value) -> Vec<Setting> {
    let components = &doc["components"]["schemas"];
    let Some(input) = request_schema(doc) else {
        return Vec::new();
    };
    let Some(props) = input["properties"].as_object() else { return Vec::new() };

    let mut settings = Vec::new();
    for (key, prop) in props {
        // Media URLs are wired through ports, not typed in.
        if MANAGED.contains(&key.as_str()) || key.ends_with("_url") || key.ends_with("_urls") {
            continue;
        }
        let mut alts = Vec::new();
        variants(prop, components, &mut alts);

        // Enumerations (a `const` is a one-value enum).
        let mut options: Vec<String> = Vec::new();
        let mut numeric_options = false;
        for alt in &alts {
            let values = alt["enum"].as_array().cloned().or_else(|| alt.get("const").map(|c| vec![c.clone()]));
            for v in values.into_iter().flatten() {
                numeric_options |= v.is_number();
                if let Some(t) = as_text(&v) {
                    if !options.contains(&t) {
                        options.push(t);
                    }
                }
            }
        }
        let typed = |t: &str| alts.iter().find(|a| a["type"] == t).copied();
        let (kind, bounds) = if !options.is_empty() {
            (SettingKind::Select, None)
        } else if typed("boolean").is_some() {
            (SettingKind::Toggle, None)
        } else if let Some(a) = typed("integer") {
            (SettingKind::Integer, Some(a))
        } else if let Some(a) = typed("number") {
            (SettingKind::Number, Some(a))
        } else if typed("string").is_some() {
            (SettingKind::Text, None)
        } else {
            continue; // arrays, objects: not editable here
        };

        settings.push(Setting {
            key: key.clone(),
            label: label(key, prop),
            kind,
            options,
            numeric_options,
            min: bounds.and_then(|b| b["minimum"].as_f64()),
            max: bounds.and_then(|b| b["maximum"].as_f64()),
            default: as_text(&prop["default"]),
            description: prop["description"].as_str().map(|d| d.trim().to_owned()),
        });
    }
    settings
}

/// Node values for `x:<key>` params, typed for the endpoint. Keys the endpoint
/// doesn't declare and empty values are left out.
pub fn extras(settings: &[Setting], params: &HashMap<String, String>) -> Map<String, Value> {
    let mut out = Map::new();
    for s in settings {
        let Some(raw) = params.get(&format!("x:{}", s.key)).map(|v| v.trim()).filter(|v| !v.is_empty()) else {
            continue;
        };
        let value = match s.kind {
            SettingKind::Toggle => json!(raw == "true"),
            SettingKind::Integer => match raw.parse::<i64>() {
                Ok(n) => json!(n),
                Err(_) => continue,
            },
            SettingKind::Number => match raw.parse::<f64>() {
                Ok(n) => json!(n),
                Err(_) => continue,
            },
            SettingKind::Select if s.numeric_options => match raw.parse::<f64>() {
                Ok(n) if n.fract() == 0.0 => json!(n as i64),
                Ok(n) => json!(n),
                Err(_) => continue,
            },
            SettingKind::Select if !s.options.iter().any(|o| o == raw) => continue,
            SettingKind::Select | SettingKind::Text => json!(raw),
        };
        out.insert(s.key.clone(), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Value {
        json!({ "components": { "schemas": {
            "Size": { "enum": ["square", "landscape"] },
            "ModelInput": { "properties": {
                "prompt": { "type": "string" },
                "rendering_speed": { "type": "string", "enum": ["TURBO", "BALANCED"], "default": "BALANCED", "title": "Rendering Speed" },
                "image_size": { "anyOf": [{ "$ref": "#/components/schemas/Size" }, { "type": "null" }] },
                "seed": { "anyOf": [{ "type": "integer" }, { "type": "null" }], "title": "Seed" },
                "cfg_scale": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.5 },
                "fps": { "enum": [24, 25] },
                "enable_prompt_expansion": { "type": "boolean", "default": true },
                "thinking_level": { "anyOf": [{ "type": "string", "const": "high" }, { "type": "null" }] },
                "history": { "type": "array", "items": {} }
            }}
        }}})
    }

    #[test]
    fn parses_settings_and_skips_managed_and_arrays() {
        let s = parse(&doc());
        let keys: Vec<_> = s.iter().map(|x| x.key.as_str()).collect();
        assert!(!keys.contains(&"prompt") && !keys.contains(&"history"));
        let find = |k: &str| s.iter().find(|x| x.key == k).unwrap();
        assert_eq!(find("rendering_speed").kind, SettingKind::Select);
        assert_eq!(find("image_size").options, ["square", "landscape"]);
        assert_eq!(find("seed").kind, SettingKind::Integer);
        assert_eq!((find("cfg_scale").min, find("cfg_scale").max), (Some(0.0), Some(1.0)));
        assert!(find("fps").numeric_options);
        assert_eq!(find("enable_prompt_expansion").kind, SettingKind::Toggle);
        assert_eq!(find("thinking_level").options, ["high"]);
        assert_eq!(find("cfg_scale").label, "Cfg scale");
    }

    #[test]
    fn extras_are_typed_and_filtered() {
        let s = parse(&doc());
        let params = HashMap::from([
            ("x:seed".to_owned(), "42".to_owned()),
            ("x:cfg_scale".to_owned(), "0.7".to_owned()),
            ("x:fps".to_owned(), "25".to_owned()),
            ("x:enable_prompt_expansion".to_owned(), "false".to_owned()),
            ("x:rendering_speed".to_owned(), "NOPE".to_owned()),
            ("x:unknown".to_owned(), "1".to_owned()),
            ("x:image_size".to_owned(), "".to_owned()),
        ]);
        let x = extras(&s, &params);
        assert_eq!(x["seed"], json!(42));
        assert_eq!(x["cfg_scale"], json!(0.7));
        assert_eq!(x["fps"], json!(25));
        assert_eq!(x["enable_prompt_expansion"], json!(false));
        assert!(!x.contains_key("rendering_speed") && !x.contains_key("unknown") && !x.contains_key("image_size"));
    }
}

/// Parses real schemas saved in `$SCHEMA_DIR` (one fal OpenAPI JSON per file).
/// Run with: SCHEMA_DIR=… cargo test schema::live -- --ignored --nocapture
#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn every_saved_schema_yields_settings() {
        let dir = std::env::var("SCHEMA_DIR").expect("SCHEMA_DIR");
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let doc: serde_json::Value = serde_json::from_slice(&std::fs::read(e.path()).unwrap()).unwrap();
            let s = super::parse(&doc);
            let keys: Vec<_> = s.iter().map(|x| format!("{}:{:?}", x.key, x.kind).to_lowercase()).collect();
            println!("{:<55} {:>2}  {}", e.file_name().to_string_lossy().trim_end_matches(".json"), s.len(), keys.join(" "));
        }
    }
}
