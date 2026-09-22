//! Tauri app-config identity: legacy → primary verified migration and active path env.
//!
//! Pure std/serde only. Call prepare before any Tauri init so consumers resolve via
//! `CCMAX_TAURI_APP_CONFIG_DIR` without flipping the bundle identifier yet.
//!
//! Verified handoff algorithm lives in [`crate::profile_handoff`]; this module owns
//! product identifiers, env keys, portable policy, and the app-config wrapper.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::profile_handoff::{
    self, commit_primary as handoff_commit_primary,
    commit_primary_with as handoff_commit_primary_with,
    copy_profile_tree as handoff_copy_profile_tree, prepare_profile_handoff,
    prepare_profile_handoff_with, resolve_profile_handoff_paths, ProfileHandoffPaths,
    ProfileHandoffResult, ProfileHandoffSource, ProfileHandoffSpec,
};

pub use crate::profile_handoff::{
    is_usable_primary, list_tree_relative_paths, verify_copied_tree, ManifestEntry,
    PrimaryProfileClass,
};

/// Published Tauri bundle identifier before the ccmax rebrand.
pub const LEGACY_APP_IDENTIFIER: &str = "com.claude-code-haha.desktop";
/// Target Tauri bundle identifier for the ccmax product.
pub const PRIMARY_APP_IDENTIFIER: &str = "com.ccmax.desktop";

/// Process-local active app-config path (not user-facing).
pub const ACTIVE_APP_CONFIG_ENV: &str = "CCMAX_TAURI_APP_CONFIG_DIR";
/// New portable-mode marker written by startup.
pub const PORTABLE_DIR_ENV: &str = "CCMAX_APP_PORTABLE_DIR";
/// Legacy portable-mode marker (compat read path).
pub const LEGACY_PORTABLE_DIR_ENV: &str = "CC_HAHA_APP_PORTABLE_DIR";

pub const PRIMARY_MIGRATION_OWNERSHIP_MARKER: &str = ".ccmax.tauri.appConfig.migration.ownership";
pub const PRIMARY_MIGRATION_COMPLETION_MARKER: &str = ".ccmax.tauri.appConfig.migration.complete";

const MIGRATION_LOCK_DIR_NAME: &str = "ccmax.tauri.appConfig.migrating.lock";
const TEMP_DIR_PREFIX: &str = "ccmax.tauri.appConfig.migrating-";

const APP_CONFIG_HANDOFF_SPEC: ProfileHandoffSpec = ProfileHandoffSpec {
    ownership_marker: PRIMARY_MIGRATION_OWNERSHIP_MARKER,
    completion_marker: PRIMARY_MIGRATION_COMPLETION_MARKER,
    lock_dir_name: MIGRATION_LOCK_DIR_NAME,
    temp_dir_prefix: TEMP_DIR_PREFIX,
    log_label: "app-config",
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfigProfilePaths {
    pub config_base: PathBuf,
    pub legacy_path: PathBuf,
    pub primary_path: PathBuf,
    pub lock_path: PathBuf,
}

impl AppConfigProfilePaths {
    fn to_handoff(&self) -> ProfileHandoffPaths {
        ProfileHandoffPaths {
            base: self.config_base.clone(),
            legacy_path: self.legacy_path.clone(),
            primary_path: self.primary_path.clone(),
            lock_path: self.lock_path.clone(),
        }
    }
}

pub type AppConfigProfileSource = ProfileHandoffSource;
pub type PrepareAppConfigProfileResult = ProfileHandoffResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemOs {
    Windows,
    Macos,
    Linux,
}

/// Pure system config base resolution with injectable env values.
pub fn resolve_system_config_base(
    os: SystemOs,
    appdata: Option<&str>,
    home: Option<&str>,
    xdg_config_home: Option<&str>,
) -> Option<PathBuf> {
    match os {
        SystemOs::Windows => appdata.filter(|v| !v.is_empty()).map(PathBuf::from),
        SystemOs::Macos => home
            .filter(|v| !v.is_empty())
            .map(|h| PathBuf::from(h).join("Library").join("Application Support")),
        SystemOs::Linux => {
            if let Some(xdg) = xdg_config_home.filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(xdg));
            }
            home.filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".config"))
        }
    }
}

/// Resolve system config base from the real process environment.
pub fn resolve_system_config_base_runtime() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        resolve_system_config_base(
            SystemOs::Windows,
            std::env::var("APPDATA").ok().as_deref(),
            None,
            None,
        )
    }
    #[cfg(target_os = "macos")]
    {
        resolve_system_config_base(
            SystemOs::Macos,
            None,
            std::env::var("HOME").ok().as_deref(),
            None,
        )
    }
    #[cfg(target_os = "linux")]
    {
        resolve_system_config_base(
            SystemOs::Linux,
            None,
            std::env::var("HOME").ok().as_deref(),
            std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        resolve_system_config_base(
            SystemOs::Linux,
            None,
            std::env::var("HOME").ok().as_deref(),
            std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        )
    }
}

pub fn resolve_app_config_profile_paths(config_base: impl AsRef<Path>) -> AppConfigProfilePaths {
    let handoff = resolve_profile_handoff_paths(
        config_base,
        LEGACY_APP_IDENTIFIER,
        PRIMARY_APP_IDENTIFIER,
        &APP_CONFIG_HANDOFF_SPEC,
    );
    AppConfigProfilePaths {
        config_base: handoff.base,
        legacy_path: handoff.legacy_path,
        primary_path: handoff.primary_path,
        lock_path: handoff.lock_path,
    }
}

pub fn set_active_app_config_env(active_path: impl AsRef<Path>) {
    std::env::set_var(
        ACTIVE_APP_CONFIG_ENV,
        active_path.as_ref().to_string_lossy().as_ref(),
    );
}

pub fn prepared_active_app_config_dir() -> Option<PathBuf> {
    std::env::var_os(ACTIVE_APP_CONFIG_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Portable marker: new env wins over legacy.
pub fn is_portable_dir_marker_set() -> bool {
    if std::env::var_os(PORTABLE_DIR_ENV).is_some() {
        return true;
    }
    std::env::var_os(LEGACY_PORTABLE_DIR_ENV).is_some()
}

pub fn mark_portable_dir_env() {
    std::env::set_var(PORTABLE_DIR_ENV, "1");
    // Keep legacy marker for any residual consumers that only know the old key.
    std::env::set_var(LEGACY_PORTABLE_DIR_ENV, "1");
}

/// Unified active app-config resolver (pure, injectable).
/// Priority: portable CLAUDE_CONFIG_DIR > prepared env > tauri default.
pub fn resolve_active_app_config_dir(
    claude_config_dir: Option<PathBuf>,
    prepared_active: Option<PathBuf>,
    tauri_default: Option<PathBuf>,
) -> Option<PathBuf> {
    claude_config_dir
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| prepared_active.filter(|p| !p.as_os_str().is_empty()))
        .or(tauri_default)
}

/// Runtime resolver using process env + optional Tauri default.
pub fn resolve_active_app_config_dir_runtime(tauri_default: Option<PathBuf>) -> Option<PathBuf> {
    resolve_active_app_config_dir(
        std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from),
        prepared_active_app_config_dir(),
        tauri_default,
    )
}

/// Classify primary without treating empty / in-progress dirs as ready.
pub fn classify_primary(primary_path: &Path) -> io::Result<PrimaryProfileClass> {
    profile_handoff::classify_primary(&APP_CONFIG_HANDOFF_SPEC, primary_path)
}

/// Walk a profile tree without following symlinks. Special files are rejected.
pub fn copy_profile_tree(source_root: &Path, dest_root: &Path) -> io::Result<Vec<ManifestEntry>> {
    handoff_copy_profile_tree(&APP_CONFIG_HANDOFF_SPEC, source_root, dest_root)
}

/// Publish verified temp → primary without directory-rename replacement.
pub fn commit_primary(temp_path: &Path, primary_path: &Path) -> io::Result<()> {
    handoff_commit_primary(&APP_CONFIG_HANDOFF_SPEC, temp_path, primary_path)
}

pub fn commit_primary_with<M, R, E>(
    temp_path: &Path,
    primary_path: &Path,
    mkdir_root: M,
    move_entry: R,
    exists: E,
) -> io::Result<()>
where
    M: Fn(&Path) -> io::Result<()>,
    R: Fn(&Path, &Path) -> io::Result<()>,
    E: Fn(&Path) -> io::Result<bool>,
{
    handoff_commit_primary_with(
        &APP_CONFIG_HANDOFF_SPEC,
        temp_path,
        primary_path,
        mkdir_root,
        move_entry,
        exists,
    )
}

/// Choose the active Tauri app-config path before any Tauri init.
/// Never deletes the legacy profile and never overwrites an existing primary.
pub fn prepare_app_config_profile(config_base: impl AsRef<Path>) -> PrepareAppConfigProfileResult {
    let paths = resolve_app_config_profile_paths(config_base);
    prepare_profile_handoff(&APP_CONFIG_HANDOFF_SPEC, &paths.to_handoff())
}

/// Testable prepare with optional commit injection and custom logger.
pub fn prepare_app_config_profile_with<L>(
    config_base: impl AsRef<Path>,
    log: L,
    commit_override: Option<Box<dyn Fn(&Path, &Path) -> io::Result<()> + Send + Sync>>,
) -> PrepareAppConfigProfileResult
where
    L: Fn(&str),
{
    let paths = resolve_app_config_profile_paths(config_base);
    prepare_profile_handoff_with(
        &APP_CONFIG_HANDOFF_SPEC,
        &paths.to_handoff(),
        log,
        commit_override,
    )
}

/// Prepare using the runtime system config base and publish active path to env.
pub fn prepare_and_publish_active_app_config() -> Option<PrepareAppConfigProfileResult> {
    let base = resolve_system_config_base_runtime()?;
    // Ensure base exists so lock/temp sibling paths can be created when needed.
    let _ = fs::create_dir_all(&base);
    let result = prepare_app_config_profile(&base);
    set_active_app_config_env(&result.active_path);
    Some(result)
}

/// Ordered system app-mode lookup roots: primary first, then active/legacy (deduped).
pub fn system_app_mode_lookup_dirs(
    config_base: &Path,
    prepared_active: Option<&Path>,
) -> Vec<PathBuf> {
    let paths = resolve_app_config_profile_paths(config_base);
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();

    let push = |dirs: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf| {
        if seen.insert(path.clone()) {
            dirs.push(path);
        }
    };

    push(&mut dirs, &mut seen, paths.primary_path);
    if let Some(active) = prepared_active {
        push(&mut dirs, &mut seen, active.to_path_buf());
    }
    push(&mut dirs, &mut seen, paths.legacy_path);
    dirs
}

/// Targets that should receive app-mode writes for next-boot consistency.
pub fn system_app_mode_write_dirs(
    config_base: &Path,
    prepared_active: Option<&Path>,
) -> Vec<PathBuf> {
    let paths = resolve_app_config_profile_paths(config_base);
    let mut dirs = Vec::new();
    let mut seen = HashSet::new();
    let push = |dirs: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf| {
        if seen.insert(path.clone()) {
            dirs.push(path);
        }
    };
    push(&mut dirs, &mut seen, paths.primary_path);
    if let Some(active) = prepared_active {
        push(&mut dirs, &mut seen, active.to_path_buf());
    }
    dirs
}

/// Detect portable fingerprints, including both product namespaces.
pub fn dir_has_portable_data(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    [
        "settings.json",
        ".claude.json",
        ".mcp.json",
        "window-state.json",
        "terminal-config.json",
    ]
    .iter()
    .any(|f| dir.join(f).is_file())
        || dir.join("Cache").is_dir()
        || dir.join("EBWebView").is_dir()
        || dir.join("projects").is_dir()
        || dir.join("skills").is_dir()
        || dir.join("plugins").is_dir()
        || dir.join("cowork_plugins").is_dir()
        || dir.join("cc-haha").is_dir()
        || dir.join("ccmax").is_dir()
}

/// Read mode + optional portable_dir from app-mode.json under `dir`.
pub fn read_app_mode_from_dir(dir: &Path) -> Option<(String, Option<PathBuf>)> {
    let path = dir.join("app-mode.json");
    let data = fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&data).ok()?;
    let mode = parsed
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("default")
        .to_ascii_lowercase();
    let portable_dir = parsed
        .get("portable_dir")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    Some((mode, portable_dir))
}

/// Resolve portable startup dir from ordered mode sources (pure).
///
/// Priority: local portable config > primary system > prepared active/legacy
/// (deduped via `system_dirs`) > auto-detect. Explicit `default` stops fallback.
pub fn determine_portable_dir_from_sources(
    default_portable: &Path,
    system_dirs: &[PathBuf],
    external_claude_config_set: bool,
) -> Option<PathBuf> {
    if external_claude_config_set {
        return None;
    }

    if let Some((mode, portable_dir)) = read_app_mode_from_dir(default_portable) {
        if mode == "portable" {
            if dir_has_portable_data(default_portable) {
                return Some(default_portable.to_path_buf());
            }
            return Some(portable_dir.unwrap_or_else(|| default_portable.to_path_buf()));
        }
        // Explicit default stops further fallback.
        return None;
    }

    for dir in system_dirs {
        if let Some((mode, portable_dir)) = read_app_mode_from_dir(dir) {
            if mode == "portable" {
                return Some(portable_dir.unwrap_or_else(|| default_portable.to_path_buf()));
            }
            return None;
        }
    }

    if dir_has_portable_data(default_portable) {
        return Some(default_portable.to_path_buf());
    }

    None
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
            "ccmax-tauri-identity-{}-{}-{}",
            label,
            std::process::id(),
            profile_handoff::random_token_hex()
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
    fn system_config_base_resolves_per_os() {
        assert_eq!(
            resolve_system_config_base(
                SystemOs::Windows,
                Some(r"C:\Users\a\AppData\Roaming"),
                None,
                None
            ),
            Some(PathBuf::from(r"C:\Users\a\AppData\Roaming"))
        );
        assert_eq!(
            resolve_system_config_base(SystemOs::Macos, None, Some("/Users/a"), None),
            Some(PathBuf::from("/Users/a/Library/Application Support"))
        );
        assert_eq!(
            resolve_system_config_base(
                SystemOs::Linux,
                None,
                Some("/home/a"),
                Some("/custom/config")
            ),
            Some(PathBuf::from("/custom/config"))
        );
        assert_eq!(
            resolve_system_config_base(SystemOs::Linux, None, Some("/home/a"), None),
            Some(PathBuf::from("/home/a/.config"))
        );
    }

    #[test]
    fn active_resolver_priority_portable_prepared_default() {
        let portable = PathBuf::from("/portable");
        let prepared = PathBuf::from("/prepared");
        let def = PathBuf::from("/default");
        assert_eq!(
            resolve_active_app_config_dir(
                Some(portable.clone()),
                Some(prepared.clone()),
                Some(def.clone())
            ),
            Some(portable)
        );
        assert_eq!(
            resolve_active_app_config_dir(None, Some(prepared.clone()), Some(def.clone())),
            Some(prepared)
        );
        assert_eq!(
            resolve_active_app_config_dir(None, None, Some(def.clone())),
            Some(def)
        );
        assert_eq!(resolve_active_app_config_dir(None, None, None), None);
    }

    #[test]
    fn app_config_wrapper_migrates_with_product_markers_and_log_label() {
        let root = temp_root("wrapper-migrate");
        let paths = resolve_app_config_profile_paths(&root);
        write_file(
            &paths.legacy_path.join("Preferences"),
            r#"{"theme":"dark"}"#,
        );

        let logs = std::sync::Mutex::new(Vec::<String>::new());
        let result = prepare_app_config_profile_with(
            &root,
            |msg| logs.lock().unwrap().push(msg.to_string()),
            None,
        );
        assert_eq!(result.source, AppConfigProfileSource::Migrated);
        assert_eq!(result.reason, "migrated-from-legacy");
        assert_eq!(result.active_path, paths.primary_path);
        assert!(paths
            .primary_path
            .join(PRIMARY_MIGRATION_COMPLETION_MARKER)
            .exists());
        assert!(!paths
            .primary_path
            .join(PRIMARY_MIGRATION_OWNERSHIP_MARKER)
            .exists());
        assert_eq!(
            fs::read_to_string(paths.legacy_path.join("Preferences")).unwrap(),
            r#"{"theme":"dark"}"#
        );
        // Successful migrate path does not emit failure logs; lock-held path would.
        let _ = logs;
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn app_config_wrapper_log_label_on_lock_held() {
        let root = temp_root("wrapper-log");
        let paths = resolve_app_config_profile_paths(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");
        fs::create_dir_all(&paths.lock_path).unwrap();

        let logs = std::sync::Mutex::new(Vec::<String>::new());
        let result = prepare_app_config_profile_with(
            &root,
            |msg| logs.lock().unwrap().push(msg.to_string()),
            None,
        );
        assert_eq!(result.reason, "migration-lock-held");
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|m| { m == "[desktop] app-config migration lock held; using legacy profile" }));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_fingerprint_recognizes_ccmax_and_cc_haha() {
        let root = temp_root("fingerprint");
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(a.join("ccmax")).unwrap();
        fs::create_dir_all(b.join("cc-haha")).unwrap();
        assert!(dir_has_portable_data(&a));
        assert!(dir_has_portable_data(&b));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_mode_priority_and_explicit_default_stops() {
        let root = temp_root("portable-mode");
        let default_portable = root.join("CLAUDE_CONFIG_DIR");
        let primary = root.join(PRIMARY_APP_IDENTIFIER);
        let legacy = root.join(LEGACY_APP_IDENTIFIER);
        fs::create_dir_all(&default_portable).unwrap();
        fs::create_dir_all(&primary).unwrap();
        fs::create_dir_all(&legacy).unwrap();

        write_file(
            &default_portable.join("app-mode.json"),
            r#"{"mode":"default"}"#,
        );
        write_file(
            &primary.join("app-mode.json"),
            r#"{"mode":"portable","portable_dir":"/from-primary"}"#,
        );
        // Explicit default on local portable stops fallback.
        assert!(determine_portable_dir_from_sources(
            &default_portable,
            &[primary.clone(), legacy.clone()],
            false,
        )
        .is_none());

        fs::remove_file(default_portable.join("app-mode.json")).unwrap();
        let resolved = determine_portable_dir_from_sources(
            &default_portable,
            &[primary.clone(), legacy.clone()],
            false,
        );
        assert_eq!(resolved, Some(PathBuf::from("/from-primary")));

        // External CLAUDE_CONFIG_DIR wins.
        assert!(
            determine_portable_dir_from_sources(&default_portable, &[primary], true,).is_none()
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_marker_prefers_new_env() {
        let _guard = env_lock().lock().unwrap();
        std::env::remove_var(PORTABLE_DIR_ENV);
        std::env::remove_var(LEGACY_PORTABLE_DIR_ENV);
        assert!(!is_portable_dir_marker_set());
        std::env::set_var(LEGACY_PORTABLE_DIR_ENV, "1");
        assert!(is_portable_dir_marker_set());
        std::env::set_var(PORTABLE_DIR_ENV, "1");
        assert!(is_portable_dir_marker_set());
        std::env::remove_var(PORTABLE_DIR_ENV);
        std::env::remove_var(LEGACY_PORTABLE_DIR_ENV);
    }

    #[test]
    fn active_env_roundtrip() {
        let _guard = env_lock().lock().unwrap();
        let path = PathBuf::from("/tmp/ccmax-active-test");
        set_active_app_config_env(&path);
        assert_eq!(prepared_active_app_config_dir(), Some(path));
        std::env::remove_var(ACTIVE_APP_CONFIG_ENV);
    }

    #[test]
    fn identifiers_and_paths_match_product_spec() {
        assert_eq!(LEGACY_APP_IDENTIFIER, "com.claude-code-haha.desktop");
        assert_eq!(PRIMARY_APP_IDENTIFIER, "com.ccmax.desktop");
        let paths = resolve_app_config_profile_paths("/cfg");
        assert_eq!(
            paths.legacy_path,
            PathBuf::from("/cfg").join(LEGACY_APP_IDENTIFIER)
        );
        assert_eq!(
            paths.primary_path,
            PathBuf::from("/cfg").join(PRIMARY_APP_IDENTIFIER)
        );
        assert_eq!(
            paths.lock_path,
            PathBuf::from("/cfg").join(MIGRATION_LOCK_DIR_NAME)
        );
        assert_eq!(paths.config_base, PathBuf::from("/cfg"));
    }
}
