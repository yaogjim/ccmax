// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

fn main() {
    // 1) Always prepare app-config identity before any Tauri/WebView2 init.
    // Active path is published to CCMAX_TAURI_APP_CONFIG_DIR for lib consumers.
    let prepared = ccmax_lib::app_identity::prepare_and_publish_active_app_config();

    // 2) Portable Claude config: external CLAUDE_CONFIG_DIR still highest.
    // Otherwise resolve portable mode from local / primary / active|legacy / auto-detect.
    if let Some(portable_dir) = determine_startup_portable_dir(prepared.as_ref()) {
        std::env::set_var(
            "CLAUDE_CONFIG_DIR",
            portable_dir.to_string_lossy().to_string(),
        );
        ccmax_lib::app_identity::mark_portable_dir_env();
    }

    // If CLAUDE_CONFIG_DIR is set (external or our startup logic),
    // redirect WebView2 user data folder so EBWebView cache lives alongside it.
    if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let webview_data = PathBuf::from(&config_dir).join("EBWebView");
        if let Err(e) = fs::create_dir_all(&webview_data) {
            eprintln!("[desktop] failed to create EBWebView dir: {e}");
        }
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_data);
    }

    // 3) WebView profile policy after portable / WebView2 override, before run().
    // Publishes CCMAX_TAURI_WEBVIEW_DATA_DIR for later main/preview builders.
    let _ = ccmax_lib::webview_identity::prepare_and_publish_active_webview_profile();

    ccmax_lib::run()
}

/// Determine if we should start in portable mode.
/// Returns the portable config directory path if yes, None for default mode.
fn determine_startup_portable_dir(
    prepared: Option<&ccmax_lib::app_identity::PrepareAppConfigProfileResult>,
) -> Option<PathBuf> {
    use ccmax_lib::app_identity::{
        determine_portable_dir_from_sources, resolve_system_config_base_runtime,
        system_app_mode_lookup_dirs,
    };

    let external_set = std::env::var("CLAUDE_CONFIG_DIR").is_ok();
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let mut default_portable = exe_dir.to_path_buf();
    default_portable.push("CLAUDE_CONFIG_DIR");

    let system_dirs = match resolve_system_config_base_runtime() {
        Some(base) => {
            let active = prepared.map(|p| p.active_path.as_path());
            system_app_mode_lookup_dirs(&base, active)
        }
        None => Vec::new(),
    };

    determine_portable_dir_from_sources(&default_portable, &system_dirs, external_set)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccmax_lib::app_identity::{
        determine_portable_dir_from_sources, dir_has_portable_data,
        resolve_app_config_profile_paths, resolve_system_config_base, system_app_mode_lookup_dirs,
        SystemOs, LEGACY_APP_IDENTIFIER, PRIMARY_APP_IDENTIFIER,
    };
    use std::fs;
    use std::path::Path;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ccmax-tauri-main-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn app_mode_lookup_primary_before_legacy_deduped() {
        let root = temp_root("lookup");
        let paths = resolve_app_config_profile_paths(&root);
        let dirs = system_app_mode_lookup_dirs(&root, Some(&paths.primary_path));
        assert_eq!(dirs[0], paths.primary_path);
        assert!(dirs.iter().any(|d| d == &paths.legacy_path));
        // primary appears once even when also passed as prepared active
        assert_eq!(dirs.iter().filter(|d| *d == &paths.primary_path).count(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_auto_detect_ccmax_namespace() {
        let root = temp_root("auto-ccmax");
        let portable = root.join("CLAUDE_CONFIG_DIR");
        fs::create_dir_all(portable.join("ccmax")).unwrap();
        assert!(dir_has_portable_data(&portable));
        let resolved = determine_portable_dir_from_sources(&portable, &[], false);
        assert_eq!(resolved, Some(portable));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn system_base_identifiers_match_spec() {
        assert_eq!(LEGACY_APP_IDENTIFIER, "com.claude-code-haha.desktop");
        assert_eq!(PRIMARY_APP_IDENTIFIER, "com.ccmax.desktop");
        let base =
            resolve_system_config_base(SystemOs::Windows, Some("C:/AppData"), None, None).unwrap();
        let paths = resolve_app_config_profile_paths(base);
        assert!(paths.legacy_path.ends_with("com.claude-code-haha.desktop"));
        assert!(paths.primary_path.ends_with("com.ccmax.desktop"));
    }

    #[test]
    fn local_portable_mode_wins_over_system() {
        let root = temp_root("local-wins");
        let portable = root.join("CLAUDE_CONFIG_DIR");
        let primary = root.join(PRIMARY_APP_IDENTIFIER);
        fs::create_dir_all(&portable).unwrap();
        fs::create_dir_all(&primary).unwrap();
        write_file(&portable.join("app-mode.json"), r#"{"mode":"portable"}"#);
        write_file(
            &primary.join("app-mode.json"),
            r#"{"mode":"portable","portable_dir":"/system-should-not-win"}"#,
        );
        // Local portable without data uses default portable path (not system custom).
        let resolved = determine_portable_dir_from_sources(&portable, &[primary], false);
        assert_eq!(resolved, Some(portable));
        let _ = fs::remove_dir_all(&root);
    }
}
