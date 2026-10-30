//! fal account: API keys in the OS keychain, model prices and real spend
//! from fal's Platform API.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{header::AUTHORIZATION, Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};
use crate::models::{self, Category};

const KEYRING_SERVICE: &str = "com.simplenode.app";
const PLATFORM_URL: &str = "https://api.fal.ai/v1";
/// Max endpoint ids per pricing request, per fal's docs.
const PRICING_BATCH: usize = 50;
/// Endpoints used outside the registry (text helpers).
const EXTRA_ENDPOINTS: &[(&str, &str)] = &[("Video Describer", "fal-ai/video-understanding"), ("Seedance 2.5 Draft → 1080p", "bytedance/seedance-2.5/draft/complete")];

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum KeyKind {
    /// Runs models.
    Main,
    /// Optional, BILLING-scoped: reads spend.
    Billing,
}

impl KeyKind {
    fn user(self) -> &'static str {
        match self {
            KeyKind::Main => "fal",
            KeyKind::Billing => "fal-billing",
        }
    }
}

fn entry(kind: KeyKind) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, kind.user())?)
}

/// Keys read from the keychain, kept for the app's lifetime. macOS asks the
/// user each time an unknown binary reads the keychain, and dev rebuilds are
/// always unknown, so reading once per launch keeps that to one prompt.
fn cache() -> &'static Mutex<HashMap<KeyKind, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<KeyKind, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn stored(kind: KeyKind) -> Result<Option<String>> {
    if let Some(hit) = cache().lock().unwrap().get(&kind) {
        return Ok(hit.clone());
    }
    let key = match entry(kind)?.get_password() {
        Ok(key) => Some(key),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => return Err(err.into()),
    };
    cache().lock().unwrap().insert(kind, key.clone());
    Ok(key)
}

/// The keychain wins; `FAL_KEY` in the environment is a dev fallback.
pub fn main_key() -> Result<String> {
    match stored(KeyKind::Main)? {
        Some(key) => Ok(key),
        None => std::env::var("FAL_KEY").map_err(|_| AppError::MissingKey),
    }
}

/// Spend needs a BILLING-scoped key; fall back to the main key, which works
/// when it was created with the FULL preset.
fn billing_key() -> Result<String> {
    match stored(KeyKind::Billing)? {
        Some(key) => Ok(key),
        None => main_key(),
    }
}

pub fn set_key(kind: KeyKind, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        match entry(kind)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => return Err(err.into()),
        }
        cache().lock().unwrap().insert(kind, None);
        return Ok(());
    }
    entry(kind)?.set_password(key)?;
    cache().lock().unwrap().insert(kind, Some(key.to_owned()));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    /// "keychain", "env" or null.
    main: Option<&'static str>,
    billing: bool,
}

pub fn key_status() -> Result<KeyStatus> {
    let main = if stored(KeyKind::Main)?.is_some() {
        Some("keychain")
    } else if std::env::var("FAL_KEY").is_ok() {
        Some("env")
    } else {
        None
    };
    Ok(KeyStatus { main, billing: stored(KeyKind::Billing)?.is_some() })
}

async fn platform_get(http: &Client, key: &str, path: &str, query: &[(&str, String)]) -> Result<Value> {
    let res = http.get(format!("{PLATFORM_URL}{path}")).header(AUTHORIZATION, format!("Key {key}")).query(query).send().await?;
    match res.status() {
        s if s.is_success() => Ok(res.json().await?),
        StatusCode::UNAUTHORIZED => Err(AppError::Fal("clé refusée (invalide ou révoquée)".into())),
        StatusCode::FORBIDDEN => Err(AppError::Fal("cette clé n'a pas la permission requise".into())),
        s => {
            let body: Value = res.json().await.unwrap_or(Value::Null);
            Err(AppError::Fal(body["detail"].as_str().map(str::to_owned).unwrap_or_else(|| s.to_string())))
        }
    }
}

/// Validates a key with a cheap, read-only call.
pub async fn test_key(http: &Client, kind: KeyKind) -> Result<()> {
    let key = match kind {
        KeyKind::Main => main_key()?,
        KeyKind::Billing => stored(KeyKind::Billing)?.ok_or(AppError::MissingKey)?,
    };
    match kind {
        KeyKind::Main => platform_get(http, &key, "/models/pricing", &[("endpoint_id", "fal-ai/flux/schnell".into())]).await?,
        KeyKind::Billing => platform_get(http, &key, "/models/usage", &[("expand", "summary".into())]).await?,
    };
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    label: String,
    category: &'static str,
    /// "texte" or "image" (edit / image-to-video).
    mode: &'static str,
    endpoint: String,
    unit_price: Option<f64>,
    unit: Option<String>,
    currency: Option<String>,
}

fn category_name(c: Category) -> &'static str {
    match c {
        Category::Image => "image",
        Category::Video => "video",
        Category::Llm => "llm",
    }
}

pub async fn prices(http: &Client) -> Result<Vec<PriceRow>> {
    let key = main_key()?;
    let mut rows: Vec<PriceRow> = Vec::new();
    let mut push = |label: &str, category: &'static str, mode: &'static str, endpoint: &str| {
        // Draft and full Seedance 2.5 share endpoints; list each once.
        if !rows.iter().any(|r| r.endpoint == endpoint) {
            rows.push(PriceRow { label: label.into(), category, mode, endpoint: endpoint.into(), unit_price: None, unit: None, currency: None });
        }
    };
    for m in models::all() {
        if let Some(e) = m.text_endpoint {
            push(m.label, category_name(m.category), "texte", e);
        }
        if let Some(e) = m.edit_endpoint {
            push(m.label, category_name(m.category), "image", e);
        }
    }
    for (label, endpoint) in EXTRA_ENDPOINTS {
        push(label, "outil", "—", endpoint);
    }

    let mut found: HashMap<String, (f64, String, String)> = HashMap::new();
    for chunk in rows.chunks(PRICING_BATCH) {
        let query: Vec<(&str, String)> = chunk.iter().map(|r| ("endpoint_id", r.endpoint.clone())).collect();
        let body = platform_get(http, &key, "/models/pricing", &query).await?;
        for p in body["prices"].as_array().into_iter().flatten() {
            if let (Some(id), Some(price)) = (p["endpoint_id"].as_str(), p["unit_price"].as_f64()) {
                let unit = p["unit"].as_str().unwrap_or_default().to_owned();
                let currency = p["currency"].as_str().unwrap_or("USD").to_owned();
                found.insert(id.to_owned(), (price, unit, currency));
            }
        }
    }
    for row in &mut rows {
        if let Some((price, unit, currency)) = found.remove(&row.endpoint) {
            row.unit_price = Some(price);
            row.unit = Some(unit);
            row.currency = Some(currency);
        }
    }
    Ok(rows)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendRow {
    endpoint: String,
    /// Registry label when the endpoint belongs to this app.
    label: Option<String>,
    unit: String,
    quantity: f64,
    cost: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    since: String,
    total: f64,
    currency: String,
    rows: Vec<SpendRow>,
}

/// `YYYY-MM-DD` for a Unix day number (Howard Hinnant's civil-from-days).
fn civil_date(days_since_epoch: i64) -> String {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn label_for(endpoint: &str) -> Option<String> {
    models::all()
        .find(|m| m.text_endpoint == Some(endpoint) || m.edit_endpoint == Some(endpoint))
        .map(|m| m.label.to_owned())
        .or_else(|| EXTRA_ENDPOINTS.iter().find(|(_, e)| *e == endpoint).map(|(l, _)| (*l).to_owned()))
}

/// Real spend over the last `days` days (`days == 0`: since the 1st of this month, UTC).
pub async fn spend(http: &Client, days: u32) -> Result<Spend> {
    let key = billing_key()?;
    let today = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO).as_secs() as i64 / 86_400;
    let since = if days == 0 {
        let date = civil_date(today);
        format!("{}-01", &date[..7])
    } else {
        civil_date(today - i64::from(days))
    };
    let query = [("start", since.clone()), ("expand", "summary".into()), ("timezone", "UTC".into())];
    let body = platform_get(http, &key, "/models/usage", &query).await.map_err(|e| match e {
        AppError::Fal(msg) if msg.contains("permission") => AppError::Fal(
            "la clé n'a pas accès à la facturation. Créez une clé avec le preset BILLING (ou FULL) sur fal.ai et ajoutez-la comme clé de facturation".into(),
        ),
        other => other,
    })?;

    let mut rows: Vec<SpendRow> = Vec::new();
    let mut currency = "USD".to_owned();
    for item in body["summary"].as_array().into_iter().flatten() {
        let endpoint = item["endpoint_id"].as_str().unwrap_or_default().to_owned();
        let cost = item["cost_total"].as_f64().or_else(|| item["cost"].as_f64()).unwrap_or_default();
        let quantity = item["quantity"].as_f64().unwrap_or_default();
        let unit = item["unit"].as_str().unwrap_or_default().to_owned();
        if let Some(c) = item["currency"].as_str() {
            currency = c.to_owned();
        }
        // Discount tiers come back as separate rows; merge them per endpoint and unit.
        match rows.iter_mut().find(|r| r.endpoint == endpoint && r.unit == unit) {
            Some(row) => {
                row.cost += cost;
                row.quantity += quantity;
            }
            None => rows.push(SpendRow { label: label_for(&endpoint), endpoint, unit, quantity, cost }),
        }
    }
    rows.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    let total = rows.iter().map(|r| r.cost).sum();
    Ok(Spend { since, total, currency, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_date_matches_known_days() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(19_723), "2024-01-01");
        assert_eq!(civil_date(20_754), "2026-10-28");
    }
}
