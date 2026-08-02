//! Theme bootstrap & lookup.
//!
//! Built-in theme JSON files are embedded at compile time via `include_str!`
//! so the Tauri backend can answer `theme:bootstrap` / `theme:get` without any
//! filesystem dependency. This replaces the old Electron main-process theme
//! IPC (src/main/themeIpc.js) which read the same JSON files from disk.

use serde_json::{json, Value};

// Embed the four built-in themes that ship with src/themes/builtins/.
const DARK_AURORA: &str = include_str!("../../src/themes/builtins/dark-aurora.theme.json");
const LIGHT_PAPER: &str = include_str!("../../src/themes/builtins/light-paper.theme.json");
const MIDNIGHT_AMBER: &str = include_str!("../../src/themes/builtins/midnight-amber.theme.json");
const ACG: &str = include_str!("../../src/themes/builtins/acg.theme.json");

/// Return the raw parsed JSON for a built-in theme id, or None if unknown.
pub fn builtin_theme(theme_id: &str) -> Option<Value> {
    let raw = match theme_id {
        "dark-aurora" => DARK_AURORA,
        "light-paper" => LIGHT_PAPER,
        "midnight-amber" => MIDNIGHT_AMBER,
        "acg" => ACG,
        _ => return None,
    };
    serde_json::from_str(raw).ok()
}

/// List of built-in theme ids.
pub fn builtin_theme_ids() -> Vec<&'static str> {
    vec!["dark-aurora", "light-paper", "midnight-amber", "acg"]
}

/// Resolve the effective theme id from a settings JSON value.
/// Falls back to "dark-aurora" (the default) when unset.
pub fn effective_theme_id(settings: &Value) -> String {
    settings
        .get("theme")
        .and_then(|v| v.as_str())
        .filter(|s| builtin_theme(s).is_some())
        .unwrap_or("dark-aurora")
        .to_string()
}

/// Build the bootstrap payload returned by `theme:bootstrap`.
/// Shape mirrors the old Electron IPC: `{ themeId, currentTheme: { tokens } }`.
pub fn bootstrap_payload(settings: &Value) -> Value {
    let theme_id = effective_theme_id(settings);
    let current_theme = builtin_theme(&theme_id).unwrap_or_else(|| json!({}));
    json!({
        "themeId": theme_id,
        "currentTheme": current_theme,
    })
}

/// Build a listing payload: array of `{ id, name, isDark }` summaries.
pub fn list_payload() -> Value {
    let ids = builtin_theme_ids();
    let summaries: Vec<Value> = ids
        .iter()
        .filter_map(|id| builtin_theme(id))
        .map(|t| {
            json!({
                "id": t.get("id").cloned().unwrap_or(json!(null)),
                "name": t.get("name").cloned().unwrap_or(json!(null)),
                "isDark": t.get("isDark").cloned().unwrap_or(json!(true)),
            })
        })
        .collect();
    Value::Array(summaries)
}
