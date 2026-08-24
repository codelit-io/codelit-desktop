use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::CString;
use std::fs;
use std::io::{BufReader, Read};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

const MANIFEST_BYTES: &[u8] = include_bytes!("../../native/mlx-helper/model-manifest.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifest {
    schema_version: u32,
    signature: ManifestSignature,
    license_allowlist: Vec<String>,
    pub models: Vec<ModelManifestEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSignature {
    scheme: String,
    scope: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelManifestEntry {
    pub id: String,
    pub revision: String,
    pub label: String,
    pub license: String,
    pub download_bytes: u64,
    pub minimum_memory_bytes: u64,
    pub recommended_memory_bytes: u64,
    #[serde(rename = "releaseValidatedMemoryGiB")]
    pub release_validated_memory_gib: Vec<u64>,
    pub capabilities: Vec<String>,
    pub honest_use: String,
    files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelFile {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub label: String,
    pub status: String,
    pub capabilities: Vec<String>,
    pub local: bool,
    pub download_bytes: Option<u64>,
    pub installed_bytes: Option<u64>,
    pub license: Option<String>,
    pub recommended: bool,
    pub detail: String,
    pub benchmark: Option<ModelBenchmark>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBenchmark {
    pub schema_version: u32,
    pub model: String,
    pub revision: String,
    pub schema_adherence: bool,
    pub tool_calling: bool,
    pub context_tokens: u64,
    pub tokens_per_second: f64,
    pub benchmarked_at: String,
}

pub fn manifest() -> Result<ModelManifest, String> {
    let parsed: ModelManifest = serde_json::from_slice(MANIFEST_BYTES)
        .map_err(|error| format!("The bundled model manifest is invalid: {error}"))?;
    validate_manifest(&parsed)?;
    Ok(parsed)
}

pub fn manifest_sha256() -> String {
    format!("{:x}", Sha256::digest(MANIFEST_BYTES))
}

pub fn probe_models(app_data_dir: &Path) -> Result<Vec<ProviderModel>, String> {
    let resources = MachineResources::read(app_data_dir);
    manifest()?
        .models
        .iter()
        .map(|model| probe_model(app_data_dir, model, resources))
        .collect()
}

pub fn manifest_entry(model_id: &str) -> Result<ModelManifestEntry, String> {
    manifest()?
        .models
        .into_iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| "The selected on-device model is not in Codelit's signed manifest.".into())
}

pub fn probe_model_by_id(app_data_dir: &Path, model_id: &str) -> Result<ProviderModel, String> {
    let model = manifest_entry(model_id)?;
    probe_model(app_data_dir, &model, MachineResources::read(app_data_dir))
}

pub fn prepare_download(app_data_dir: &Path, model_id: &str) -> Result<ModelManifestEntry, String> {
    let model = manifest_entry(model_id)?;
    let resources = MachineResources::read(app_data_dir);
    if resources.memory_bytes > 0 && resources.memory_bytes < model.minimum_memory_bytes {
        return Err(format!(
            "This model needs at least {} GB unified memory.",
            bytes_to_gib(model.minimum_memory_bytes)
        ));
    }
    if release_hardware_gate_enabled()
        && !release_memory_is_validated(&model, resources.memory_bytes)
    {
        return Err(release_memory_message(&model));
    }
    if resources.free_disk_bytes > 0
        && resources.free_disk_bytes < model.download_bytes.saturating_mul(2)
    {
        return Err(format!(
            "Free at least {} MB before downloading this model.",
            bytes_to_mib(model.download_bytes.saturating_mul(2))
        ));
    }
    Ok(model)
}

pub fn delete_model(app_data_dir: &Path, model_id: &str) -> Result<ProviderModel, String> {
    let model = manifest_entry(model_id)?;
    let root = cache_root(app_data_dir, model_id)?;
    if let Ok(metadata) = fs::symlink_metadata(&root) {
        if metadata.file_type().is_symlink() || metadata.is_file() {
            fs::remove_file(&root)
                .map_err(|error| format!("Could not remove the on-device model: {error}"))?;
        } else if metadata.is_dir() {
            fs::remove_dir_all(&root)
                .map_err(|error| format!("Could not remove the on-device model: {error}"))?;
        }
    }
    let benchmark = benchmark_path(app_data_dir, &model)?;
    if benchmark.is_file() {
        fs::remove_file(&benchmark)
            .map_err(|error| format!("Could not remove the model benchmark: {error}"))?;
    }
    probe_model(app_data_dir, &model, MachineResources::read(app_data_dir))
}

pub fn save_benchmark(
    app_data_dir: &Path,
    model_id: &str,
    benchmark: &ModelBenchmark,
) -> Result<(), String> {
    let model = manifest_entry(model_id)?;
    validate_benchmark(&model, benchmark)?;
    let path = benchmark_path(app_data_dir, &model)?;
    let directory = path
        .parent()
        .ok_or("The model benchmark directory is invalid.")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not prepare the model benchmark directory: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(benchmark)
        .map_err(|error| format!("Could not encode the model benchmark: {error}"))?;
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not save the model benchmark: {error}"))?;
    fs::File::open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Could not finish the model benchmark: {error}"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Could not publish the model benchmark: {error}"))?;
    Ok(())
}

fn probe_model(
    app_data_dir: &Path,
    model: &ModelManifestEntry,
    resources: MachineResources,
) -> Result<ProviderModel, String> {
    let root = cache_root(app_data_dir, &model.id)?;
    let snapshot = root.join("snapshots").join(&model.revision);
    let partial = root.exists();
    let enough_memory =
        resources.memory_bytes == 0 || resources.memory_bytes >= model.minimum_memory_bytes;
    let enough_disk = resources.free_disk_bytes == 0
        || resources.free_disk_bytes >= model.download_bytes.saturating_mul(2);

    if !enough_memory {
        return Ok(model_view(
            model,
            "incompatible",
            None,
            false,
            format!(
                "Needs at least {} GB unified memory.",
                bytes_to_gib(model.minimum_memory_bytes)
            ),
            None,
        ));
    }

    if release_hardware_gate_enabled()
        && !release_memory_is_validated(model, resources.memory_bytes)
    {
        return Ok(model_view(
            model,
            "incompatible",
            None,
            false,
            release_memory_message(model),
            None,
        ));
    }

    if !snapshot.is_dir() {
        let status = if partial {
            "partial"
        } else {
            "download-required"
        };
        let detail = if !enough_disk {
            format!(
                "Needs about {} MB plus working space; free disk is low.",
                bytes_to_mib(model.download_bytes)
            )
        } else if partial {
            "Download can resume from the files already on this Mac.".into()
        } else {
            format!(
                "{} MB download. {}",
                bytes_to_mib(model.download_bytes),
                model.honest_use
            )
        };
        return Ok(model_view(
            model,
            status,
            None,
            enough_disk && resources.memory_bytes >= model.recommended_memory_bytes,
            detail,
            None,
        ));
    }

    for expected in &model.files {
        let file_path = snapshot.join(&expected.path);
        if !file_path.is_file() {
            return Ok(model_view(
                model,
                "corrupt",
                None,
                false,
                format!(
                    "{} is missing. Remove and download the model again.",
                    expected.path
                ),
                None,
            ));
        }
        let metadata = fs::metadata(&file_path)
            .map_err(|error| format!("Could not inspect {}: {error}", expected.path))?;
        if metadata.len() != expected.bytes || sha256_file(&file_path)? != expected.sha256 {
            return Ok(model_view(
                model,
                "corrupt",
                None,
                false,
                format!("{} failed integrity verification.", expected.path),
                None,
            ));
        }
    }

    let Some(benchmark) = read_benchmark(app_data_dir, model) else {
        return Ok(model_view(
            model,
            "benchmark-required",
            Some(model.download_bytes),
            false,
            "Model files are verified. Run the quick local benchmark before using it.".into(),
            None,
        ));
    };
    if !benchmark.schema_adherence {
        return Ok(model_view(
            model,
            "incompatible",
            Some(model.download_bytes),
            false,
            "This model did not pass Codelit's structured-output benchmark.".into(),
            Some(benchmark),
        ));
    }

    let context_detail = if benchmark.context_tokens > 0 {
        format!("{}-token context recall passed", benchmark.context_tokens)
    } else {
        "bounded context recall did not pass".into()
    };
    let tool_detail = if benchmark.tool_calling {
        "tool-call formatting passed"
    } else {
        "tool calls remain unavailable"
    };

    Ok(model_view(
        model,
        "ready",
        Some(model.download_bytes),
        resources.memory_bytes >= model.recommended_memory_bytes,
        format!(
            "Verified against manifest {}. {:.1} tok/s; {context_detail}; {tool_detail}. {}",
            &manifest_sha256()[..12],
            benchmark.tokens_per_second,
            model.honest_use
        ),
        Some(benchmark),
    ))
}

fn model_view(
    model: &ModelManifestEntry,
    status: &str,
    installed_bytes: Option<u64>,
    recommended: bool,
    detail: String,
    benchmark: Option<ModelBenchmark>,
) -> ProviderModel {
    let mut capabilities = model.capabilities.clone();
    if benchmark.as_ref().is_some_and(|result| result.tool_calling) {
        capabilities.push("tool-calling".into());
    }
    if benchmark
        .as_ref()
        .is_some_and(|result| result.context_tokens > 0)
    {
        capabilities.push("bounded-context".into());
    }
    ProviderModel {
        id: model.id.clone(),
        label: model.label.clone(),
        status: status.into(),
        capabilities,
        local: true,
        download_bytes: Some(model.download_bytes),
        installed_bytes,
        license: Some(model.license.clone()),
        recommended,
        detail,
        benchmark,
    }
}

fn benchmark_path(app_data_dir: &Path, model: &ModelManifestEntry) -> Result<PathBuf, String> {
    if !is_safe_model_id(&model.id) || !is_lower_hex(&model.revision, 40) {
        return Err("The model benchmark identifier is invalid.".into());
    }
    Ok(app_data_dir.join("models/benchmarks").join(format!(
        "{}-{}.json",
        model.id.replace('/', "--"),
        model.revision
    )))
}

fn read_benchmark(app_data_dir: &Path, model: &ModelManifestEntry) -> Option<ModelBenchmark> {
    let path = benchmark_path(app_data_dir, model).ok()?;
    let benchmark = serde_json::from_slice::<ModelBenchmark>(&fs::read(path).ok()?).ok()?;
    validate_benchmark(model, &benchmark).ok()?;
    Some(benchmark)
}

fn validate_benchmark(
    model: &ModelManifestEntry,
    benchmark: &ModelBenchmark,
) -> Result<(), String> {
    if benchmark.schema_version != 1
        || benchmark.model != model.id
        || benchmark.revision != model.revision
        || !benchmark.tokens_per_second.is_finite()
        || !(0.0..=10_000.0).contains(&benchmark.tokens_per_second)
        || benchmark.context_tokens > 1_000_000
        || benchmark.benchmarked_at.len() < 20
        || benchmark.benchmarked_at.len() > 64
    {
        return Err("The on-device model benchmark receipt is invalid.".into());
    }
    Ok(())
}

fn validate_manifest(manifest: &ModelManifest) -> Result<(), String> {
    if manifest.schema_version != 1
        || manifest.signature.scheme != "apple-code-signature"
        || manifest.signature.scope != "embedded-bundle-resource"
    {
        return Err("The bundled model manifest has an unsupported trust scheme.".into());
    }
    if manifest.models.is_empty() {
        return Err("The bundled model manifest contains no models.".into());
    }
    let licenses = manifest
        .license_allowlist
        .iter()
        .map(|license| license.as_str())
        .collect::<HashSet<_>>();
    let mut ids = HashSet::new();
    for model in &manifest.models {
        if !ids.insert(model.id.as_str())
            || !is_safe_model_id(&model.id)
            || !is_lower_hex(&model.revision, 40)
            || !licenses.contains(model.license.as_str())
            || model.files.is_empty()
            || model.download_bytes == 0
            || model.minimum_memory_bytes == 0
            || model.release_validated_memory_gib.is_empty()
            || model
                .release_validated_memory_gib
                .iter()
                .any(|memory| *memory < 8 || *memory > 512)
        {
            return Err(format!(
                "The manifest entry for {} is not release-safe.",
                model.id
            ));
        }
        let mut paths = HashSet::new();
        for file in &model.files {
            let path = Path::new(&file.path);
            if !paths.insert(file.path.as_str())
                || path.is_absolute()
                || path
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
                || file.bytes == 0
                || !is_lower_hex(&file.sha256, 64)
            {
                return Err(format!(
                    "The manifest file {} is not release-safe.",
                    file.path
                ));
            }
        }
    }
    Ok(())
}

fn release_hardware_gate_enabled() -> bool {
    cfg!(any(
        feature = "direct-release",
        feature = "app-store-release"
    ))
}

fn release_memory_is_validated(model: &ModelManifestEntry, memory_bytes: u64) -> bool {
    memory_bytes > 0
        && model
            .release_validated_memory_gib
            .contains(&(memory_bytes / (1024 * 1024 * 1024)))
}

fn release_memory_message(model: &ModelManifestEntry) -> String {
    let classes = model
        .release_validated_memory_gib
        .iter()
        .map(|memory| format!("{memory} GB"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "This release enables the built-in model only on physically validated {classes} Macs. Use another available engine or Codelit Cloud on this Mac."
    )
}

fn is_safe_model_id(value: &str) -> bool {
    value.len() <= 160
        && value.matches('/').count() == 1
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn cache_root(app_data_dir: &Path, model_id: &str) -> Result<PathBuf, String> {
    if !is_safe_model_id(model_id) {
        return Err("The on-device model identifier is invalid.".into());
    }
    Ok(app_data_dir
        .join("models/huggingface/hub")
        .join(format!("models--{}", model_id.replace('/', "--"))))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not verify the on-device model: {error}"))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not verify the on-device model: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Debug, Clone, Copy)]
struct MachineResources {
    memory_bytes: u64,
    free_disk_bytes: u64,
}

impl MachineResources {
    fn read(app_data_dir: &Path) -> Self {
        Self {
            memory_bytes: unified_memory_bytes().unwrap_or(0),
            free_disk_bytes: free_disk_bytes(app_data_dir).unwrap_or(0),
        }
    }
}

fn unified_memory_bytes() -> Option<u64> {
    let output = Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .ok()
    })?
}

fn free_disk_bytes(path: &Path) -> Option<u64> {
    let existing = path.ancestors().find(|candidate| candidate.exists())?;
    let path = CString::new(existing.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `stats` points to writable memory.
    let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    // SAFETY: statvfs initialized the structure after returning zero.
    let stats = unsafe { stats.assume_init() };
    Some(u64::from(stats.f_bavail).saturating_mul(stats.f_frsize))
}

fn bytes_to_mib(bytes: u64) -> u64 {
    bytes.div_ceil(1024 * 1024)
}

fn bytes_to_gib(bytes: u64) -> u64 {
    bytes.div_ceil(1024 * 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn bundled_manifest_is_pinned_hashed_and_license_allowlisted() {
        let manifest = manifest().expect("valid manifest");
        assert_eq!(manifest.models.len(), 2);
        for model in &manifest.models {
            assert_eq!(model.license, "apache-2.0");
            assert_eq!(model.revision.len(), 40);
            assert_eq!(model.files[0].sha256.len(), 64);
            assert_eq!(model.release_validated_memory_gib, vec![32]);
        }
        assert_eq!(manifest_sha256().len(), 64);
    }

    #[test]
    fn release_model_support_is_limited_to_measured_memory_classes() {
        let model = manifest_entry("mlx-community/Qwen3-0.6B-4bit").expect("model");
        assert!(release_memory_is_validated(&model, 32 * 1024 * 1024 * 1024));
        assert!(!release_memory_is_validated(
            &model,
            16 * 1024 * 1024 * 1024
        ));
        assert!(!release_memory_is_validated(
            &model,
            64 * 1024 * 1024 * 1024
        ));
        assert!(!release_memory_is_validated(&model, 0));
    }

    #[test]
    fn cache_paths_reject_traversal() {
        let directory = tempdir().expect("temporary directory");
        assert!(cache_root(directory.path(), "../outside").is_err());
        assert!(cache_root(directory.path(), "owner/model").is_ok());
    }

    #[test]
    fn file_hashing_is_deterministic() {
        let directory = tempdir().expect("temporary directory");
        let path = directory.path().join("model.bin");
        fs::write(&path, b"hello").expect("write fixture");
        assert_eq!(
            sha256_file(&path).expect("hash fixture"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn deletion_is_limited_to_the_manifest_model_root() {
        let directory = tempdir().expect("temporary directory");
        let model_id = "mlx-community/Qwen3-0.6B-4bit";
        let root = cache_root(directory.path(), model_id).expect("model root");
        fs::create_dir_all(&root).expect("create model root");
        fs::write(root.join("partial"), b"partial").expect("write partial model");
        let sibling = directory.path().join("models/keep.txt");
        fs::create_dir_all(sibling.parent().expect("sibling parent")).expect("create sibling");
        fs::write(&sibling, b"keep").expect("write sibling");

        let model = delete_model(directory.path(), model_id).expect("delete model");
        assert_eq!(model.id, model_id);
        assert!(!root.exists());
        assert_eq!(fs::read(&sibling).expect("read sibling"), b"keep");
        assert!(delete_model(directory.path(), "other/model").is_err());
    }

    #[test]
    fn benchmark_receipts_are_model_and_revision_bound() {
        let directory = tempdir().expect("temporary directory");
        let model = manifest_entry("mlx-community/Qwen3-0.6B-4bit").expect("model");
        let benchmark = ModelBenchmark {
            schema_version: 1,
            model: model.id.clone(),
            revision: model.revision.clone(),
            schema_adherence: true,
            tool_calling: false,
            context_tokens: 1_024,
            tokens_per_second: 31.5,
            benchmarked_at: "2026-08-11T12:00:00Z".into(),
        };
        save_benchmark(directory.path(), &model.id, &benchmark).expect("save benchmark");
        assert_eq!(read_benchmark(directory.path(), &model), Some(benchmark));

        let mismatched = ModelBenchmark {
            revision: "0000000000000000000000000000000000000000".into(),
            ..read_benchmark(directory.path(), &model).expect("stored benchmark")
        };
        assert!(save_benchmark(directory.path(), &model.id, &mismatched).is_err());
    }
}
