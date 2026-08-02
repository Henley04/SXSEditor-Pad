//! SXSEditor-Pad Tauri backend.
//!
//! Replaces the entire Electron main-process layer (src/main/*). Inference now
//! runs natively in Rust (inference::ort_engine — ONNX Runtime Mobile with
//! NNAPI/CoreML/CPU execution providers, loaded via `load-dynamic`; Basic
//! Pitch via inference::tflite / LiteRT). The renderer keeps the pipeline
//! orchestration (tokenization, samplers, stitching) and ships only packed
//! tensor frames across IPC. The Rust side also owns:
//!   - model directory resolution & ModelScope download (models.rs)
//!   - theme bootstrap (theme.rs)
//!   - settings / locale persistence
//!   - file IO, WAV export (hound), SHA-256 integrity checks
//!   - graceful stubs for legacy IPC channels that the renderer still calls
//!     (svs:*, fragment-svs:*, audio:*) so the app boots without crashing.

mod inference;
mod models;
mod theme;

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

use models::DownloadState;

/// Application state. Settings are cached for synchronous access; the on-disk
/// copy (read via `models::read_settings`) is the source of truth and is
/// re-read on every settings command so external edits are picked up.
pub struct AppState {
    pub settings: Mutex<Value>,
    pub model_dir: Mutex<String>,
}

// ============================ File operations ============================

#[tauri::command]
async fn save_file(path: String, data: String) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_buffer(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
async fn resolve_path(base_path: String, relative_path: String) -> Result<String, String> {
    let base = std::path::Path::new(&base_path);
    let resolved = base.join(&relative_path);
    Ok(resolved.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_dir_name(file_path: String) -> Result<String, String> {
    let p = std::path::Path::new(&file_path);
    Ok(p.parent()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_default())
}

#[tauri::command]
async fn show_item_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    // Best-effort: open the file's parent directory. On Android this is a no-op
    // (no system file manager integration), which is fine — the renderer only
    // calls this from settings/desktop contexts.
    let _ = app.shell().open(path, None);
    Ok(())
}

#[tauri::command]
async fn save_singer_file(singer_data: Value, app: AppHandle) -> Result<Value, String> {
    let name = singer_data
        .get("singerName")
        .and_then(|v| v.as_str())
        .unwrap_or("singer")
        .trim()
        .to_string();
    let settings = models::read_settings(&app);
    let model_dir = models::resolve_model_dir(&app, &settings);
    let singers_dir = model_dir.join("singers");
    std::fs::create_dir_all(&singers_dir).map_err(|e| e.to_string())?;
    let file_path = singers_dir.join(format!("{}.json", name));
    let content = serde_json::to_string_pretty(&singer_data).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    let path_str = file_path.to_string_lossy().to_string();
    // Notify the main window that a singer was created/updated so it can refresh its list.
    let _ = app.emit("singerCreated", json!({ "name": name, "path": path_str }));
    Ok(json!({ "success": true, "filePath": path_str }))
}

// ============================ App / platform ============================

#[tauri::command]
async fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[tauri::command]
async fn get_platform_info() -> Result<Value, String> {
    Ok(json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "isMobile": cfg!(target_os = "android") || cfg!(target_os = "ios")
    }))
}

#[tauri::command]
async fn get_model_dir(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    // Refresh from settings so a user-changed dir is reflected immediately.
    let settings = models::read_settings(&app);
    let dir = models::resolve_model_dir(&app, &settings);
    let s = dir.to_string_lossy().to_string();
    *state.model_dir.lock().unwrap() = s.clone();
    Ok(s)
}

// ============================ Settings ============================

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<Value, String> {
    Ok(models::read_settings(&app))
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    models::write_settings(&app, &settings)
}

#[tauri::command]
async fn settings_check_models(app: AppHandle, precision: Option<String>) -> Result<Value, String> {
    let settings = models::read_settings(&app);
    let prec = precision.unwrap_or_else(|| {
        settings
            .get("precision")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| models::DEFAULT_PRECISION.to_string())
    });
    let missing = models::check_missing(&app, &prec, "master").await;
    let ready = missing.is_empty();
    Ok(json!({
        "precision": prec,
        "missing": missing,
        "missingCount": missing.len(),
        "ready": ready,
    }))
}

// ============================ Locale ============================

#[tauri::command]
async fn get_locale(app: AppHandle) -> Result<String, String> {
    let settings = models::read_settings(&app);
    Ok(settings
        .get("locale")
        .and_then(|v| v.as_str())
        .unwrap_or("zh-CN")
        .to_string())
}

#[tauri::command]
async fn save_locale(app: AppHandle, locale: String) -> Result<(), String> {
    let mut settings = models::read_settings(&app);
    settings["locale"] = json!(locale);
    models::write_settings(&app, &settings)?;
    let _ = app.emit("locale-changed", &locale);
    Ok(())
}

#[tauri::command]
async fn reload_main_window(_app: AppHandle) -> Result<(), String> {
    // On Android/Tauri there's no Electron-style window.reload(); the renderer
    // is expected to call window.location.reload() directly. Emit an event so a
    // future desktop implementation can hook here.
    Ok(())
}

// ============================ Theme ============================

#[tauri::command]
async fn theme_bootstrap(app: AppHandle) -> Result<Value, String> {
    let settings = models::read_settings(&app);
    Ok(theme::bootstrap_payload(&settings))
}

#[tauri::command]
async fn theme_list() -> Result<Value, String> {
    Ok(theme::list_payload())
}

#[tauri::command]
async fn theme_get(theme_id: String) -> Result<Value, String> {
    theme::builtin_theme(&theme_id).ok_or_else(|| format!("unknown theme: {}", theme_id))
}

#[tauri::command]
async fn theme_current(app: AppHandle, _options: Option<Value>) -> Result<Value, String> {
    let settings = models::read_settings(&app);
    Ok(theme::bootstrap_payload(&settings))
}

#[tauri::command]
async fn theme_apply(app: AppHandle, theme_id: String, _options: Option<Value>) -> Result<Value, String> {
    let mut settings = models::read_settings(&app);
    settings["theme"] = json!(theme_id);
    models::write_settings(&app, &settings)?;
    let payload = theme::bootstrap_payload(&settings);
    let _ = app.emit("theme:changed", &payload);
    Ok(payload)
}

#[tauri::command]
async fn theme_save(_app: AppHandle, _theme_obj: Value) -> Result<(), String> {
    Err("custom theme saving is not supported in this build".to_string())
}

#[tauri::command]
async fn theme_delete(_app: AppHandle, _theme_id: String) -> Result<(), String> {
    Err("custom theme deletion is not supported in this build".to_string())
}

#[tauri::command]
async fn theme_import(_app: AppHandle) -> Result<Value, String> {
    Err("theme import is not supported in this build".to_string())
}

#[tauri::command]
async fn theme_export(_app: AppHandle, _theme_id: String) -> Result<(), String> {
    Err("theme export is not supported in this build".to_string())
}

#[tauri::command]
async fn theme_reset(app: AppHandle) -> Result<Value, String> {
    let mut settings = models::read_settings(&app);
    settings["theme"] = json!("dark-aurora");
    models::write_settings(&app, &settings)?;
    Ok(theme::bootstrap_payload(&settings))
}

// ============================ Model download ============================

#[tauri::command]
async fn model_download_start(
    app: AppHandle,
    state: State<'_, DownloadState>,
    precision: String,
    revision: String,
) -> Result<(), String> {
    models::run_download(app, precision, revision, state.inner()).await
}

#[tauri::command]
async fn model_download_cancel(state: State<'_, DownloadState>) -> Result<(), String> {
    state.inner().request_cancel().await;
    Ok(())
}

#[tauri::command]
async fn model_download_check(app: AppHandle) -> Result<Value, String> {
    let settings = models::read_settings(&app);
    let prec = settings
        .get("precision")
        .and_then(|v| v.as_str())
        .unwrap_or(models::DEFAULT_PRECISION)
        .to_string();
    let missing = models::check_missing(&app, &prec, "master").await;
    let _ = app.emit("model-download:missing-files", json!({ "files": missing, "precision": prec }));
    Ok(json!({ "files": missing, "precision": prec }))
}

#[tauri::command]
async fn model_download_get_dir(app: AppHandle) -> Result<String, String> {
    let settings = models::read_settings(&app);
    Ok(models::resolve_model_dir(&app, &settings)
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
async fn model_download_change_dir(app: AppHandle) -> Result<Value, String> {
    // Pick a new directory and persist it to settings.modelDir.
    let picked = app
        .dialog()
        .file()
        .set_title("Select model directory")
        .blocking_pick_folder();
    match picked {
        Some(path) => {
            let s = path.to_string();
            let mut settings = models::read_settings(&app);
            settings["modelDir"] = json!(s);
            models::write_settings(&app, &settings)?;
            Ok(json!({ "dir": s }))
        }
        None => Ok(json!({ "dir": null })),
    }
}

#[tauri::command]
async fn model_download_recheck(app: AppHandle, precision: String) -> Result<Value, String> {
    let missing = models::check_missing(&app, &precision, "master").await;
    let _ = app.emit(
        "model-download:missing-files",
        json!({ "files": missing, "precision": precision }),
    );
    Ok(json!({ "files": missing, "precision": precision }))
}

#[tauri::command]
async fn model_download_delete_and_recheck(
    app: AppHandle,
    precision: String,
) -> Result<Value, String> {
    models::delete_precision_files(&app, &precision)?;
    let missing = models::check_missing(&app, &precision, "master").await;
    let _ = app.emit(
        "model-download:missing-files",
        json!({ "files": missing, "precision": precision }),
    );
    Ok(json!({ "files": missing, "precision": precision }))
}

#[tauri::command]
async fn model_download_open(app: AppHandle, precision: String) -> Result<(), String> {
    // Announce the active precision so the model-download window syncs its UI.
    let _ = app.emit("model-download:precision", &precision);
    Ok(())
}

#[tauri::command]
async fn model_download_open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
async fn model_download_update(
    app: AppHandle,
    state: State<'_, DownloadState>,
    precision: String,
    revision: String,
) -> Result<(), String> {
    models::run_download(app, precision, revision, state.inner()).await
}

// --- Version checks (stubbed: only master revision is wired up for now) ---

#[tauri::command]
async fn model_download_check_version(_app: AppHandle, _precision: String) -> Result<Value, String> {
    Ok(json!({
        "updateAvailable": false,
        "localVersion": null,
        "latestVersion": "master",
        "hasModelFiles": false,
        "localRevision": "master"
    }))
}

#[tauri::command]
async fn model_download_list_versions(_app: AppHandle, _precision: String) -> Result<Value, String> {
    Ok(json!([{ "tag": "master" }]))
}

#[tauri::command]
async fn model_download_check_all_versions(
    _app: AppHandle,
    _precision: String,
) -> Result<Value, String> {
    Ok(json!({
        "svs": { "updateAvailable": false, "latestVersion": "master" },
        "jp": { "updateAvailable": false, "latestVersion": null },
        "sifigan": { "updateAvailable": false, "latestVersion": null }
    }))
}

// --- JP / SiFiGAN (not shipped in INT8-NPU-only build; stubbed) ---

#[tauri::command]
async fn model_download_check_jp(_app: AppHandle, _precision: String) -> Result<Value, String> {
    Ok(json!({ "installed": false, "missing": [] }))
}

#[tauri::command]
async fn model_download_start_jp(
    _app: AppHandle,
    _precision: String,
    _revision: String,
) -> Result<(), String> {
    Err("JP models are not available in this INT8-NPU-only build".to_string())
}

#[tauri::command]
async fn model_download_check_jp_exists(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
async fn model_download_check_sifigan(_app: AppHandle) -> Result<Value, String> {
    Ok(json!({ "installed": false, "missing": [], "configured": false }))
}

#[tauri::command]
async fn model_download_start_sifigan(_app: AppHandle, _revision: String) -> Result<(), String> {
    Err("SiFiGAN vocoder is not available in this INT8-NPU-only build".to_string())
}

#[tauri::command]
async fn model_download_unload_sifigan(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn model_download_check_jp_version(_app: AppHandle, _precision: String) -> Result<Value, String> {
    Ok(json!({ "updateAvailable": false, "latestVersion": null }))
}

#[tauri::command]
async fn model_download_check_sifigan_version(_app: AppHandle) -> Result<Value, String> {
    Ok(json!({ "updateAvailable": false, "latestVersion": null }))
}

#[tauri::command]
async fn model_download_update_jp(
    _app: AppHandle,
    _precision: String,
    _revision: String,
) -> Result<(), String> {
    Err("JP models are not available in this build".to_string())
}

#[tauri::command]
async fn model_download_update_sifigan(_app: AppHandle, _revision: String) -> Result<(), String> {
    Err("SiFiGAN vocoder is not available in this build".to_string())
}

#[tauri::command]
async fn model_download_list_jp_versions(_app: AppHandle, _precision: String) -> Result<Value, String> {
    Ok(json!([]))
}

#[tauri::command]
async fn model_download_list_sifigan_versions(_app: AppHandle) -> Result<Value, String> {
    Ok(json!([]))
}

// ============================ WebNN (model file reading) ============================
//
// Inference itself runs in the renderer via onnxruntime-web. The Rust side only
// needs to expose model-file reading so the renderer can build ORT sessions.
// `webnn_read_model_file` returns raw bytes; for large files the renderer can
// also use the fs plugin directly (model dir is in the fs scope).

#[tauri::command]
async fn webnn_read_model_file(file_path: String) -> Result<Value, String> {
    match tokio::fs::read(&file_path).await {
        Ok(bytes) => Ok(json!({ "success": true, "data": bytes })),
        Err(e) => Ok(json!({ "success": false, "error": e.to_string() })),
    }
}

#[tauri::command]
async fn webnn_detect_npu() -> Result<Value, String> {
    // NPU detection is performed in the renderer (navigator.ml / WebNN EP).
    Ok(json!({ "available": false }))
}

#[tauri::command]
async fn webnn_load_model(
    _app: AppHandle,
    _model_id: String,
    _model_path: String,
    _options: Option<Value>,
) -> Result<Value, String> {
    Err("webnn:loadModel is renderer-only (onnxruntime-web)".to_string())
}

#[tauri::command]
async fn webnn_unload_model(_app: AppHandle, _model_id: String) -> Result<(), String> {
    Err("webnn:unloadModel is renderer-only (onnxruntime-web)".to_string())
}

#[tauri::command]
async fn webnn_run_inference(_app: AppHandle, _model_id: String, _inputs: Value) -> Result<Value, String> {
    Err("webnn:runInference is renderer-only (onnxruntime-web)".to_string())
}

#[tauri::command]
async fn webnn_get_status() -> Result<Value, String> {
    Ok(json!({ "sessions": [], "available": false }))
}

// ============================ Native inference (ORT / LiteRT) ============================
//
// The live SVS inference path. The renderer's pipeline (src/inference/webnn +
// src/inference/native) prepares tensors; these commands execute the ONNX
// sessions natively via ONNX Runtime Mobile (NNAPI on Android, CoreML on iOS,
// CPU elsewhere). Basic Pitch runs on LiteRT. Model bytes never cross IPC —
// sessions are created from file paths; only tensor frames cross, raw-packed.

#[tauri::command]
async fn native_ort_init(lib_path: Option<String>) -> Result<Value, String> {
    let p = lib_path.clone();
    tauri::async_runtime::spawn_blocking(move || inference::ort_engine::init(p.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_ort_detect_accelerators() -> Result<Value, String> {
    Ok(inference::ort_engine::status().get("accelerators").cloned().unwrap_or_else(|| json!({})))
}

#[tauri::command]
async fn native_ort_load_model(
    model_id: String,
    model_path: String,
    options: Option<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inference::ort_engine::load_model(&model_id, &model_path, options.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_ort_unload_model(model_id: String) -> Result<Value, String> {
    Ok(json!({ "unloaded": inference::ort_engine::unload_model(&model_id) }))
}

#[tauri::command]
async fn native_ort_status() -> Result<Value, String> {
    Ok(inference::ort_engine::status())
}

/// Raw-frame inference: request body is a packed tensor frame
/// (`inference::frame`), response body is the packed output frame. This is the
/// fast path used on desktop/iOS where the custom protocol carries raw bytes.
#[tauri::command]
async fn native_ort_run(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        // Android postMessage fallback: the renderer's Uint8Array arrives as a
        // JSON array of numbers.
        tauri::ipc::InvokeBody::Json(v) => serde_json::from_value::<Vec<u8>>(v.clone())
            .map_err(|e| format!("bad invoke body: {e}"))?,
    };
    let out = tauri::async_runtime::spawn_blocking(move || inference::ort_engine::run_frame(&bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(out))
}

/// Base64 frame transport for Android, where invoke() payloads are JSON —
/// a base64 string parses ~3x faster than a numeric array of the same bytes.
#[tauri::command]
async fn native_ort_run_b64(frame_b64: String) -> Result<Value, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&frame_b64)
        .map_err(|e| format!("bad frame base64: {e}"))?;
    let out = tauri::async_runtime::spawn_blocking(move || inference::ort_engine::run_frame(&bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({ "frameB64": base64::engine::general_purpose::STANDARD.encode(out) }))
}

// --- LiteRT (Basic Pitch) ---

#[tauri::command]
async fn native_tflite_init(lib_path: Option<String>) -> Result<Value, String> {
    let p = lib_path.clone();
    tauri::async_runtime::spawn_blocking(move || inference::tflite::init(p.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_tflite_load_model(
    model_id: String,
    model_path: String,
    num_threads: Option<i32>,
    use_accelerator: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inference::tflite::load_model(
            &model_id,
            &model_path,
            num_threads,
            use_accelerator.unwrap_or(true),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_tflite_run(model_id: String, inputs: Vec<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || inference::tflite::run(&model_id, &inputs))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_tflite_unload(model_id: String) -> Result<Value, String> {
    Ok(json!({ "unloaded": inference::tflite::unload(&model_id) }))
}

#[tauri::command]
async fn native_tflite_status() -> Result<Value, String> {
    Ok(inference::tflite::status())
}

// --- Audio export / integrity ---

#[tauri::command]
async fn native_export_wav(
    samples_b64: String,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    path: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inference::audio_export::export_wav(&samples_b64, sample_rate, channels, bits_per_sample, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn native_sha256_file(path: String) -> Result<Value, String> {
    let p = path.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || inference::audio_export::sha256_file(&p))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({ "path": path, "sha256": digest }))
}

// ============================ Legacy SVS / audio stubs ============================
//
// These were Electron main-process inference commands. Under Tauri the
// inference pipeline lives in the renderer (src/inference/webnn), so these
// return graceful errors. The renderer's WebNN path does not call them; they
// exist only so legacy code paths don't throw "no such command" at startup.

#[tauri::command]
async fn svs_init() -> Result<(), String> {
    Err("svs:init is legacy; use the WebNN renderer pipeline".to_string())
}

#[tauri::command]
async fn svs_synthesize(_data: Value) -> Result<Value, String> {
    Err("svs:synthesize is legacy; use the WebNN renderer pipeline".to_string())
}

#[tauri::command]
async fn svs_synthesize_multi_streaming(_data: Value) -> Result<Value, String> {
    Err("svs:synthesizeMultiStreaming is legacy; use the WebNN renderer pipeline".to_string())
}

#[tauri::command]
async fn svs_dispose() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn svs_check_jp_models() -> Result<Value, String> {
    Ok(json!({ "installed": false }))
}

#[tauri::command]
async fn fragment_svs_get_sample_rate() -> Result<i32, String> {
    Ok(44100)
}

#[tauri::command]
async fn fragment_svs_init() -> Result<(), String> {
    Err("fragment-svs:init is legacy; use the WebNN renderer pipeline".to_string())
}

#[tauri::command]
async fn fragment_svs_synthesize(_data: Value) -> Result<Value, String> {
    Err("fragment-svs:synthesize is legacy; use the WebNN renderer pipeline".to_string())
}

#[tauri::command]
async fn fragment_svs_resolve_phonemes(_lyrics: Value) -> Result<Value, String> {
    Ok(json!({ "phonemes": [] }))
}

#[tauri::command]
async fn fragment_svs_dispose() -> Result<(), String> {
    Ok(())
}

// ============================ Fragment / project persistence ============================

#[tauri::command]
async fn save_fragment_data(app: AppHandle, fragment_id: String, data: Value) -> Result<(), String> {
    let dir = fragments_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", fragment_id));
    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_fragment_data(app: AppHandle, fragment_id: String) -> Result<Value, String> {
    let path = fragments_dir(&app).join(format!("{}.json", fragment_id));
    if !path.exists() {
        return Ok(json!(null));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_fragment_editor(_app: AppHandle, _data: Value) -> Result<(), String> {
    // Tauri single-window: fragment editor runs in-page. No-op.
    Ok(())
}

#[tauri::command]
async fn fragment_close(_app: AppHandle, _fragment_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn fragment_close_all(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_fragment_bounds(_app: AppHandle, _fragment_id: String, _data: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_project_settings(_app: AppHandle, _project_data: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn open_singer_creator(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn open_singer_market(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn open_audio_preprocess(_app: AppHandle, _data: Value) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn send_preprocess_data(_app: AppHandle, _data: Value) -> Result<(), String> {
    Ok(())
}

fn fragments_dir(app: &AppHandle) -> PathBuf {
    let settings = models::read_settings(app);
    let model_dir = models::resolve_model_dir(app, &settings);
    model_dir.join("fragments")
}

// ============================ MIDI / pitch extraction (renderer-side) ============================

#[tauri::command]
async fn extract_f0_onnx(_app: AppHandle, _data: Value) -> Result<Value, String> {
    Err("F0 extraction runs in the renderer (rmvpe WASM)".to_string())
}

#[tauri::command]
async fn extract_midi_rosvot(_app: AppHandle, _data: Value) -> Result<Value, String> {
    Err("MIDI extraction runs in the renderer".to_string())
}

#[tauri::command]
async fn extract_f0_basic_pitch(_app: AppHandle, _data: Value) -> Result<Value, String> {
    Err("Basic Pitch runs in the renderer (tfjs WASM)".to_string())
}

#[tauri::command]
async fn midi_import(app: AppHandle) -> Result<Value, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("MIDI", &["mid", "midi"])
        .set_title("Import MIDI")
        .blocking_pick_file();
    match picked {
        Some(path) => {
            let bytes = std::fs::read(path.to_string()).map_err(|e| e.to_string())?;
            Ok(json!({ "path": path.to_string(), "data": bytes }))
        }
        None => Ok(json!(null)),
    }
}

#[tauri::command]
async fn midi_import_multi_track(app: AppHandle) -> Result<Value, String> {
    midi_import(app).await
}

// ============================ Audio device stubs ============================
//
// Audio playback uses WebAudio in the renderer. These legacy IPC commands
// return empty/error so settings UI doesn't crash.

#[tauri::command]
async fn audio_get_devices() -> Result<Value, String> {
    Ok(json!({ "devices": [], "defaultDevice": null }))
}

#[tauri::command]
async fn audio_play(_audio_data: Value, _options: Option<Value>) -> Result<(), String> {
    Err("audio:play is legacy; use WebAudio in renderer".to_string())
}

#[tauri::command]
async fn audio_stop() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn audio_get_position() -> Result<f64, String> {
    Ok(0.0)
}

#[tauri::command]
async fn audio_is_available() -> Result<bool, String> {
    Ok(false)
}

// ============================ Settings: hardware/device stubs ============================

#[tauri::command]
async fn settings_get_dml_devices() -> Result<Value, String> {
    // DirectML is Windows/Electron-only; under Tauri the renderer uses WebNN.
    Ok(json!([]))
}

#[tauri::command]
async fn settings_get_hardware_status() -> Result<Value, String> {
    Ok(json!({ "backend": "webnn", "available": false }))
}

#[tauri::command]
async fn settings_get_current_hardware() -> Result<Value, String> {
    Ok(json!({ "backend": "webnn", "device": null }))
}

#[tauri::command]
async fn settings_get_vocoder_chunk_frames_info() -> Result<Value, String> {
    Ok(json!({ "available": false }))
}

#[tauri::command]
async fn settings_get_vocoder_chunk_frames_table() -> Result<Value, String> {
    Ok(json!([]))
}

#[tauri::command]
async fn settings_validate_devices() -> Result<Value, String> {
    Ok(json!({ "valid": true }))
}

// ============================ Window / menu stubs ============================

#[tauri::command]
async fn set_dirty(_app: AppHandle, _dirty: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn close_confirmed(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

// ============================ Resource manager stubs ============================

#[tauri::command]
async fn resmgr_open(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn resmgr_get_gpu_info() -> Result<Value, String> {
    Ok(json!({ "available": false, "name": null, "backend": "webnn" }))
}

#[tauri::command]
async fn resmgr_get_model_groups() -> Result<Value, String> {
    // Return a minimal group listing derived from the manifest. The full
    // registry lives in src/modelRegistry.js (renderer); this is a fallback.
    Ok(json!([
        { "id": "svs", "name": "SVS Pipeline", "required": true, "models": [] }
    ]))
}

#[tauri::command]
async fn resmgr_load_model(_app: AppHandle, _group_id: String, _model_id: String) -> Result<(), String> {
    Err("Model loading is renderer-only (WebNN)".to_string())
}

#[tauri::command]
async fn resmgr_unload_model(_app: AppHandle, _group_id: String, _model_id: String) -> Result<(), String> {
    Err("Model unloading is renderer-only (WebNN)".to_string())
}

#[tauri::command]
async fn resmgr_load_group(_app: AppHandle, _group_id: String) -> Result<(), String> {
    Err("Model loading is renderer-only (WebNN)".to_string())
}

#[tauri::command]
async fn resmgr_unload_group(_app: AppHandle, _group_id: String) -> Result<(), String> {
    Err("Model unloading is renderer-only (WebNN)".to_string())
}

// ============================ Update stubs ============================

#[tauri::command]
async fn update_check_now() -> Result<Value, String> {
    Ok(json!({ "available": false }))
}

#[tauri::command]
async fn update_get_status() -> Result<Value, String> {
    Ok(json!({ "available": false, "lastCheck": null }))
}

#[tauri::command]
async fn update_skip_version(_version: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_dont_remind() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_open_download_page(app: AppHandle, url: String) -> Result<(), String> {
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_open_model_download(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_download_installer(_url: String, _version: String) -> Result<(), String> {
    Err("Installer download is not supported on this platform".to_string())
}

#[tauri::command]
async fn update_cancel_download() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn update_install_installer(_file_path: String) -> Result<(), String> {
    Err("Installer installation is not supported on this platform".to_string())
}

// ============================ Singer market stubs ============================

#[tauri::command]
async fn singer_market_login(_username: String, _password: String) -> Result<Value, String> {
    Err("Singer market login is not available in this build".to_string())
}

#[tauri::command]
async fn singer_market_register(_username: String, _password: String) -> Result<Value, String> {
    Err("Singer market registration is not available in this build".to_string())
}

#[tauri::command]
async fn singer_market_logout() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn singer_market_me() -> Result<Value, String> {
    Ok(json!(null))
}

#[tauri::command]
async fn singer_market_list(_params: Value) -> Result<Value, String> {
    Ok(json!({ "items": [], "total": 0 }))
}

#[tauri::command]
async fn singer_market_file_detail(_file_id: String) -> Result<Value, String> {
    Err("Singer market is not available in this build".to_string())
}

#[tauri::command]
async fn singer_market_tags(_params: Value) -> Result<Value, String> {
    Ok(json!([]))
}

#[tauri::command]
async fn singer_market_upload(_payload: Value) -> Result<Value, String> {
    Err("Singer market upload is not available in this build".to_string())
}

#[tauri::command]
async fn singer_market_download(_file_id: String) -> Result<Value, String> {
    Err("Singer market download is not available in this build".to_string())
}

#[tauri::command]
async fn singer_market_pick_file(app: AppHandle) -> Result<Value, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Pick file")
        .blocking_pick_file();
    Ok(json!({ "path": picked.map(|p| p.to_string()) }))
}

#[tauri::command]
async fn singer_market_pick_save_path(app: AppHandle, suggested_name: Option<String>) -> Result<Value, String> {
    let mut builder = app.dialog().file().set_title("Save as");
    if let Some(name) = suggested_name {
        builder = builder.set_file_name(&name);
    }
    let picked = builder.blocking_save_file();
    Ok(json!({ "path": picked.map(|p| p.to_string()) }))
}

// ============================ Entry point ============================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            settings: Mutex::new(json!({})),
            model_dir: Mutex::new(String::new()),
        })
        .manage(DownloadState::new())
        .invoke_handler(tauri::generate_handler![
            // File ops
            save_file,
            read_file,
            read_file_buffer,
            file_exists,
            resolve_path,
            get_dir_name,
            show_item_in_folder,
            save_singer_file,
            // App / platform
            get_app_version,
            get_platform_info,
            get_model_dir,
            // Settings
            get_settings,
            save_settings,
            settings_check_models,
            // Locale
            get_locale,
            save_locale,
            reload_main_window,
            // Theme
            theme_bootstrap,
            theme_list,
            theme_get,
            theme_current,
            theme_apply,
            theme_save,
            theme_delete,
            theme_import,
            theme_export,
            theme_reset,
            // Model download
            model_download_start,
            model_download_cancel,
            model_download_check,
            model_download_get_dir,
            model_download_change_dir,
            model_download_recheck,
            model_download_delete_and_recheck,
            model_download_open,
            model_download_open_external,
            model_download_update,
            model_download_check_version,
            model_download_list_versions,
            model_download_check_all_versions,
            model_download_check_jp,
            model_download_start_jp,
            model_download_check_jp_exists,
            model_download_check_sifigan,
            model_download_start_sifigan,
            model_download_unload_sifigan,
            model_download_check_jp_version,
            model_download_check_sifigan_version,
            model_download_update_jp,
            model_download_update_sifigan,
            model_download_list_jp_versions,
            model_download_list_sifigan_versions,
            // WebNN
            webnn_read_model_file,
            webnn_detect_npu,
            webnn_load_model,
            webnn_unload_model,
            webnn_run_inference,
            webnn_get_status,
            // Native inference (ORT Mobile / LiteRT)
            native_ort_init,
            native_ort_detect_accelerators,
            native_ort_load_model,
            native_ort_unload_model,
            native_ort_status,
            native_ort_run,
            native_ort_run_b64,
            native_tflite_init,
            native_tflite_load_model,
            native_tflite_run,
            native_tflite_unload,
            native_tflite_status,
            native_export_wav,
            native_sha256_file,
            // Legacy SVS / audio
            svs_init,
            svs_synthesize,
            svs_synthesize_multi_streaming,
            svs_dispose,
            svs_check_jp_models,
            fragment_svs_get_sample_rate,
            fragment_svs_init,
            fragment_svs_synthesize,
            fragment_svs_resolve_phonemes,
            fragment_svs_dispose,
            // Fragment / project
            save_fragment_data,
            get_fragment_data,
            open_fragment_editor,
            fragment_close,
            fragment_close_all,
            update_fragment_bounds,
            update_project_settings,
            open_singer_creator,
            open_singer_market,
            open_audio_preprocess,
            send_preprocess_data,
            // MIDI / pitch
            extract_f0_onnx,
            extract_midi_rosvot,
            extract_f0_basic_pitch,
            midi_import,
            midi_import_multi_track,
            // Audio
            audio_get_devices,
            audio_play,
            audio_stop,
            audio_get_position,
            audio_is_available,
            // Settings hardware
            settings_get_dml_devices,
            settings_get_hardware_status,
            settings_get_current_hardware,
            settings_get_vocoder_chunk_frames_info,
            settings_get_vocoder_chunk_frames_table,
            settings_validate_devices,
            // Window / menu
            set_dirty,
            close_confirmed,
            // Resource manager
            resmgr_open,
            resmgr_get_gpu_info,
            resmgr_get_model_groups,
            resmgr_load_model,
            resmgr_unload_model,
            resmgr_load_group,
            resmgr_unload_group,
            // Update
            update_check_now,
            update_get_status,
            update_skip_version,
            update_dont_remind,
            update_open_download_page,
            update_open_model_download,
            update_download_installer,
            update_cancel_download,
            update_install_installer,
            // Singer market
            singer_market_login,
            singer_market_register,
            singer_market_logout,
            singer_market_me,
            singer_market_list,
            singer_market_file_detail,
            singer_market_tags,
            singer_market_upload,
            singer_market_download,
            singer_market_pick_file,
            singer_market_pick_save_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SXSEditor-Pad");
}
