//! Model directory management & ModelScope download backend.
//!
//! Replaces the old Electron main-process model code
//! (src/main/modelDir.js, src/main/modelDownload.js, src/modelManager.js).
//!
//! Scope (per project requirements): only the INT8-NPU precision is wired up.
//! SVS model files are pulled from `syxppp/SoulX-Singer-onnx-directml-int8-dynamic`;
//! preprocess / basic_pitch files are pulled from the int8 repo
//! `syxppp/SoulX-Singer-onnx-directml-int8` (static shapes — these preprocessing
//! models are not affected by the NPU dynamic-shape export).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

/// ModelScope HTTP API root.
const MODELSCOPE_ENDPOINT: &str = "https://modelscope.cn";

/// Precision → ModelScope repo id mapping. Only INT8-NPU is wired up; the
/// other precisions are retained as documentation of the upstream layout.
fn model_id_for_precision(precision: &str) -> Option<&'static str> {
    match precision {
        "int8-npu" => Some("syxppp/SoulX-Singer-onnx-directml-int8-dynamic"),
        "int8" => Some("syxppp/SoulX-Singer-onnx-directml-int8"),
        "fp32" => Some("syxppp/SoulX-Singer-onnx-directml"),
        "fp16" => Some("syxppp/SoulX-Singer-onnx-directml-fp16"),
        _ => None,
    }
}

/// Preprocess / basic_pitch files always come from the int8 (static-shape)
/// repo regardless of the selected SVS precision — the NPU dynamic export only
/// covers the SVS models, not the preprocessing models.
const PREPROCESS_REPO: &str = "syxppp/SoulX-Singer-onnx-directml-int8";

/// Default precision for this build.
pub const DEFAULT_PRECISION: &str = "int8-npu";

/// Default revision. ModelScope tags (e.g. "v1") are preferred in the upstream
/// app, but `master` is the universally-available branch and is used as the
/// fallback so a fresh checkout can always download.
const DEFAULT_REVISION: &str = "master";

/// Whether a manifest file is an SVS model (uses the precision repo) or a
/// preprocessing / basic_pitch file (uses the int8 repo).
fn is_svs_file(path: &str) -> bool {
    !path.starts_with("preprocess/") && !path.starts_with("basic_pitch_model/")
}

/// The full model file manifest. `required` mirrors the upstream
/// MODEL_FILE_MANIFEST (src/modelManager.js). Optional files (SiFiGAN, rosvot,
/// rmvpe_mel) are only downloaded if present in the remote repo.
fn manifest() -> Vec<(&'static str, bool)> {
    vec![
        ("note_text_encoder.onnx", true),
        ("note_text_encoder.onnx.data", true),
        ("note_pitch_encoder.onnx", true),
        ("note_pitch_encoder.onnx.data", true),
        ("note_type_encoder.onnx", true),
        ("note_type_encoder.onnx.data", true),
        ("f0_encoder.onnx", true),
        ("f0_encoder.onnx.data", true),
        ("preflow.onnx", true),
        ("preflow.onnx.data", true),
        ("cond_emb.onnx", true),
        ("cond_emb.onnx.data", true),
        ("diff_step_dml.onnx", true),
        ("vocoder_dml.onnx", true),
        ("mel_transform.onnx", true),
        ("mel_transform.onnx.data", true),
        ("preprocess/rmvpe_model.onnx", true),
        ("preprocess/rmvpe_mel.onnx", false),
        ("preprocess/rosvot_model.onnx", false),
        ("preprocess/rosvot_mel.onnx", false),
        ("basic_pitch_model/model.json", true),
        ("basic_pitch_model/group1-shard1of1.bin", true),
        // Optional SiFiGAN vocoder — downloaded only if remote has it.
        ("sifigan_vocoder_dml_fp16.onnx", false),
        ("sifigan_vocoder_dml_fp16.onnx.data", false),
        ("sifigan_vocoder_dml.onnx", false),
        ("sifigan_vocoder_dml.onnx.data", false),
        ("sifigan_stats.joblib", false),
    ]
}

/// Resolve the on-disk model directory.
/// Order: settings.modelDir (if set & parent exists) → app data dir / "models".
pub fn resolve_model_dir(app: &AppHandle, settings: &Value) -> PathBuf {
    if let Some(custom) = settings.get("modelDir").and_then(|v| v.as_str()) {
        let p = PathBuf::from(custom);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    match app.path().app_data_dir() {
        Ok(dir) => dir.join("models"),
        Err(_) => PathBuf::from(".").join("models"),
    }
}

/// Read settings.json from the app config dir. Returns {} on any failure.
pub fn read_settings(app: &AppHandle) -> Value {
    let path = settings_path(app);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| default_settings()),
        Err(_) => default_settings(),
    }
}

/// Write settings.json atomically (temp file + rename).
pub fn write_settings(app: &AppHandle, settings: &Value) -> Result<(), String> {
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        // Best-effort fallback if rename fails (e.g. AV scanner on Windows).
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

fn settings_path(app: &AppHandle) -> PathBuf {
    match app.path().app_config_dir() {
        Ok(dir) => dir.join("settings.json"),
        Err(_) => PathBuf::from("settings.json"),
    }
}

fn default_settings() -> Value {
    json!({
        "locale": "zh-CN",
        "theme": "dark-aurora",
        "deviceMode": "smart",
        "updateChannel": "release",
        "autoCheckUpdates": true,
        "precision": DEFAULT_PRECISION,
    })
}

/// Build the shared HTTP client (browser-like UA so ModelScope doesn't
/// reject API requests).
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Build a ModelScope file-download URL.
fn file_download_url(repo: &str, file_path: &str, revision: &str) -> String {
    format!(
        "{}/api/v1/models/{}/repo?Revision={}&FilePath={}",
        MODELSCOPE_ENDPOINT,
        repo,
        urlencoding::encode(revision),
        urlencoding::encode(file_path),
    )
}

/// Query the remote file list for a repo/revision. Returns a map of
/// blob path → byte size (0 when the API doesn't expose a size).
/// Returns None on any failure (caller falls back to the local manifest).
async fn list_remote_files(
    client: &reqwest::Client,
    repo: &str,
    revision: &str,
) -> Option<HashMap<String, u64>> {
    let url = format!(
        "{}/api/v1/models/{}/repo/files?Revision={}&Recursive=true",
        MODELSCOPE_ENDPOINT,
        repo,
        urlencoding::encode(revision),
    );
    let resp = client.get(&url).send().await.ok()?;
    let data: Value = resp.json().await.ok()?;
    let files = data.get("Data")?.get("Files")?.as_array()?;
    let map = files
        .iter()
        .filter(|f| f.get("Type").and_then(|v| v.as_str()) == Some("blob"))
        .filter_map(|f| {
            let path = f.get("Path")?.as_str()?.to_string();
            // ModelScope uses PascalCase ("Size"); accept lowercase too.
            let size = f
                .get("Size")
                .or_else(|| f.get("size"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            Some((path, size))
        })
        .collect();
    Some(map)
}

/// Fetch the full tag list for a repo from the ModelScope revisions API.
/// Returns tags (e.g. ["v0", "v1"]) in API order; empty on any failure.
/// Branches are NOT included — only entries in `RevisionMap.Tags`.
async fn list_repo_tags(client: &reqwest::Client, repo: &str) -> Vec<String> {
    let url = format!("{}/api/v1/models/{}/revisions", MODELSCOPE_ENDPOINT, repo);
    let Some(resp) = client.get(&url).send().await.ok() else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(data) = resp.json::<Value>().await else {
        return Vec::new();
    };
    data.get("Data")
        .and_then(|d| d.get("RevisionMap"))
        .and_then(|m| m.get("Tags"))
        .and_then(|t| t.as_array())
        .map(|tags| {
            tags.iter()
                .filter_map(|t| t.get("Revision").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `revision` resolves in `repo` (a concrete tag/branch exists).
async fn revision_exists(client: &reqwest::Client, repo: &str, revision: &str) -> bool {
    if revision.is_empty() {
        return false;
    }
    list_repo_tags(client, repo).await.iter().any(|t| t == revision)
}

/// Resolve the effective revision for a repo.
///   "" / "latest" → newest tag → `master` fallback
///   concrete rev  → returned as-is (caller verifies existence when needed
///                   via `revision_exists`)
pub async fn resolve_revision(client: &reqwest::Client, repo: &str, revision: &str) -> String {
    match revision {
        "" | "latest" => match fetch_latest_tag(client, repo).await {
            Some(tag) => tag,
            None => DEFAULT_REVISION.to_string(),
        },
        other => other.to_string(),
    }
}

/// Resolve the revision to use for the preprocess repo. Two repos may not
/// have synchronized tags — if the SVS revision doesn't exist in the
/// preprocess repo, fall back to that repo's newest tag, then `master`.
async fn resolve_preprocess_revision(client: &reqwest::Client, svs_revision: &str) -> String {
    if revision_exists(client, PREPROCESS_REPO, svs_revision).await {
        return svs_revision.to_string();
    }
    resolve_revision(client, PREPROCESS_REPO, "latest").await
}

/// Pick the highest version tag from a ModelScope `/revisions` response.
/// Tags like 'v0', 'v1', 'v1.0', '2' are considered; the highest numeric
/// version wins. Non-numeric tags are ignored. Returns None if no valid tag.
fn pick_latest_tag(data: &Value) -> Option<String> {
    let tags = data
        .get("Data")?
        .get("RevisionMap")?
        .get("Tags")?
        .as_array()?;
    let mut versions: Vec<(u64, String)> = Vec::new();
    for t in tags {
        // Skip entries without a usable revision string instead of bailing out.
        let Some(rev) = t.get("Revision").and_then(|v| v.as_str()) else {
            continue;
        };
        // Extract the leading numeric component (handles 'v0', 'v1', '2', 'v1.0').
        let digits: String = rev
            .chars()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u64>() {
            versions.push((n, rev.to_string()));
        }
    }
    versions.sort_by_key(|(n, _)| *n);
    versions.last().map(|(_, tag)| tag.clone())
}

/// Fetch the latest version tag for a ModelScope repo. Returns None on any
/// failure or when the repo has no usable tags (caller falls back to master).
async fn fetch_latest_tag(client: &reqwest::Client, repo: &str) -> Option<String> {
    let url = format!(
        "{}/api/v1/models/{}/revisions",
        MODELSCOPE_ENDPOINT, repo
    );
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let data: Value = resp.json().await.ok()?;
    pick_latest_tag(&data)
}

/// Minimal percent-encoding for path/revision segments. Avoids pulling in the
/// `urlencoding` crate for two call sites.
mod urlencoding {
    pub fn encode(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            // Unreserved + a few safe separators stay; everything else is %XX.
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{:02X}", b));
            }
        }
        out
    }
}

/// Determine which manifest files are missing locally, filtered by remote
/// availability. Returns a JSON array of `{ fileId, fileName, filePath, size,
/// required, repo }`.
///
/// `revision` may be "latest"/"" (resolved against the SVS repo's newest tag)
/// or a concrete tag/branch. The preprocess repo is resolved independently —
/// its tags may not be synchronized with the SVS repo, and querying it with
/// a foreign revision 404s.
pub async fn check_missing(app: &AppHandle, precision: &str, revision: &str) -> Vec<Value> {
    let svs_repo = model_id_for_precision(precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap());
    let client = build_client();
    let svs_revision = resolve_revision(&client, &svs_repo, revision).await;
    let prep_revision = resolve_preprocess_revision(&client, &svs_revision).await;
    check_missing_impl(app, precision, Some((&svs_revision, &prep_revision))).await
}

/// Shared body of the missing-file check. When `revisions` is `None` the
/// remote file lists are simply unavailable (treated as "unknown remote").
async fn check_missing_impl(
    app: &AppHandle,
    precision: &str,
    revisions: Option<(&str, &str)>,
) -> Vec<Value> {
    let settings = read_settings(app);
    let model_dir = resolve_model_dir(app, &settings);
    let _ = std::fs::create_dir_all(&model_dir);

    let svs_repo = model_id_for_precision(precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap());

    // Query both repos' remote file lists so we can:
    //  - report real remote sizes,
    //  - skip .onnx.data for self-contained repos (int8-npu dynamic),
    //  - skip optional files the remote doesn't have.
    let (svs_remote, prep_remote) = match revisions {
        Some((svs_rev, prep_rev)) => {
            let client = build_client();
            tokio::join!(
                list_remote_files(&client, svs_repo, svs_rev),
                list_remote_files(&client, PREPROCESS_REPO, prep_rev)
            )
        }
        None => (None, None),
    };

    let mut missing = Vec::new();
    for (idx, (file_path, required)) in manifest().iter().enumerate() {
        let local = model_dir.join(file_path);
        let exists = local.exists()
            && std::fs::metadata(&local)
                .map(|m| m.len() > 0)
                .unwrap_or(false);
        if exists {
            continue;
        }
        let repo = if is_svs_file(file_path) {
            svs_repo
        } else {
            PREPROCESS_REPO
        };
        let remote = if is_svs_file(file_path) {
            &svs_remote
        } else {
            &prep_remote
        };
        // Filter out files the remote doesn't expose. For required files we
        // still include them (so the user sees what's expected) unless the
        // remote list is known and the file is absent.
        let mut remote_size = 0u64;
        if let Some(remote_map) = remote {
            match remote_map.get(*file_path) {
                Some(size) => remote_size = *size,
                None => {
                    // Self-contained .onnx repos don't ship .onnx.data — skip silently.
                    continue;
                }
            }
        }
        // Optional files with no remote list info: skip to avoid 404 noise.
        if !*required && remote.is_none() {
            continue;
        }
        missing.push(json!({
            "fileId": format!("file-{}", idx),
            "fileName": file_path,
            "filePath": file_path,
            "repo": repo,
            "size": remote_size,
            "required": *required,
        }));
    }
    missing
}

/// Overall download progress tracker. Tracks the total size of all files and
/// the cumulative downloaded bytes, so the renderer can show an overall
/// progress bar and speed.
///
/// File sizes are *pre-registered* (from the remote file list) before the
/// first byte is downloaded. Previously the total grew as each file's
/// Content-Length arrived, which made the percent-complete bar jump backwards
/// mid-download (e.g. 90% → 60%) — `register_file` is idempotent and takes
/// the max size seen per file, so preregistered totals stay stable while the
/// Content-Length can still refine them.
pub struct DownloadOverall {
    total: Mutex<u64>,
    downloaded: Mutex<u64>,
    registered: Mutex<HashMap<String, u64>>,
}

impl DownloadOverall {
    pub fn new() -> Self {
        Self {
            total: Mutex::new(0),
            downloaded: Mutex::new(0),
            registered: Mutex::new(HashMap::new()),
        }
    }

    /// Register a file's total size (idempotent per file, keeps the max).
    /// May be 0 if the size is unknown (no Content-Length, not in the
    /// remote file list).
    pub async fn register_file(&self, name: &str, size: u64) {
        let mut reg = self.registered.lock().await;
        let entry = reg.entry(name.to_string()).or_insert(0);
        if size > *entry {
            let delta = size - *entry;
            *entry = size;
            let mut g = self.total.lock().await;
            *g += delta;
        }
    }

    /// Atomically add downloaded bytes and return the new overall downloaded.
    pub async fn add_downloaded(&self, delta: u64) -> u64 {
        let mut g = self.downloaded.lock().await;
        *g += delta;
        *g
    }

    pub async fn total(&self) -> u64 {
        *self.total.lock().await
    }
}

/// Download state shared across commands (cancel flag).
pub struct DownloadState {
    pub cancel: Mutex<bool>,
}

impl DownloadState {
    pub fn new() -> Self {
        Self {
            cancel: Mutex::new(false),
        }
    }

    /// Request cancellation of any in-flight download. The download loop polls
    /// this flag between chunks and aborts with "cancelled".
    pub async fn request_cancel(&self) {
        let mut g = self.cancel.lock().await;
        *g = true;
    }
}

/// Stream a single file from ModelScope to `dest`, emitting progress events.
/// Honors the cancel flag between chunks.
///
/// Event field names MUST match what the renderer store expects:
///   file-start:    { filePath, fileName, fileSize }
///   progress:      { currentFile, bytesDownloaded, bytesTotal, overallDownloaded, overallTotal }
///   file-complete: { filePath, fileName }
async fn download_one(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    file_id: &str,
    file_name: &str,
    cancel: &Mutex<bool>,
    overall: &DownloadOverall,
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    // Register this file's size in the overall tracker. Idempotent — the
    // caller usually pre-registered the size from the remote file list; the
    // Content-Length refines it when the preregistered value was 0.
    overall.register_file(file_name, total).await;

    let _ = app.emit(
        "model-download:file-start",
        json!({ "filePath": file_name, "fileName": file_name, "fileSize": total }),
    );

    let tmp = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    while let Some(chunk) = stream.next().await {
        // Check cancellation.
        {
            let guard = cancel.lock().await;
            if *guard {
                drop(guard);
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err("cancelled".to_string());
            }
        }
        let bytes = chunk.map_err(|e| e.to_string())?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
        downloaded += bytes.len() as u64;

        // Update overall progress: add the delta to the overall downloaded counter.
        let overall_dl = overall.add_downloaded(bytes.len() as u64).await;
        let overall_total = overall.total().await;

        let _ = app.emit(
            "model-download:progress",
            json!({
                "currentFile": file_name,
                "bytesDownloaded": downloaded,
                "bytesTotal": total,
                "overallDownloaded": overall_dl,
                "overallTotal": overall_total,
            }),
        );
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&tmp, dest)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(
        "model-download:file-complete",
        json!({ "filePath": file_name, "fileName": file_name }),
    );
    Ok(())
}

/// Download all missing files for the given precision. Emits the full set of
/// `model-download:*` events the renderer subscribes to.
///
/// Takes `&DownloadState` (not `tauri::State`) so lib.rs command wrappers can
/// extract the state via `app.state::<DownloadState>()` and pass it through.
pub async fn run_download(
    app: AppHandle,
    precision: String,
    revision: String,
    dl_state: &DownloadState,
) -> Result<(), String> {
    // Reset cancel flag.
    {
        let mut g = dl_state.cancel.lock().await;
        *g = false;
    }
    let precision = if precision.is_empty() {
        DEFAULT_PRECISION.to_string()
    } else {
        precision
    };

    // Build the HTTP client and resolve the SVS repo up-front so we can
    // resolve the revision (which may need to query ModelScope for tags).
    let client = build_client();
    let svs_repo = model_id_for_precision(&precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap())
        .to_string();

    // Resolve the revision. The renderer uses 'latest' as the default selection,
    // but ModelScope only accepts concrete branch/tag names — passing 'latest'
    // verbatim makes the download endpoint return HTTP 404. Following the main
    // project, we manage models by version **tag** (independent of branches):
    // 'latest' resolves to the newest ModelScope tag (e.g. 'v0'); only when the
    // repo has no usable tag do we fall back to the master branch.
    let svs_revision = resolve_revision(&client, &svs_repo, &revision).await;
    println!("[Models] Download revision for {svs_repo}: {svs_revision}");
    // The preprocess repo is resolved independently — reusing the SVS
    // revision 404s when that tag doesn't exist in the preprocess repo.
    let prep_revision = resolve_preprocess_revision(&client, &svs_revision).await;

    // Announce the active precision so the renderer UI syncs.
    let _ = app.emit("model-download:precision", precision.clone());

    let missing = check_missing_with_revisions(&app, &precision, &svs_revision, &prep_revision).await;
    let _ = app.emit(
        "model-download:missing-files",
        json!({ "files": missing.clone(), "precision": precision }),
    );

    if missing.is_empty() {
        write_revision_marker(&app, &svs_revision);
        let _ = app.emit("model-download:complete", json!({}));
        return Ok(());
    }

    let settings = read_settings(&app);
    let model_dir = resolve_model_dir(&app, &settings);

    // Pre-register every missing file's remote size so the overall progress
    // bar starts at a stable denominator instead of growing (and the percent
    // jumping backwards) as Content-Length headers arrive one by one.
    let overall = DownloadOverall::new();
    for file in &missing {
        let file_path = file["filePath"].as_str().unwrap_or("");
        let size = file["size"].as_u64().unwrap_or(0);
        if !file_path.is_empty() {
            overall.register_file(file_path, size).await;
        }
    }

    for file in &missing {
        let file_path = file["filePath"].as_str().ok_or("bad file entry")?;
        let file_id = file["fileId"].as_str().unwrap_or("");
        let (repo, file_revision) = if is_svs_file(file_path) {
            (svs_repo.as_str(), svs_revision.as_str())
        } else {
            (PREPROCESS_REPO, prep_revision.as_str())
        };
        let url = file_download_url(repo, file_path, file_revision);
        let dest = model_dir.join(file_path);
        if let Err(err) = download_one(
            &app,
            &client,
            &url,
            &dest,
            file_id,
            file_path,
            &dl_state.cancel,
            &overall,
        )
        .await
        {
            if err == "cancelled" {
                let _ = app.emit("model-download:error", json!({ "message": "cancelled" }));
                return Ok(());
            }
            let _ = app.emit(
                "model-download:error",
                json!({ "message": format!("{}: {}", file_path, err) }),
            );
            return Err(err);
        }
    }

    write_revision_marker(&app, &svs_revision);
    let _ = app.emit("model-download:complete", json!({}));
    Ok(())
}

/// Write the installed revision into `<model_dir>/.revision` so the version
/// UI can show what's actually installed (delete_precision_files removes it).
fn write_revision_marker(app: &AppHandle, revision: &str) {
    let settings = read_settings(app);
    let model_dir = resolve_model_dir(app, &settings);
    if std::fs::create_dir_all(&model_dir).is_ok() {
        let _ = std::fs::write(model_dir.join(".revision"), revision);
    }
}

/// Read the installed revision marker, if any.
fn read_revision_marker(app: &AppHandle) -> Option<String> {
    let settings = read_settings(app);
    let model_dir = resolve_model_dir(app, &settings);
    std::fs::read_to_string(model_dir.join(".revision"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Variant of `check_missing` for callers that already resolved both repo
/// revisions (avoids re-querying the revisions API mid-download).
async fn check_missing_with_revisions(
    app: &AppHandle,
    precision: &str,
    svs_revision: &str,
    prep_revision: &str,
) -> Vec<Value> {
    check_missing_impl(app, precision, Some((svs_revision, prep_revision))).await
}

/// Delete all model files for a precision (used by delete-and-recheck).
/// Also removes the `.revision` marker so the version UI no longer reports
/// a stale installed version.
pub fn delete_precision_files(app: &AppHandle, _precision: &str) -> Result<(), String> {
    let settings = read_settings(app);
    let model_dir = resolve_model_dir(app, &settings);
    for (file_path, _) in manifest() {
        let p = model_dir.join(file_path);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    let _ = std::fs::remove_file(model_dir.join(".revision"));
    Ok(())
}

/// Version info for the installed model set, cross-checked against the
/// remote repo:
///   - `hasModelFiles`: all required manifest files present locally
///   - `localRevision`: `.revision` marker written by run_download
///     (null = legacy/unknown install)
///   - `latestVersion`: newest remote tag (null when unreachable)
///   - `updateAvailable`: installed && latest known && differs
pub async fn check_version(app: &AppHandle, precision: &str) -> Value {
    let missing = check_missing(app, precision, "latest").await;
    let required_missing = missing
        .iter()
        .filter(|f| f.get("required").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();
    let has_model_files = required_missing == 0;

    let svs_repo = model_id_for_precision(precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap());
    let client = build_client();
    let latest = fetch_latest_tag(&client, &svs_repo).await;
    let local = read_revision_marker(app);

    let update_available = has_model_files
        && latest.is_some()
        && local.is_some()
        && local.as_deref() != latest.as_deref();

    json!({
        "updateAvailable": update_available,
        "localVersion": local,
        "latestVersion": latest,
        "hasModelFiles": has_model_files,
        "localRevision": local,
    })
}

/// List downloadable version tags for a precision's SVS repo. Returns
/// `{ tags: [...] }` — the renderer's version selector appends these after
/// the "latest" option.
pub async fn list_versions(precision: &str) -> Value {
    let svs_repo = model_id_for_precision(precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap());
    let client = build_client();
    let tags = list_repo_tags(&client, &svs_repo).await;
    json!({ "tags": tags })
}
