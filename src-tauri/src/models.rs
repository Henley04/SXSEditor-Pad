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

use std::collections::HashSet;
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

/// Query the remote file list for a repo/revision. Returns the set of blob
/// paths. Returns None on any failure (caller falls back to the local manifest).
async fn list_remote_files(
    client: &reqwest::Client,
    repo: &str,
    revision: &str,
) -> Option<HashSet<String>> {
    let url = format!(
        "{}/api/v1/models/{}/repo/files?Revision={}&Recursive=true",
        MODELSCOPE_ENDPOINT,
        repo,
        urlencoding::encode(revision),
    );
    let resp = client.get(&url).send().await.ok()?;
    let data: Value = resp.json().await.ok()?;
    let files = data.get("Data")?.get("Files")?.as_array()?;
    let set = files
        .iter()
        .filter(|f| f.get("Type").and_then(|v| v.as_str()) == Some("blob"))
        .filter_map(|f| f.get("Path")?.as_str().map(|s| s.to_string()))
        .collect();
    Some(set)
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
/// availability. Returns a JSON array of `{ fileId, fileName, filePath, size }`.
pub async fn check_missing(app: &AppHandle, precision: &str, revision: &str) -> Vec<Value> {
    let settings = read_settings(app);
    let model_dir = resolve_model_dir(app, &settings);
    let _ = std::fs::create_dir_all(&model_dir);

    let svs_repo = model_id_for_precision(precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap());
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // Query both repos' remote file lists so we can:
    //  - skip .onnx.data for self-contained repos (int8-npu dynamic),
    //  - skip optional files the remote doesn't have.
    let svs_remote = list_remote_files(&client, svs_repo, revision).await;
    let prep_remote = list_remote_files(&client, PREPROCESS_REPO, revision).await;

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
        if let Some(remote_set) = remote {
            if !remote_set.contains(*file_path) {
                // Self-contained .onnx repos don't ship .onnx.data — skip silently.
                continue;
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
            "size": 0,
            "required": *required,
        }));
    }
    missing
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
async fn download_one(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    file_id: &str,
    file_name: &str,
    cancel: &Mutex<bool>,
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

    let _ = app.emit(
        "model-download:file-start",
        json!({ "fileId": file_id, "fileName": file_name, "fileSize": total }),
    );

    let tmp = dest.with_extension("download");
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
        let _ = app.emit(
            "model-download:progress",
            json!({
                "fileId": file_id,
                "fileName": file_name,
                "downloaded": downloaded,
                "total": total,
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
        json!({ "fileId": file_id, "fileName": file_name }),
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
    let revision = if revision.is_empty() {
        DEFAULT_REVISION.to_string()
    } else {
        revision
    };
    let precision = if precision.is_empty() {
        DEFAULT_PRECISION.to_string()
    } else {
        precision
    };

    // Announce the active precision so the renderer UI syncs.
    let _ = app.emit("model-download:precision", precision.clone());

    let missing = check_missing(&app, &precision, &revision).await;
    let _ = app.emit(
        "model-download:missing-files",
        json!({ "files": missing.clone(), "precision": precision }),
    );

    if missing.is_empty() {
        let _ = app.emit("model-download:complete", json!({}));
        return Ok(());
    }

    let settings = read_settings(&app);
    let model_dir = resolve_model_dir(&app, &settings);
    let svs_repo = model_id_for_precision(&precision)
        .unwrap_or(model_id_for_precision(DEFAULT_PRECISION).unwrap())
        .to_string();

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    for file in &missing {
        let file_path = file["filePath"].as_str().ok_or("bad file entry")?;
        let file_id = file["fileId"].as_str().unwrap_or("");
        let repo = if is_svs_file(file_path) {
            svs_repo.as_str()
        } else {
            PREPROCESS_REPO
        };
        let url = file_download_url(repo, file_path, &revision);
        let dest = model_dir.join(file_path);
        if let Err(err) = download_one(
            &app,
            &client,
            &url,
            &dest,
            file_id,
            file_path,
            &dl_state.cancel,
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

    let _ = app.emit("model-download:complete", json!({}));
    Ok(())
}

/// Delete all model files for a precision (used by delete-and-recheck).
pub fn delete_precision_files(app: &AppHandle, _precision: &str) -> Result<(), String> {
    let settings = read_settings(app);
    let model_dir = resolve_model_dir(app, &settings);
    for (file_path, _) in manifest() {
        let p = model_dir.join(file_path);
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}
