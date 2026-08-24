use chrono::{DateTime, Duration as ChronoDuration, Utc};
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};
use url::Url;

use crate::model_manager;

const HUB_BASE_URL: &str = "https://huggingface.co/";
const HUB_LIST_PATH: &str = "api/models";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_DETAIL_REQUESTS: usize = 8;
const MAX_RESULTS: usize = 5;
const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelCandidate {
    pub id: String,
    pub label: String,
    pub revision: String,
    pub last_modified: String,
    pub downloads: u64,
    pub likes: u64,
    pub download_bytes: u64,
    pub required_memory_bytes: u64,
    pub license: String,
    pub model_type: String,
    pub fit: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelDiscovery {
    pub fetched_at: String,
    pub source: String,
    pub memory_bytes: u64,
    pub free_disk_bytes: u64,
    pub candidates: Vec<LocalModelCandidate>,
}

#[derive(Debug, Deserialize)]
struct HubModel {
    id: String,
    sha: Option<String>,
    #[serde(rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default)]
    disabled: Option<bool>,
    #[serde(rename = "pipeline_tag")]
    pipeline_tag: Option<String>,
    #[serde(rename = "library_name")]
    library_name: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    config: Option<HubConfig>,
    #[serde(default)]
    siblings: Vec<HubSibling>,
}

#[derive(Debug, Deserialize)]
struct HubConfig {
    #[serde(rename = "model_type")]
    model_type: Option<String>,
    #[serde(rename = "quantization_config")]
    quantization_config: Option<HubQuantization>,
}

#[derive(Debug, Deserialize)]
struct HubQuantization {
    bits: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct HubSibling {
    size: Option<u64>,
}

pub fn discover_local_models(app_data_dir: &Path) -> Result<LocalModelDiscovery, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(REQUEST_TIMEOUT)
        .redirect(Policy::none())
        .no_proxy()
        .user_agent(concat!("CodelitMac/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Codelit could not prepare local model discovery.".to_string())?;
    let deadline = Instant::now() + DISCOVERY_TIMEOUT;
    let models: Vec<HubModel> = read_json(
        client.get(list_url()?).timeout(remaining(deadline)?),
        "Codelit could not check the live MLX catalog.",
    )?;
    let (memory_bytes, free_disk_bytes) = model_manager::machine_capacity(app_data_dir);
    let cutoff = Utc::now() - ChronoDuration::days(550);
    let mut candidates = Vec::new();

    for summary in models
        .into_iter()
        .filter(|model| eligible_summary(model, cutoff))
        .take(MAX_DETAIL_REQUESTS)
    {
        if candidates.len() >= MAX_RESULTS {
            break;
        }
        let detail: HubModel = read_json(
            client
                .get(model_detail_url(&summary.id)?)
                .timeout(remaining(deadline)?),
            "Codelit could not inspect a live MLX model.",
        )?;
        let Some(candidate) = candidate_from_model(detail, memory_bytes, free_disk_bytes) else {
            continue;
        };
        candidates.push(candidate);
    }

    candidates.sort_by(|left, right| {
        fit_rank(&left.fit)
            .cmp(&fit_rank(&right.fit))
            .then_with(|| right.downloads.cmp(&left.downloads))
            .then_with(|| right.last_modified.cmp(&left.last_modified))
    });

    Ok(LocalModelDiscovery {
        fetched_at: Utc::now().to_rfc3339(),
        source: "Hugging Face MLX Community".into(),
        memory_bytes,
        free_disk_bytes,
        candidates,
    })
}

pub fn model_page_url(model_id: &str) -> Result<Url, String> {
    let (owner, name) = safe_model_parts(model_id)?;
    let mut url = Url::parse(HUB_BASE_URL).map_err(|_| "The model page is unavailable.")?;
    url.path_segments_mut()
        .map_err(|_| "The model page is unavailable.")?
        .push(owner)
        .push(name);
    Ok(url)
}

fn list_url() -> Result<Url, String> {
    let mut url = Url::parse(HUB_BASE_URL).map_err(|_| "The model catalog is unavailable.")?;
    url.set_path(HUB_LIST_PATH);
    url.query_pairs_mut()
        .append_pair("author", "mlx-community")
        .append_pair("search", "Qwen3")
        .append_pair("filter", "text-generation")
        .append_pair("sort", "lastModified")
        .append_pair("direction", "-1")
        .append_pair("limit", "60")
        .append_pair("full", "true")
        .append_pair("config", "true");
    Ok(url)
}

fn model_detail_url(model_id: &str) -> Result<Url, String> {
    let (owner, name) = safe_model_parts(model_id)?;
    let mut url = Url::parse(HUB_BASE_URL).map_err(|_| "The model catalog is unavailable.")?;
    url.path_segments_mut()
        .map_err(|_| "The model catalog is unavailable.")?
        .push("api")
        .push("models")
        .push(owner)
        .push(name);
    url.query_pairs_mut().append_pair("blobs", "true");
    Ok(url)
}

fn safe_model_parts(model_id: &str) -> Result<(&str, &str), String> {
    let mut parts = model_id.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner != "mlx-community"
        || name.is_empty()
        || parts.next().is_some()
        || name.len() > 140
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("The local model identifier is not trusted.".into());
    }
    Ok((owner, name))
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .map(|remaining| remaining.min(REQUEST_TIMEOUT))
        .ok_or_else(|| "Checking new local models took too long. Try again.".into())
}

fn read_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::blocking::RequestBuilder,
    message: &'static str,
) -> Result<T, String> {
    let mut response = request.send().map_err(|_| message.to_string())?;
    validate_response(&response, message)?;
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| message.to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("The live model catalog response was too large.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "The live model catalog was invalid.".into())
}

fn validate_response(response: &Response, message: &'static str) -> Result<(), String> {
    if !response.status().is_success() {
        return Err(message.into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.starts_with("application/json") {
        return Err("The live model catalog returned an unexpected response.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES)
    {
        return Err("The live model catalog response was too large.".into());
    }
    Ok(())
}

fn eligible_summary(model: &HubModel, cutoff: DateTime<Utc>) -> bool {
    let updated = model
        .last_modified
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    !model.private
        && model.disabled != Some(true)
        && matches!(
            &model.gated,
            serde_json::Value::Bool(false) | serde_json::Value::Null
        )
        && model.id.starts_with("mlx-community/")
        && model.sha.as_deref().is_some_and(is_revision)
        && updated.is_some_and(|value| value >= cutoff)
        && matches!(
            model.pipeline_tag.as_deref(),
            Some("text-generation") | None
        )
        && model.library_name.as_deref() == Some("mlx")
        && model.tags.iter().any(|tag| tag == "safetensors")
        && model.tags.iter().any(|tag| tag == "license:apache-2.0")
        && quantization_bits(model) == Some(4)
        && supported_model_type(model)
        && is_base_release_name(&model.id)
        && !has_excluded_specialty_tag(&model.tags)
}

fn is_base_release_name(model_id: &str) -> bool {
    let Some(name) = model_id.strip_prefix("mlx-community/") else {
        return false;
    };
    let parts = name.split('-').collect::<Vec<_>>();
    match parts.as_slice() {
        [family, size, format, "4bit"] => {
            matches!(*family, "Qwen3.5" | "Qwen3.6")
                && matches!(
                    *size,
                    "0.6B" | "0.8B" | "1.7B" | "2B" | "4B" | "8B" | "9B" | "14B" | "27B" | "32B"
                )
                && matches!(*format, "MLX" | "OptiQ")
        }
        ["Qwen3", size, "4bit"] => matches!(*size, "0.6B" | "1.7B" | "4B" | "8B" | "14B" | "32B"),
        ["Qwen3", size, "Instruct", release, "4bit"] => {
            matches!(*size, "0.6B" | "1.7B" | "4B" | "8B" | "14B" | "32B")
                && release.bytes().all(|byte| byte.is_ascii_digit())
        }
        _ => false,
    }
}

fn candidate_from_model(
    model: HubModel,
    memory_bytes: u64,
    free_disk_bytes: u64,
) -> Option<LocalModelCandidate> {
    if !eligible_summary(&model, Utc::now() - ChronoDuration::days(550)) {
        return None;
    }
    let download_bytes = model
        .siblings
        .iter()
        .filter_map(|file| file.size)
        .try_fold(0_u64, u64::checked_add)?;
    if !(64 * 1024 * 1024..=64 * GIB).contains(&download_bytes) {
        return None;
    }
    let required_memory_bytes = estimated_memory_bytes(download_bytes);
    let (fit, detail) = if memory_bytes > 0 && memory_bytes < required_memory_bytes {
        (
            "memory",
            format!(
                "Needs about {} GB unified memory.",
                bytes_to_gib(required_memory_bytes)
            ),
        )
    } else if free_disk_bytes > 0 && free_disk_bytes < download_bytes.saturating_mul(2) {
        (
            "disk",
            format!(
                "Free about {} GB before Codelit can verify it.",
                bytes_to_gib(download_bytes.saturating_mul(2))
            ),
        )
    } else {
        (
            "fits",
            "Fits this Mac by size. Codelit has not verified its answers or tool use yet.".into(),
        )
    };
    let model_type = model.config.as_ref()?.model_type.clone()?;
    let revision = model.sha?;
    let last_modified = model.last_modified?;
    let label = model
        .id
        .strip_prefix("mlx-community/")?
        .replace(['_', '-'], " ");
    Some(LocalModelCandidate {
        id: model.id,
        label,
        revision,
        last_modified,
        downloads: model.downloads,
        likes: model.likes,
        download_bytes,
        required_memory_bytes,
        license: "apache-2.0".into(),
        model_type,
        fit: fit.into(),
        detail,
    })
}

fn quantization_bits(model: &HubModel) -> Option<u64> {
    model
        .config
        .as_ref()
        .and_then(|config| config.quantization_config.as_ref())
        .and_then(|quantization| quantization.bits)
        .or_else(|| {
            model.tags.iter().find_map(|tag| match tag.as_str() {
                "4bit" | "4-bit" => Some(4),
                "8bit" | "8-bit" => Some(8),
                _ => None,
            })
        })
}

fn supported_model_type(model: &HubModel) -> bool {
    matches!(
        model
            .config
            .as_ref()
            .and_then(|config| config.model_type.as_deref()),
        Some("qwen3" | "qwen3_5")
    )
}

fn has_excluded_specialty_tag(tags: &[String]) -> bool {
    const EXCLUDED: &[&str] = &[
        "asr",
        "audio",
        "image-text-to-text",
        "speech-to-text",
        "text-to-audio",
        "text-to-speech",
        "text-to-video",
        "vision-language-model",
    ];
    tags.iter().any(|tag| EXCLUDED.contains(&tag.as_str()))
}

fn estimated_memory_bytes(download_bytes: u64) -> u64 {
    let working_set = download_bytes.saturating_mul(2).saturating_add(2 * GIB);
    working_set.max(8 * GIB).div_ceil(8 * GIB) * 8 * GIB
}

fn bytes_to_gib(bytes: u64) -> u64 {
    bytes.div_ceil(GIB)
}

fn is_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn fit_rank(value: &str) -> u8 {
    match value {
        "fits" => 0,
        "disk" => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> HubModel {
        HubModel {
            id: "mlx-community/Qwen3.5-4B-MLX-4bit".into(),
            sha: Some("32f3e8ecf65426fc3306969496342d504bfa13f3".into()),
            last_modified: Some(Utc::now().to_rfc3339()),
            downloads: 29_000,
            likes: 35,
            private: false,
            gated: serde_json::Value::Bool(false),
            disabled: Some(false),
            pipeline_tag: Some("text-generation".into()),
            library_name: Some("mlx".into()),
            tags: vec![
                "mlx".into(),
                "safetensors".into(),
                "license:apache-2.0".into(),
                "4-bit".into(),
            ],
            config: Some(HubConfig {
                model_type: Some("qwen3_5".into()),
                quantization_config: Some(HubQuantization { bits: Some(4) }),
            }),
            siblings: vec![HubSibling {
                size: Some(3 * GIB),
            }],
        }
    }

    #[test]
    fn live_candidates_are_filtered_and_ranked_for_the_machine() {
        let model = candidate();
        assert!(eligible_summary(
            &model,
            Utc::now() - ChronoDuration::days(1)
        ));
        let fit = candidate_from_model(model, 32 * GIB, 100 * GIB).expect("candidate");
        assert_eq!(fit.fit, "fits");
        assert_eq!(fit.required_memory_bytes, 8 * GIB);

        let constrained = candidate_from_model(candidate(), 4 * GIB, 100 * GIB)
            .expect("memory constrained candidate");
        assert_eq!(constrained.fit, "memory");
    }

    #[test]
    fn live_candidates_reject_unsafe_or_specialized_models() {
        let mut model = candidate();
        model.id = "other/Qwen3.5-4B".into();
        assert!(!eligible_summary(
            &model,
            Utc::now() - ChronoDuration::days(1)
        ));

        let mut model = candidate();
        model.id = "mlx-community/Qwen3.5-4B-Heretic-OptiQ-4bit".into();
        assert!(!eligible_summary(
            &model,
            Utc::now() - ChronoDuration::days(1)
        ));

        let mut model = candidate();
        model.tags.push("vision-language-model".into());
        assert!(!eligible_summary(
            &model,
            Utc::now() - ChronoDuration::days(1)
        ));

        let mut model = candidate();
        model.tags.retain(|tag| tag != "license:apache-2.0");
        model.tags.push("license:other".into());
        assert!(!eligible_summary(
            &model,
            Utc::now() - ChronoDuration::days(1)
        ));
    }

    #[test]
    fn model_pages_are_confined_to_the_mlx_community() {
        assert_eq!(
            model_page_url("mlx-community/Qwen3.5-4B-MLX-4bit")
                .expect("safe URL")
                .as_str(),
            "https://huggingface.co/mlx-community/Qwen3.5-4B-MLX-4bit"
        );
        assert!(model_page_url("other/model").is_err());
        assert!(model_page_url("mlx-community/../settings").is_err());
    }

    #[test]
    #[ignore = "uses the live Hugging Face catalog"]
    fn live_catalog_returns_only_bounded_review_candidates() {
        let discovery = discover_local_models(&std::env::temp_dir()).expect("live discovery");
        assert!(!discovery.candidates.is_empty());
        assert!(discovery.candidates.len() <= MAX_RESULTS);
        assert!(
            discovery
                .candidates
                .iter()
                .all(|candidate| candidate.id.starts_with("mlx-community/Qwen3"))
        );
    }
}
