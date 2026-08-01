use std::sync::Mutex;
use tauri::State;

// Mobile entry point (required for Android/iOS builds)
#[cfg(mobile)]
tauri::mobile_entry_point!();

// Application state
pub struct AppState {
    pub settings: Mutex<serde_json::Value>,
    pub model_dir: Mutex<String>,
    pub cached_dml_devices: Mutex<Vec<serde_json::Value>>,
}

// File operations
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
async fn get_app_version() -> Result<String, String> {
    Ok("1.0.0".to_string())
}

#[tauri::command]
async fn get_model_dir(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.model_dir.lock().unwrap().clone())
}

#[tauri::command]
async fn file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let settings = state.settings.lock().unwrap();
    Ok(settings.clone())
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, settings: serde_json::Value) -> Result<(), String> {
    let mut current = state.settings.lock().unwrap();
    *current = settings;
    Ok(())
}

// Settings file operations
#[tauri::command]
async fn load_settings_file() -> Result<serde_json::Value, String> {
    let settings_path = get_settings_path();
    if settings_path.exists() {
        let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    } else {
        Ok(serde_json::json!({
            "locale": "zh-CN",
            "theme": "dark-aurora",
            "deviceMode": "smart",
            "updateChannel": "release",
            "autoCheckUpdates": true
        }))
    }
}

#[tauri::command]
async fn save_settings_file(settings: serde_json::Value) -> Result<(), String> {
    let settings_path = get_settings_path();
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, &content).map_err(|e| e.to_string())
}

fn get_settings_path() -> std::path::PathBuf {
    let mut path = dirs_next().unwrap_or_else(|| std::path::PathBuf::from("."));
    path.push("SXSEditor-Pad");
    path.push("settings.json");
    path
}

fn dirs_next() -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        Some(std::path::PathBuf::from(dir))
    } else if let Ok(dir) = std::env::var("HOME") {
        let mut path = std::path::PathBuf::from(dir);
        path.push(".config");
        Some(path)
    } else {
        None
    }
}

// Singer file operations
#[tauri::command]
async fn save_singer_file(name: String, data: serde_json::Value) -> Result<(), String> {
    let model_dir = get_model_dir_path();
    let singers_dir = model_dir.join("singers");
    std::fs::create_dir_all(&singers_dir).map_err(|e| e.to_string())?;
    let file_path = singers_dir.join(format!("{}.json", name));
    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, &content).map_err(|e| e.to_string())
}

fn get_model_dir_path() -> std::path::PathBuf {
    let mut path = dirs_next().unwrap_or_else(|| std::path::PathBuf::from("."));
    path.push("SXSEditor-Pad");
    path.push("models");
    path
}

// Shell operations
#[tauri::command]
async fn show_item_in_folder(_path: String) -> Result<(), String> {
    Ok(())
}

// Application info
#[tauri::command]
async fn get_platform_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "isMobile": cfg!(target_os = "android") || cfg!(target_os = "ios")
    }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            settings: Mutex::new(serde_json::json!({})),
            model_dir: Mutex::new(get_model_dir_path().to_string_lossy().to_string()),
            cached_dml_devices: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            save_file,
            read_file,
            read_file_buffer,
            file_exists,
            get_app_version,
            get_model_dir,
            get_settings,
            save_settings,
            load_settings_file,
            save_settings_file,
            save_singer_file,
            show_item_in_folder,
            get_platform_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SXSEditor-Pad");
}