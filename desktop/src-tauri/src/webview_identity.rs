//! Tauri WebView identity/policy: resolve and prepare the active data directory
//! before any WebView is created.
//!
//! - Windows: non-empty `WEBVIEW2_USER_DATA_FOLDER` wins (no system handoff).
//! - Windows/Linux system: LocalData/`<identifier>` handoff via Stage23 engine.
//! - macOS: no builder data directory (default WKWebView store).
//!
//! Product identifiers come from [`crate::app_identity`]; handoff algorithm from
//! [`crate::profile_handoff`]. This module does not copy migration logic.

use std::fs;
use std::path::{Path, PathBuf};

use crate::app_identity::{LEGACY_APP_IDENTIFIER, PRIMARY_APP_IDENTIFIER};
use crate::profile_handoff::{
    prepare_profile_handoff, prepare_profile_handoff_with, resolve_profile_handoff_paths,
    ProfileHandoffPaths, ProfileHandoffResult, ProfileHandoffSource, ProfileHandoffSpec,
};

/// Process-local active WebView data path for main/preview builders (not user-facing).
pub const ACTIVE_WEBVIEW_DATA_ENV: &str = "CCMAX_TAURI_WEBVIEW_DATA_DIR";

/// Official WebView2 override consumed only on Windows policy paths.
pub const WEBVIEW2_USER_DATA_FOLDER_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";

pub const PRIMARY_MIGRATION_OWNERSHIP_MARKER: &str = ".ccmax.tauri.webview.migration.ownership";
pub const PRIMARY_MIGRATION_COMPLETION_MARKER: &str = ".ccmax.tauri.webview.migration.complete";

const MIGRATION_LOCK_DIR_NAME: &str = "ccmax.tauri.webview.migrating.lock";
const TEMP_DIR_PREFIX: &str = "ccmax.tauri.webview.migrating-";

const WEBVIEW_HANDOFF_SPEC: ProfileHandoffSpec = ProfileHandoffSpec {
    ownership_marker: PRIMARY_MIGRATION_OWNERSHIP_MARKER,
    completion_marker: PRIMARY_MIGRATION_COMPLETION_MARKER,
    lock_dir_name: MIGRATION_LOCK_DIR_NAME,
    temp_dir_prefix: TEMP_DIR_PREFIX,
    log_label: "webview",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebViewOs {
    Windows,
    Macos,
    Linux,
}

/// How the active WebView data path was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebViewProfileSource {
    /// Windows `WEBVIEW2_USER_DATA_FOLDER` override (no system handoff).
    Override,
    Primary,
    Legacy,
    Migrated,
    /// macOS default store, or missing system base — no builder data directory.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrepareWebViewProfileResult {
    /// Path for builder `data_directory` injection; `None` means leave Tauri default.
    pub active_path: Option<PathBuf>,
    pub source: WebViewProfileSource,
    pub reason: String,
}

/// Pure system LocalData base resolution with injectable env values.
/// Matches Tauri 2.10.3 WebView data_directory: Windows LOCALAPPDATA;
/// Linux XDG_DATA_HOME, else HOME/.local/share. macOS is unsupported here.
pub fn resolve_system_local_data_base(
    os: WebViewOs,
    localappdata: Option<&str>,
    home: Option<&str>,
    xdg_data_home: Option<&str>,
) -> Option<PathBuf> {
    match os {
        WebViewOs::Windows => localappdata.filter(|v| !v.is_empty()).map(PathBuf::from),
        WebViewOs::Linux => {
            if let Some(xdg) = xdg_data_home.filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(xdg));
            }
            home.filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".local").join("share"))
        }
        WebViewOs::Macos => None,
    }
}

/// Resolve system LocalData base from the real process environment.
pub fn resolve_system_local_data_base_runtime() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        resolve_system_local_data_base(
            WebViewOs::Windows,
            std::env::var("LOCALAPPDATA").ok().as_deref(),
            None,
            None,
        )
    }
    #[cfg(target_os = "macos")]
    {
        resolve_system_local_data_base(WebViewOs::Macos, None, None, None)
    }
    #[cfg(target_os = "linux")]
    {
        resolve_system_local_data_base(
            WebViewOs::Linux,
            None,
            std::env::var("HOME").ok().as_deref(),
            std::env::var("XDG_DATA_HOME").ok().as_deref(),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        resolve_system_local_data_base(
            WebViewOs::Linux,
            None,
            std::env::var("HOME").ok().as_deref(),
            std::env::var("XDG_DATA_HOME").ok().as_deref(),
        )
    }
}

/// Non-empty WebView2 user-data override path (Windows priority input).
pub fn non_empty_webview2_override(value: Option<&str>) -> Option<PathBuf> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Resolve legacy/primary/lock paths under a LocalData base using product identifiers.
pub fn resolve_webview_profile_paths(data_base: impl AsRef<Path>) -> ProfileHandoffPaths {
    resolve_profile_handoff_paths(
        data_base,
        LEGACY_APP_IDENTIFIER,
        PRIMARY_APP_IDENTIFIER,
        &WEBVIEW_HANDOFF_SPEC,
    )
}

/// Pure policy plan: override / system handoff / no data directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebViewProfilePlan {
    UseOverride(PathBuf),
    SystemHandoff { data_base: PathBuf },
    NoDataDirectory { reason: &'static str },
}

/// Pure priority resolver (no FS side effects).
///
/// Windows: non-empty `WEBVIEW2_USER_DATA_FOLDER` > system LocalData handoff.
/// Linux: always system LocalData handoff (override ignored).
/// macOS: no builder data directory.
pub fn plan_webview_profile(
    os: WebViewOs,
    webview2_user_data_folder: Option<&str>,
    localappdata: Option<&str>,
    home: Option<&str>,
    xdg_data_home: Option<&str>,
) -> WebViewProfilePlan {
    match os {
        WebViewOs::Macos => WebViewProfilePlan::NoDataDirectory {
            reason: "macos-default-store",
        },
        WebViewOs::Windows => {
            if let Some(override_path) = non_empty_webview2_override(webview2_user_data_folder) {
                return WebViewProfilePlan::UseOverride(override_path);
            }
            match resolve_system_local_data_base(os, localappdata, home, xdg_data_home) {
                Some(data_base) => WebViewProfilePlan::SystemHandoff { data_base },
                None => WebViewProfilePlan::NoDataDirectory {
                    reason: "missing-localappdata",
                },
            }
        }
        WebViewOs::Linux => {
            // Linux does not consume WEBVIEW2_USER_DATA_FOLDER; keep Tauri LocalData semantics.
            match resolve_system_local_data_base(os, localappdata, home, xdg_data_home) {
                Some(data_base) => WebViewProfilePlan::SystemHandoff { data_base },
                None => WebViewProfilePlan::NoDataDirectory {
                    reason: "missing-linux-data-home",
                },
            }
        }
    }
}

fn map_handoff_result(result: ProfileHandoffResult) -> PrepareWebViewProfileResult {
    let source = match result.source {
        ProfileHandoffSource::Primary => WebViewProfileSource::Primary,
        ProfileHandoffSource::Legacy => WebViewProfileSource::Legacy,
        ProfileHandoffSource::Migrated => WebViewProfileSource::Migrated,
    };
    PrepareWebViewProfileResult {
        active_path: Some(result.active_path),
        source,
        reason: result.reason,
    }
}

/// Run system identifier-tree handoff under `data_base` via the unique engine.
pub fn prepare_system_webview_profile(data_base: impl AsRef<Path>) -> ProfileHandoffResult {
    let paths = resolve_webview_profile_paths(data_base);
    prepare_profile_handoff(&WEBVIEW_HANDOFF_SPEC, &paths)
}

/// Testable system handoff with optional commit injection and custom logger.
pub fn prepare_system_webview_profile_with<L>(
    data_base: impl AsRef<Path>,
    log: L,
    commit_override: Option<Box<dyn Fn(&Path, &Path) -> std::io::Result<()> + Send + Sync>>,
) -> ProfileHandoffResult
where
    L: Fn(&str),
{
    let paths = resolve_webview_profile_paths(data_base);
    prepare_profile_handoff_with(&WEBVIEW_HANDOFF_SPEC, &paths, log, commit_override)
}

/// Prepare active WebView profile for a given OS and injectable inputs (no env publish).
pub fn prepare_webview_profile(
    os: WebViewOs,
    webview2_user_data_folder: Option<&str>,
    localappdata: Option<&str>,
    home: Option<&str>,
    xdg_data_home: Option<&str>,
) -> PrepareWebViewProfileResult {
    match plan_webview_profile(
        os,
        webview2_user_data_folder,
        localappdata,
        home,
        xdg_data_home,
    ) {
        WebViewProfilePlan::UseOverride(path) => PrepareWebViewProfileResult {
            active_path: Some(path),
            source: WebViewProfileSource::Override,
            reason: "webview2-user-data-folder".to_string(),
        },
        WebViewProfilePlan::NoDataDirectory { reason } => PrepareWebViewProfileResult {
            active_path: None,
            source: WebViewProfileSource::None,
            reason: reason.to_string(),
        },
        WebViewProfilePlan::SystemHandoff { data_base } => {
            let _ = fs::create_dir_all(&data_base);
            map_handoff_result(prepare_system_webview_profile(&data_base))
        }
    }
}

/// Testable prepare that forces a system base (still honors Windows override priority).
pub fn prepare_webview_profile_with_base(
    os: WebViewOs,
    webview2_user_data_folder: Option<&str>,
    data_base: Option<&Path>,
) -> PrepareWebViewProfileResult {
    match os {
        WebViewOs::Macos => PrepareWebViewProfileResult {
            active_path: None,
            source: WebViewProfileSource::None,
            reason: "macos-default-store".to_string(),
        },
        WebViewOs::Windows => {
            if let Some(path) = non_empty_webview2_override(webview2_user_data_folder) {
                return PrepareWebViewProfileResult {
                    active_path: Some(path),
                    source: WebViewProfileSource::Override,
                    reason: "webview2-user-data-folder".to_string(),
                };
            }
            match data_base {
                Some(base) => {
                    let _ = fs::create_dir_all(base);
                    map_handoff_result(prepare_system_webview_profile(base))
                }
                None => PrepareWebViewProfileResult {
                    active_path: None,
                    source: WebViewProfileSource::None,
                    reason: "missing-localappdata".to_string(),
                },
            }
        }
        WebViewOs::Linux => match data_base {
            Some(base) => {
                let _ = fs::create_dir_all(base);
                map_handoff_result(prepare_system_webview_profile(base))
            }
            None => PrepareWebViewProfileResult {
                active_path: None,
                source: WebViewProfileSource::None,
                reason: "missing-linux-data-home".to_string(),
            },
        },
    }
}

pub fn set_active_webview_data_env(active_path: impl AsRef<Path>) {
    std::env::set_var(
        ACTIVE_WEBVIEW_DATA_ENV,
        active_path.as_ref().to_string_lossy().as_ref(),
    );
}

pub fn prepared_active_webview_data_dir() -> Option<PathBuf> {
    std::env::var_os(ACTIVE_WEBVIEW_DATA_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn clear_active_webview_data_env() {
    std::env::remove_var(ACTIVE_WEBVIEW_DATA_ENV);
}

fn current_webview_os() -> WebViewOs {
    #[cfg(target_os = "windows")]
    {
        WebViewOs::Windows
    }
    #[cfg(target_os = "macos")]
    {
        WebViewOs::Macos
    }
    #[cfg(target_os = "linux")]
    {
        WebViewOs::Linux
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        WebViewOs::Linux
    }
}

/// Prepare using runtime OS/env and publish active path for later builders.
///
/// Must run after app-config/portable/`WEBVIEW2_USER_DATA_FOLDER` decisions and
/// before `run()`. Never overwrites an existing `WEBVIEW2_USER_DATA_FOLDER`.
pub fn prepare_and_publish_active_webview_profile() -> PrepareWebViewProfileResult {
    let webview2 = std::env::var(WEBVIEW2_USER_DATA_FOLDER_ENV).ok();
    let result = prepare_webview_profile(
        current_webview_os(),
        webview2.as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
    );
    match &result.active_path {
        Some(path) => set_active_webview_data_env(path),
        None => clear_active_webview_data_env(),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ccmax-tauri-webview-{}-{}-{}",
            label,
            std::process::id(),
            crate::profile_handoff::random_token_hex()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn write_file(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn system_local_data_base_resolves_per_os() {
        assert_eq!(
            resolve_system_local_data_base(
                WebViewOs::Windows,
                Some(r"C:\Users\a\AppData\Local"),
                None,
                None
            ),
            Some(PathBuf::from(r"C:\Users\a\AppData\Local"))
        );
        assert_eq!(
            resolve_system_local_data_base(WebViewOs::Macos, None, Some("/Users/a"), None),
            None
        );
        assert_eq!(
            resolve_system_local_data_base(
                WebViewOs::Linux,
                None,
                Some("/home/a"),
                Some("/custom/data")
            ),
            Some(PathBuf::from("/custom/data"))
        );
        assert_eq!(
            resolve_system_local_data_base(WebViewOs::Linux, None, Some("/home/a"), None),
            Some(PathBuf::from("/home/a/.local/share"))
        );
        assert_eq!(
            resolve_system_local_data_base(WebViewOs::Linux, None, None, None),
            None
        );
    }

    #[test]
    fn plan_windows_override_beats_system_base() {
        let plan = plan_webview_profile(
            WebViewOs::Windows,
            Some(r"D:\portable\EBWebView"),
            Some(r"C:\Users\a\AppData\Local"),
            None,
            None,
        );
        assert_eq!(
            plan,
            WebViewProfilePlan::UseOverride(PathBuf::from(r"D:\portable\EBWebView"))
        );
    }

    #[test]
    fn plan_linux_ignores_webview2_override() {
        let plan = plan_webview_profile(
            WebViewOs::Linux,
            Some("/portable/EBWebView"),
            None,
            Some("/home/a"),
            None,
        );
        assert_eq!(
            plan,
            WebViewProfilePlan::SystemHandoff {
                data_base: PathBuf::from("/home/a/.local/share"),
            }
        );
    }

    #[test]
    fn plan_macos_is_noop() {
        let plan = plan_webview_profile(WebViewOs::Macos, Some("/x"), None, Some("/Users/a"), None);
        assert_eq!(
            plan,
            WebViewProfilePlan::NoDataDirectory {
                reason: "macos-default-store",
            }
        );
    }

    #[test]
    fn profile_paths_reuse_app_identity_identifiers() {
        let paths = resolve_webview_profile_paths("/local");
        assert_eq!(
            paths.legacy_path,
            PathBuf::from("/local").join(LEGACY_APP_IDENTIFIER)
        );
        assert_eq!(
            paths.primary_path,
            PathBuf::from("/local").join(PRIMARY_APP_IDENTIFIER)
        );
        assert_eq!(
            paths.lock_path,
            PathBuf::from("/local").join(MIGRATION_LOCK_DIR_NAME)
        );
        assert_eq!(paths.base, PathBuf::from("/local"));
        assert_eq!(LEGACY_APP_IDENTIFIER, "com.claude-code-haha.desktop");
        assert_eq!(PRIMARY_APP_IDENTIFIER, "com.ccmax.desktop");
    }

    #[test]
    fn windows_override_does_not_copy_system_legacy() {
        let root = temp_root("win-override");
        let paths = resolve_webview_profile_paths(&root);
        write_file(&paths.legacy_path.join("Cookies"), "legacy-cookie");
        let override_path = root.join("portable-EBWebView");
        fs::create_dir_all(&override_path).unwrap();

        let result = prepare_webview_profile_with_base(
            WebViewOs::Windows,
            Some(override_path.to_str().unwrap()),
            Some(&root),
        );
        assert_eq!(result.source, WebViewProfileSource::Override);
        assert_eq!(result.active_path.as_ref(), Some(&override_path));
        assert_eq!(result.reason, "webview2-user-data-folder");
        // System handoff must not run: primary absent, legacy untouched only.
        assert!(!paths.primary_path.exists());
        assert_eq!(
            fs::read_to_string(paths.legacy_path.join("Cookies")).unwrap(),
            "legacy-cookie"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn windows_system_legacy_migrates_to_primary() {
        let root = temp_root("win-migrate");
        let paths = resolve_webview_profile_paths(&root);
        write_file(&paths.legacy_path.join("Local State"), r#"{"a":1}"#);

        let result = prepare_webview_profile_with_base(WebViewOs::Windows, None, Some(&root));
        assert_eq!(result.source, WebViewProfileSource::Migrated);
        assert_eq!(result.active_path.as_ref(), Some(&paths.primary_path));
        assert!(paths
            .primary_path
            .join(PRIMARY_MIGRATION_COMPLETION_MARKER)
            .exists());
        assert!(!paths
            .primary_path
            .join(PRIMARY_MIGRATION_OWNERSHIP_MARKER)
            .exists());
        assert_eq!(
            fs::read_to_string(paths.legacy_path.join("Local State")).unwrap(),
            r#"{"a":1}"#
        );
        assert_eq!(
            fs::read_to_string(paths.primary_path.join("Local State")).unwrap(),
            r#"{"a":1}"#
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn linux_system_legacy_migrates_to_primary() {
        let root = temp_root("linux-migrate");
        let paths = resolve_webview_profile_paths(&root);
        write_file(&paths.legacy_path.join("Default").join("Cookies"), "c");

        // Override present but Linux must ignore it.
        let result = prepare_webview_profile_with_base(
            WebViewOs::Linux,
            Some("/should-not-use"),
            Some(&root),
        );
        assert_eq!(result.source, WebViewProfileSource::Migrated);
        assert_eq!(result.active_path.as_ref(), Some(&paths.primary_path));
        assert!(paths.primary_path.join("Default").join("Cookies").exists());
        assert!(paths.legacy_path.join("Default").join("Cookies").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_primary_is_not_overwritten() {
        let root = temp_root("primary-exists");
        let paths = resolve_webview_profile_paths(&root);
        write_file(&paths.legacy_path.join("from-legacy"), "L");
        write_file(&paths.primary_path.join("from-primary"), "P");

        let result = prepare_system_webview_profile(&root);
        assert_eq!(result.source, ProfileHandoffSource::Primary);
        assert_eq!(result.active_path, paths.primary_path);
        assert_eq!(
            fs::read_to_string(paths.primary_path.join("from-primary")).unwrap(),
            "P"
        );
        assert!(!paths.primary_path.join("from-legacy").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_commit_falls_back_to_legacy() {
        let root = temp_root("fail-fallback");
        let paths = resolve_webview_profile_paths(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");

        let result = prepare_system_webview_profile_with(
            &root,
            |_| {},
            Some(Box::new(|_temp, _primary| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "inject-commit-failure",
                ))
            })),
        );
        assert_eq!(result.source, ProfileHandoffSource::Legacy);
        assert_eq!(result.active_path, paths.legacy_path);
        assert!(
            !paths.primary_path.exists() || {
                // primary may be absent or incomplete; must not be usable complete migration
                !paths
                    .primary_path
                    .join(PRIMARY_MIGRATION_COMPLETION_MARKER)
                    .exists()
            }
        );
        assert_eq!(
            fs::read_to_string(paths.legacy_path.join("keep.txt")).unwrap(),
            "legacy"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn macos_prepare_is_noop_without_handoff() {
        let root = temp_root("macos-noop");
        let paths = resolve_webview_profile_paths(&root);
        write_file(&paths.legacy_path.join("Cookies"), "legacy");

        let result = prepare_webview_profile_with_base(WebViewOs::Macos, None, Some(&root));
        assert_eq!(result.source, WebViewProfileSource::None);
        assert_eq!(result.active_path, None);
        assert!(!paths.primary_path.exists());
        assert!(paths.legacy_path.join("Cookies").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn active_env_publish_and_clear() {
        let _guard = env_lock().lock().unwrap();
        let path = PathBuf::from("/tmp/ccmax-webview-active-test");
        set_active_webview_data_env(&path);
        assert_eq!(prepared_active_webview_data_dir(), Some(path));
        clear_active_webview_data_env();
        assert_eq!(prepared_active_webview_data_dir(), None);
    }

    #[test]
    fn prepare_and_publish_macos_runtime_clears_active_env() {
        let _guard = env_lock().lock().unwrap();
        // Only meaningful on macOS host; still exercises publish path when OS is macOS.
        if current_webview_os() != WebViewOs::Macos {
            return;
        }
        set_active_webview_data_env("/stale");
        let result = prepare_and_publish_active_webview_profile();
        assert_eq!(result.source, WebViewProfileSource::None);
        assert_eq!(result.active_path, None);
        assert_eq!(prepared_active_webview_data_dir(), None);
    }

    #[test]
    fn webview_markers_and_log_label_are_product_specific() {
        assert_eq!(
            WEBVIEW_HANDOFF_SPEC.ownership_marker,
            PRIMARY_MIGRATION_OWNERSHIP_MARKER
        );
        assert_eq!(
            WEBVIEW_HANDOFF_SPEC.completion_marker,
            PRIMARY_MIGRATION_COMPLETION_MARKER
        );
        assert_eq!(WEBVIEW_HANDOFF_SPEC.lock_dir_name, MIGRATION_LOCK_DIR_NAME);
        assert_eq!(WEBVIEW_HANDOFF_SPEC.temp_dir_prefix, TEMP_DIR_PREFIX);
        assert_eq!(WEBVIEW_HANDOFF_SPEC.log_label, "webview");
        // Distinct from app-config product markers.
        assert_ne!(
            PRIMARY_MIGRATION_OWNERSHIP_MARKER,
            crate::app_identity::PRIMARY_MIGRATION_OWNERSHIP_MARKER
        );
    }
}
