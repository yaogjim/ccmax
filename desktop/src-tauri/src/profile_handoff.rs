//! Parameterized verified profile handoff engine.
//!
//! Product wrappers supply marker/lock/temp/log labels via [`ProfileHandoffSpec`].
//! This module must not hard-code app-config product names.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Product-specific names that drive markers, lock/temp siblings, and log text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileHandoffSpec {
    pub ownership_marker: &'static str,
    pub completion_marker: &'static str,
    pub lock_dir_name: &'static str,
    pub temp_dir_prefix: &'static str,
    /// Inserted into `[desktop] {log_label} ...` messages.
    pub log_label: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileHandoffPaths {
    pub base: PathBuf,
    pub legacy_path: PathBuf,
    pub primary_path: PathBuf,
    pub lock_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileHandoffSource {
    Primary,
    Legacy,
    Migrated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileHandoffResult {
    pub active_path: PathBuf,
    pub source: ProfileHandoffSource,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimaryProfileClass {
    Absent,
    Empty,
    InProgress,
    ExistingUserState,
    CompleteByMigration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestEntry {
    Directory {
        relative_path: String,
    },
    File {
        relative_path: String,
        size: u64,
    },
    Symlink {
        relative_path: String,
        target: String,
    },
}

impl ManifestEntry {
    pub fn relative_path(&self) -> &str {
        match self {
            ManifestEntry::Directory { relative_path }
            | ManifestEntry::File { relative_path, .. }
            | ManifestEntry::Symlink { relative_path, .. } => relative_path,
        }
    }
}

pub fn default_log(message: &str) {
    eprintln!("{message}");
}

fn reserved_marker_names(spec: &ProfileHandoffSpec) -> HashSet<&'static str> {
    let mut set = HashSet::new();
    set.insert(spec.ownership_marker);
    set.insert(spec.completion_marker);
    set
}

fn assert_not_reserved_top_level_name(
    spec: &ProfileHandoffSpec,
    name: &str,
    context: &str,
) -> io::Result<()> {
    if reserved_marker_names(spec).contains(name) {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            format!("reserved migration marker present in {context}: {name}"),
        ));
    }
    Ok(())
}

pub fn random_token_hex() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    format!("{pid:x}{nanos:x}{counter:x}")
}

pub fn resolve_profile_handoff_paths(
    base: impl AsRef<Path>,
    legacy_dir_name: &str,
    primary_dir_name: &str,
    spec: &ProfileHandoffSpec,
) -> ProfileHandoffPaths {
    let base = base.as_ref().to_path_buf();
    ProfileHandoffPaths {
        legacy_path: base.join(legacy_dir_name),
        primary_path: base.join(primary_dir_name),
        lock_path: base.join(spec.lock_dir_name),
        base,
    }
}

fn path_exists(target: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(target) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

fn is_present_directory(target: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(target) {
        Ok(meta) => Ok(meta.is_dir() && !meta.file_type().is_symlink()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// Classify primary without treating empty / in-progress dirs as ready.
pub fn classify_primary(
    spec: &ProfileHandoffSpec,
    primary_path: &Path,
) -> io::Result<PrimaryProfileClass> {
    let meta = match fs::symlink_metadata(primary_path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(PrimaryProfileClass::Absent),
        Err(err) => return Err(err),
    };

    if !meta.is_dir() || meta.file_type().is_symlink() {
        // Non-directory primary must never be overwritten by migration.
        return Ok(PrimaryProfileClass::ExistingUserState);
    }

    let mut names = Vec::new();
    for entry in fs::read_dir(primary_path)? {
        names.push(entry?.file_name());
    }
    if names.is_empty() {
        return Ok(PrimaryProfileClass::Empty);
    }

    let has_ownership = names.iter().any(|n| n == spec.ownership_marker);
    let has_completion = names.iter().any(|n| n == spec.completion_marker);

    if has_ownership {
        return Ok(PrimaryProfileClass::InProgress);
    }
    if has_completion {
        return Ok(PrimaryProfileClass::CompleteByMigration);
    }
    Ok(PrimaryProfileClass::ExistingUserState)
}

pub fn is_usable_primary(classification: PrimaryProfileClass) -> bool {
    matches!(
        classification,
        PrimaryProfileClass::ExistingUserState | PrimaryProfileClass::CompleteByMigration
    )
}

fn acquire_lock(lock_path: &Path) -> io::Result<bool> {
    match fs::create_dir(lock_path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
}

fn release_lock(lock_path: &Path) {
    let _ = fs::remove_dir_all(lock_path);
}

fn create_temp_dir(spec: &ProfileHandoffSpec, base: &Path) -> io::Result<PathBuf> {
    let temp_path = base.join(format!(
        "{}{}-{}",
        spec.temp_dir_prefix,
        std::process::id(),
        random_token_hex()
    ));
    fs::create_dir(&temp_path)?;
    Ok(temp_path)
}

fn remove_path(target: &Path) {
    let _ = fs::remove_dir_all(target);
    let _ = fs::remove_file(target);
}

pub fn mkdir_exclusive(target: &Path) -> io::Result<()> {
    fs::create_dir(target)
}

pub fn rename_path(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

pub fn create_symlink(target: &Path, link: &Path, is_dir: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        let _ = is_dir;
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        if is_dir {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link, is_dir);
        Err(io::Error::new(
            ErrorKind::Unsupported,
            "symlink creation is not supported on this platform",
        ))
    }
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    if relative.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative)
    }
}

/// Walk a profile tree without following symlinks. Special files are rejected.
pub fn copy_profile_tree(
    spec: &ProfileHandoffSpec,
    source_root: &Path,
    dest_root: &Path,
) -> io::Result<Vec<ManifestEntry>> {
    let mut manifest = vec![ManifestEntry::Directory {
        relative_path: String::new(),
    }];
    let mut queue: Vec<String> = vec![String::new()];

    while let Some(relative_dir) = queue.pop() {
        let source_dir = join_relative(source_root, &relative_dir);
        let dest_dir = join_relative(dest_root, &relative_dir);
        if !relative_dir.is_empty() {
            fs::create_dir(&dest_dir)?;
        }

        let mut entries: Vec<_> = fs::read_dir(&source_dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let relative_path = if relative_dir.is_empty() {
                name_str.to_string()
            } else {
                format!("{relative_dir}/{name_str}")
            };

            if relative_dir.is_empty() {
                assert_not_reserved_top_level_name(spec, &name_str, "legacy profile")?;
            }

            let source_path = join_relative(source_root, &relative_path);
            let dest_path = join_relative(dest_root, &relative_path);
            let snapshot = fs::symlink_metadata(&source_path)?;

            if snapshot.file_type().is_symlink() {
                let target = fs::read_link(&source_path)?;
                // Decide file/dir link from the link target's own metadata when possible;
                // fall back to non-dir symlink creation.
                let target_is_dir = fs::symlink_metadata(&source_path)
                    .ok()
                    .and_then(|_| {
                        // On Unix, symlink_metadata of the link is always a symlink; probe
                        // the target path relative to the link parent without following the
                        // original tree walk.
                        let parent = source_path.parent().unwrap_or(source_root);
                        let resolved = if target.is_absolute() {
                            target.clone()
                        } else {
                            parent.join(&target)
                        };
                        fs::metadata(&resolved).ok().map(|m| m.is_dir())
                    })
                    .unwrap_or(false);
                create_symlink(&target, &dest_path, target_is_dir)?;
                manifest.push(ManifestEntry::Symlink {
                    relative_path,
                    target: target.to_string_lossy().into_owned(),
                });
                continue;
            }

            if snapshot.is_dir() {
                manifest.push(ManifestEntry::Directory {
                    relative_path: relative_path.clone(),
                });
                queue.push(relative_path);
                continue;
            }

            if snapshot.is_file() {
                fs::copy(&source_path, &dest_path)?;
                manifest.push(ManifestEntry::File {
                    relative_path,
                    size: snapshot.len(),
                });
                continue;
            }

            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!("unsupported profile entry type at {relative_path}"),
            ));
        }
    }

    Ok(manifest)
}

/// Recursively list every relative path in a tree (root as ""). Does not follow symlinks.
pub fn list_tree_relative_paths(root: &Path) -> io::Result<HashSet<String>> {
    let mut found = HashSet::new();
    found.insert(String::new());
    let mut queue: Vec<String> = vec![String::new()];

    while let Some(relative_dir) = queue.pop() {
        let dir_path = join_relative(root, &relative_dir);
        let mut entries: Vec<_> = fs::read_dir(&dir_path)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            let relative_path = if relative_dir.is_empty() {
                name_str.to_string()
            } else {
                format!("{relative_dir}/{name_str}")
            };
            found.insert(relative_path.clone());
            let snapshot = fs::symlink_metadata(join_relative(root, &relative_path))?;
            if snapshot.is_dir() && !snapshot.file_type().is_symlink() {
                queue.push(relative_path);
            }
        }
    }

    Ok(found)
}

pub fn verify_copied_tree(
    source_root: &Path,
    dest_root: &Path,
    manifest: &[ManifestEntry],
) -> io::Result<()> {
    let mut expected_paths = HashSet::new();
    for entry in manifest {
        if !expected_paths.insert(entry.relative_path().to_string()) {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "manifest contains duplicate relative paths",
            ));
        }
    }

    let actual_dest_paths = list_tree_relative_paths(dest_root)?;
    for relative_path in &actual_dest_paths {
        if !expected_paths.contains(relative_path) {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "copied tree has unexpected entry {}",
                    if relative_path.is_empty() {
                        "."
                    } else {
                        relative_path
                    }
                ),
            ));
        }
    }
    for relative_path in &expected_paths {
        if !actual_dest_paths.contains(relative_path) {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "copied tree missing entry for {}",
                    if relative_path.is_empty() {
                        "."
                    } else {
                        relative_path
                    }
                ),
            ));
        }
    }

    for entry in manifest {
        let source_path = join_relative(source_root, entry.relative_path());
        let dest_path = join_relative(dest_root, entry.relative_path());
        let source_snapshot = fs::symlink_metadata(&source_path)?;
        let dest_snapshot = fs::symlink_metadata(&dest_path)?;

        match entry {
            ManifestEntry::Directory { relative_path } => {
                if !source_snapshot.is_dir() || source_snapshot.file_type().is_symlink() {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!(
                            "source directory missing for {}",
                            if relative_path.is_empty() {
                                "."
                            } else {
                                relative_path
                            }
                        ),
                    ));
                }
                if !dest_snapshot.is_dir() || dest_snapshot.file_type().is_symlink() {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!(
                            "copied directory missing for {}",
                            if relative_path.is_empty() {
                                "."
                            } else {
                                relative_path
                            }
                        ),
                    ));
                }
            }
            ManifestEntry::File {
                relative_path,
                size,
            } => {
                if !source_snapshot.is_file() || source_snapshot.file_type().is_symlink() {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!("source file missing for {relative_path}"),
                    ));
                }
                if !dest_snapshot.is_file() || dest_snapshot.file_type().is_symlink() {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!("copied file missing for {relative_path}"),
                    ));
                }
                if source_snapshot.len() != *size || dest_snapshot.len() != *size {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!("file size mismatch for {relative_path}"),
                    ));
                }
            }
            ManifestEntry::Symlink {
                relative_path,
                target,
            } => {
                if !source_snapshot.file_type().is_symlink()
                    || !dest_snapshot.file_type().is_symlink()
                {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!("symlink missing for {relative_path}"),
                    ));
                }
                let source_target = fs::read_link(&source_path)?;
                let dest_target = fs::read_link(&dest_path)?;
                if source_target.to_string_lossy() != *target
                    || dest_target.to_string_lossy() != *target
                {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        format!("symlink target mismatch for {relative_path}"),
                    ));
                }
            }
        }
    }

    Ok(())
}

fn try_cleanup_owned_primary(
    spec: &ProfileHandoffSpec,
    primary_path: &Path,
    ownership_token: &str,
    known_entries: &HashSet<String>,
) -> &'static str {
    let ownership_path = primary_path.join(spec.ownership_marker);
    let token_on_disk = match fs::read_to_string(&ownership_path) {
        Ok(token) => token,
        Err(_) => return "skipped",
    };
    if token_on_disk != ownership_token {
        return "skipped";
    }

    let names = match fs::read_dir(primary_path) {
        Ok(iter) => iter,
        Err(_) => return "skipped",
    };
    for entry in names.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !known_entries.contains(&name) {
            return "left-in-progress";
        }
    }

    match fs::remove_dir_all(primary_path) {
        Ok(()) => "cleaned",
        Err(_) => "skipped",
    }
}

/// Publish verified temp → primary without directory-rename replacement.
pub fn commit_primary(
    spec: &ProfileHandoffSpec,
    temp_path: &Path,
    primary_path: &Path,
) -> io::Result<()> {
    commit_primary_with(
        spec,
        temp_path,
        primary_path,
        mkdir_exclusive,
        rename_path,
        path_exists,
    )
}

pub fn commit_primary_with<M, R, E>(
    spec: &ProfileHandoffSpec,
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
    let mut claimed_root = false;
    let mut ownership_token: Option<String> = None;
    let mut known_entries: HashSet<String> = HashSet::new();

    let result = (|| {
        match mkdir_root(primary_path) {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    "primary profile already exists",
                ));
            }
            Err(err) => return Err(err),
        }
        claimed_root = true;

        let token = random_token_hex();
        let ownership_path = primary_path.join(spec.ownership_marker);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&ownership_path)?;
        file.write_all(token.as_bytes())?;
        ownership_token = Some(token);
        known_entries.insert(spec.ownership_marker.to_string());

        let mut top_entries: Vec<_> = fs::read_dir(temp_path)?.collect::<Result<Vec<_>, _>>()?;
        top_entries.sort_by_key(|e| e.file_name());

        for entry in top_entries {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().into_owned();
            assert_not_reserved_top_level_name(spec, &name_str, "temp profile")?;
            let from = temp_path.join(&name);
            let to = primary_path.join(&name);
            if exists(&to)? {
                return Err(io::Error::new(
                    ErrorKind::AlreadyExists,
                    format!("primary entry already exists: {name_str}"),
                ));
            }
            move_entry(&from, &to)?;
            known_entries.insert(name_str);
        }

        let completion_path = primary_path.join(spec.completion_marker);
        let mut completion = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&completion_path)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        writeln!(completion, "{stamp}")?;
        known_entries.insert(spec.completion_marker.to_string());

        fs::remove_file(&ownership_path)?;
        known_entries.remove(spec.ownership_marker);

        let _ = fs::remove_dir_all(temp_path);
        Ok(())
    })();

    if result.is_err() {
        if claimed_root {
            if let Some(token) = ownership_token.as_deref() {
                try_cleanup_owned_primary(spec, primary_path, token, &known_entries);
            }
        }
    }

    result
}

fn primary_result(primary_path: &Path, reason: &str) -> ProfileHandoffResult {
    ProfileHandoffResult {
        active_path: primary_path.to_path_buf(),
        source: ProfileHandoffSource::Primary,
        reason: reason.to_string(),
    }
}

fn legacy_result(legacy_path: &Path, reason: &str) -> ProfileHandoffResult {
    ProfileHandoffResult {
        active_path: legacy_path.to_path_buf(),
        source: ProfileHandoffSource::Legacy,
        reason: reason.to_string(),
    }
}

/// Choose the active profile path. Never deletes legacy and never overwrites existing primary.
pub fn prepare_profile_handoff(
    spec: &ProfileHandoffSpec,
    paths: &ProfileHandoffPaths,
) -> ProfileHandoffResult {
    prepare_profile_handoff_with(spec, paths, default_log, None)
}

/// Testable prepare with optional commit injection and custom logger.
pub fn prepare_profile_handoff_with<L>(
    spec: &ProfileHandoffSpec,
    paths: &ProfileHandoffPaths,
    log: L,
    commit_override: Option<Box<dyn Fn(&Path, &Path) -> io::Result<()> + Send + Sync>>,
) -> ProfileHandoffResult
where
    L: Fn(&str),
{
    let commit_fn = |temp: &Path, primary: &Path| -> io::Result<()> {
        if let Some(ref custom) = commit_override {
            custom(temp, primary)
        } else {
            commit_primary(spec, temp, primary)
        }
    };

    match prepare_inner(spec, paths, &log, &commit_fn) {
        Ok(result) => result,
        Err(err) => {
            log(&format!(
                "[desktop] {} profile prepare failed; attempting safe fallback: {err}",
                spec.log_label
            ));
            match classify_primary(spec, &paths.primary_path) {
                Ok(class) if is_usable_primary(class) => {
                    return primary_result(&paths.primary_path, "primary-after-outer-failure");
                }
                _ => {}
            }
            if is_present_directory(&paths.legacy_path).unwrap_or(false) {
                return legacy_result(&paths.legacy_path, "legacy-after-outer-failure");
            }
            primary_result(&paths.primary_path, "fallback-primary")
        }
    }
}

fn prepare_inner<L, C>(
    spec: &ProfileHandoffSpec,
    paths: &ProfileHandoffPaths,
    log: &L,
    commit_fn: &C,
) -> io::Result<ProfileHandoffResult>
where
    L: Fn(&str),
    C: Fn(&Path, &Path) -> io::Result<()>,
{
    let initial_primary = classify_primary(spec, &paths.primary_path)?;
    if is_usable_primary(initial_primary) {
        return Ok(primary_result(
            &paths.primary_path,
            if initial_primary == PrimaryProfileClass::CompleteByMigration {
                "primary-complete"
            } else {
                "primary-exists"
            },
        ));
    }

    let legacy_present = is_present_directory(&paths.legacy_path)?;
    if !legacy_present {
        return Ok(primary_result(&paths.primary_path, "neither-exists"));
    }

    if initial_primary == PrimaryProfileClass::Empty
        || initial_primary == PrimaryProfileClass::InProgress
    {
        return Ok(legacy_result(
            &paths.legacy_path,
            if initial_primary == PrimaryProfileClass::Empty {
                "primary-empty"
            } else {
                "primary-in-progress"
            },
        ));
    }

    let locked = acquire_lock(&paths.lock_path)?;
    if !locked {
        let after_contention = classify_primary(spec, &paths.primary_path)?;
        if is_usable_primary(after_contention) {
            return Ok(primary_result(
                &paths.primary_path,
                "primary-ready-after-contention",
            ));
        }
        log(&format!(
            "[desktop] {} migration lock held; using legacy profile",
            spec.log_label
        ));
        return Ok(legacy_result(&paths.legacy_path, "migration-lock-held"));
    }

    let mut temp_path: Option<PathBuf> = None;
    let outcome: io::Result<ProfileHandoffResult> = (|| {
        let after_lock = classify_primary(spec, &paths.primary_path)?;
        if is_usable_primary(after_lock) {
            return Ok(primary_result(
                &paths.primary_path,
                "primary-ready-after-lock",
            ));
        }
        if after_lock == PrimaryProfileClass::Empty || after_lock == PrimaryProfileClass::InProgress
        {
            return Ok(legacy_result(
                &paths.legacy_path,
                if after_lock == PrimaryProfileClass::Empty {
                    "primary-empty"
                } else {
                    "primary-in-progress"
                },
            ));
        }

        let created = create_temp_dir(spec, &paths.base)?;
        temp_path = Some(created.clone());
        let manifest = copy_profile_tree(spec, &paths.legacy_path, &created)?;
        verify_copied_tree(&paths.legacy_path, &created, &manifest)?;

        let before_commit = classify_primary(spec, &paths.primary_path)?;
        if is_usable_primary(before_commit) {
            remove_path(&created);
            temp_path = None;
            return Ok(primary_result(
                &paths.primary_path,
                "primary-ready-before-commit",
            ));
        }
        if before_commit == PrimaryProfileClass::Empty
            || before_commit == PrimaryProfileClass::InProgress
        {
            remove_path(&created);
            temp_path = None;
            return Ok(legacy_result(
                &paths.legacy_path,
                if before_commit == PrimaryProfileClass::Empty {
                    "primary-empty"
                } else {
                    "primary-in-progress"
                },
            ));
        }

        commit_fn(&created, &paths.primary_path)?;
        temp_path = None;
        Ok(ProfileHandoffResult {
            active_path: paths.primary_path.clone(),
            source: ProfileHandoffSource::Migrated,
            reason: "migrated-from-legacy".to_string(),
        })
    })();

    if let Some(temp) = temp_path.take() {
        remove_path(&temp);
    }
    release_lock(&paths.lock_path);

    match outcome {
        Ok(result) => Ok(result),
        Err(err) => {
            let after_failure =
                classify_primary(spec, &paths.primary_path).unwrap_or(PrimaryProfileClass::Absent);
            if is_usable_primary(after_failure) {
                log(&format!(
                    "[desktop] {} migration aborted with usable primary present: {err}",
                    spec.log_label
                ));
                return Ok(primary_result(
                    &paths.primary_path,
                    "primary-ready-after-failure",
                ));
            }
            log(&format!(
                "[desktop] {} migration failed; using legacy profile: {err}",
                spec.log_label
            ));
            Ok(legacy_result(&paths.legacy_path, "migration-failed"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Neutral fixture names — algorithm coverage only; no product appConfig branding.
    const TEST_SPEC: ProfileHandoffSpec = ProfileHandoffSpec {
        ownership_marker: ".profile.handoff.ownership",
        completion_marker: ".profile.handoff.complete",
        lock_dir_name: "profile.handoff.migrating.lock",
        temp_dir_prefix: "profile.handoff.migrating-",
        log_label: "profile-handoff",
    };

    const LEGACY_NAME: &str = "legacy.profile";
    const PRIMARY_NAME: &str = "primary.profile";

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ccmax-profile-handoff-{}-{}-{}",
            label,
            std::process::id(),
            random_token_hex()
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

    fn paths_for(root: &Path) -> ProfileHandoffPaths {
        resolve_profile_handoff_paths(root, LEGACY_NAME, PRIMARY_NAME, &TEST_SPEC)
    }

    fn prepare(root: &Path) -> ProfileHandoffResult {
        prepare_profile_handoff(&TEST_SPEC, &paths_for(root))
    }

    fn prepare_with<L>(
        root: &Path,
        log: L,
        commit_override: Option<Box<dyn Fn(&Path, &Path) -> io::Result<()> + Send + Sync>>,
    ) -> ProfileHandoffResult
    where
        L: Fn(&str),
    {
        prepare_profile_handoff_with(&TEST_SPEC, &paths_for(root), log, commit_override)
    }

    fn list_own_artifacts(base: &Path) -> Vec<String> {
        let mut names = Vec::new();
        if let Ok(entries) = fs::read_dir(base) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == TEST_SPEC.lock_dir_name || name.starts_with(TEST_SPEC.temp_dir_prefix) {
                    names.push(name);
                }
            }
        }
        names.sort();
        names
    }

    fn try_create_test_symlink(target: &Path, link: &Path, is_dir: bool) -> bool {
        match create_symlink(target, link, is_dir) {
            Ok(()) => true,
            Err(err) => {
                // Windows without Developer Mode / admin often denies symlink creation.
                let _ = err;
                false
            }
        }
    }

    #[test]
    fn copies_only_legacy_and_keeps_legacy() {
        let root = temp_root("legacy-only");
        let paths = paths_for(&root);
        write_file(
            &paths.legacy_path.join("Preferences"),
            r#"{"theme":"dark"}"#,
        );
        write_file(
            &paths.legacy_path.join("nested").join("config.json"),
            r#"{"ok":true}"#,
        );

        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Migrated);
        assert_eq!(result.active_path, paths.primary_path);
        assert_eq!(
            fs::read_to_string(paths.primary_path.join("Preferences")).unwrap(),
            r#"{"theme":"dark"}"#
        );
        assert_eq!(
            fs::read_to_string(paths.legacy_path.join("Preferences")).unwrap(),
            r#"{"theme":"dark"}"#
        );
        assert!(paths
            .primary_path
            .join(TEST_SPEC.completion_marker)
            .exists());
        assert!(!paths.primary_path.join(TEST_SPEC.ownership_marker).exists());
        assert!(list_own_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_primary_not_overwritten() {
        let root = temp_root("primary-exists");
        let paths = paths_for(&root);
        write_file(&paths.primary_path.join("marker.txt"), "primary-original");
        write_file(
            &paths.legacy_path.join("marker.txt"),
            "legacy-should-not-copy",
        );

        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Primary);
        assert_eq!(result.reason, "primary-exists");
        assert_eq!(
            fs::read_to_string(paths.primary_path.join("marker.txt")).unwrap(),
            "primary-original"
        );
        assert!(!paths.primary_path.join("legacy-should-not-copy").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_primary_with_legacy_selects_legacy() {
        let root = temp_root("empty-primary");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");
        fs::create_dir_all(&paths.primary_path).unwrap();

        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Legacy);
        assert_eq!(result.reason, "primary-empty");
        assert!(fs::read_dir(&paths.primary_path).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn in_progress_primary_selects_legacy() {
        let root = temp_root("in-progress");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");
        fs::create_dir_all(&paths.primary_path).unwrap();
        write_file(
            &paths.primary_path.join(TEST_SPEC.ownership_marker),
            "foreign-or-stale-token",
        );
        write_file(&paths.primary_path.join("partial.txt"), "partial-publish");

        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Legacy);
        assert_eq!(result.reason, "primary-in-progress");
        assert_eq!(
            classify_primary(&TEST_SPEC, &paths.primary_path).unwrap(),
            PrimaryProfileClass::InProgress
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn completion_marker_uses_primary() {
        let root = temp_root("complete");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("legacy-only.txt"), "legacy");
        write_file(&paths.primary_path.join("Preferences"), r#"{"ok":1}"#);
        write_file(
            &paths.primary_path.join(TEST_SPEC.completion_marker),
            "done\n",
        );

        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Primary);
        assert_eq!(result.reason, "primary-complete");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn neither_exists_selects_primary_without_creating() {
        let root = temp_root("neither");
        let paths = paths_for(&root);
        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Primary);
        assert_eq!(result.reason, "neither-exists");
        assert!(!paths.primary_path.exists());
        assert!(!paths.legacy_path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lock_held_uses_legacy_when_primary_absent() {
        let root = temp_root("lock-held");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");
        fs::create_dir_all(&paths.lock_path).unwrap();

        let result = prepare(&root);
        assert_eq!(result.reason, "migration-lock-held");
        assert_eq!(result.active_path, paths.legacy_path);
        assert!(!paths.primary_path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lock_held_with_usable_primary_uses_primary() {
        let root = temp_root("lock-primary");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");
        write_file(&paths.primary_path.join("ready.txt"), "primary");
        fs::create_dir_all(&paths.lock_path).unwrap();

        let result = prepare(&root);
        assert_eq!(result.reason, "primary-exists");
        assert_eq!(result.active_path, paths.primary_path);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reserved_marker_in_legacy_fails_closed() {
        let root = temp_root("legacy-reserved");
        let paths = paths_for(&root);
        write_file(
            &paths.legacy_path.join(TEST_SPEC.completion_marker),
            "preexisting",
        );
        let result = prepare(&root);
        assert_eq!(result.reason, "migration-failed");
        assert_eq!(result.active_path, paths.legacy_path);
        assert!(!paths.primary_path.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_failure_falls_back_to_legacy() {
        let root = temp_root("commit-fail");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("keep.txt"), "legacy");

        let result = prepare_with(
            &root,
            |_| {},
            Some(Box::new(|_temp, _primary| {
                Err(io::Error::new(ErrorKind::Other, "injected commit failure"))
            })),
        );
        assert_eq!(result.reason, "migration-failed");
        assert!(!paths.primary_path.exists());
        assert!(list_own_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mid_publish_owned_cleanup() {
        use std::sync::Arc;

        let root = temp_root("mid-publish-clean");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("a.txt"), "A");
        write_file(&paths.legacy_path.join("b.txt"), "B");

        let rename_count = Arc::new(AtomicU64::new(0));
        let result = prepare_with(
            &root,
            |_| {},
            Some(Box::new({
                let rename_count = Arc::clone(&rename_count);
                move |temp, primary| {
                    let rename_count = Arc::clone(&rename_count);
                    commit_primary_with(
                        &TEST_SPEC,
                        temp,
                        primary,
                        mkdir_exclusive,
                        move |from, to| {
                            let n = rename_count.fetch_add(1, Ordering::SeqCst);
                            if n >= 1 {
                                return Err(io::Error::new(
                                    ErrorKind::Other,
                                    "injected mid-publish failure",
                                ));
                            }
                            rename_path(from, to)
                        },
                        path_exists,
                    )
                }
            })),
        );

        assert_eq!(result.reason, "migration-failed");
        assert!(!paths.primary_path.exists());
        assert!(list_own_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mid_publish_unknown_entry_not_deleted() {
        use std::sync::Arc;

        let root = temp_root("mid-publish-unknown");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("a.txt"), "A");
        write_file(&paths.legacy_path.join("b.txt"), "B");
        let primary_for_race = paths.primary_path.clone();

        let rename_count = Arc::new(AtomicU64::new(0));
        let result = prepare_with(
            &root,
            |_| {},
            Some(Box::new({
                let rename_count = Arc::clone(&rename_count);
                move |temp, primary| {
                    let primary_for_race = primary_for_race.clone();
                    let rename_count = Arc::clone(&rename_count);
                    commit_primary_with(
                        &TEST_SPEC,
                        temp,
                        primary,
                        mkdir_exclusive,
                        move |from, to| {
                            let n = rename_count.fetch_add(1, Ordering::SeqCst);
                            if n == 0 {
                                rename_path(from, to)?;
                                write_file(
                                    &primary_for_race.join("race-unknown.txt"),
                                    "competitor",
                                );
                                return Ok(());
                            }
                            Err(io::Error::new(
                                ErrorKind::Other,
                                "injected failure after unknown entry",
                            ))
                        },
                        path_exists,
                    )
                }
            })),
        );

        assert_eq!(result.reason, "migration-failed");
        assert_eq!(
            fs::read_to_string(paths.primary_path.join("race-unknown.txt")).unwrap(),
            "competitor"
        );
        assert!(paths.primary_path.join(TEST_SPEC.ownership_marker).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn racing_empty_primary_does_not_get_renamed_over() {
        let root = temp_root("race-empty");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("from-legacy.txt"), "legacy");

        let result = prepare_with(
            &root,
            |_| {},
            Some(Box::new(|temp, primary| {
                fs::create_dir(primary)?;
                commit_primary(&TEST_SPEC, temp, primary)
            })),
        );

        assert_eq!(result.source, ProfileHandoffSource::Legacy);
        assert_eq!(result.reason, "migration-failed");
        assert!(fs::read_dir(&paths.primary_path).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn racing_nonempty_primary_selected_safely() {
        let root = temp_root("race-nonempty");
        let paths = paths_for(&root);
        write_file(&paths.legacy_path.join("from-legacy.txt"), "legacy");

        let result = prepare_with(
            &root,
            |_| {},
            Some(Box::new(|temp, primary| {
                fs::create_dir_all(primary)?;
                write_file(&primary.join("from-race.txt"), "racing-primary");
                commit_primary(&TEST_SPEC, temp, primary)
            })),
        );

        assert_eq!(result.active_path, paths.primary_path);
        assert_eq!(result.source, ProfileHandoffSource::Primary);
        assert_eq!(
            fs::read_to_string(paths.primary_path.join("from-race.txt")).unwrap(),
            "racing-primary"
        );
        assert!(!paths.primary_path.join("from-legacy.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_exact_and_size_drift() {
        let root = temp_root("manifest");
        let source = root.join("src");
        let dest = root.join("dest");
        fs::create_dir_all(source.join("nested")).unwrap();
        write_file(&source.join("nested").join("file.txt"), "abc");
        fs::create_dir_all(&dest).unwrap();

        let maybe_symlink = try_create_test_symlink(
            Path::new("file.txt"),
            &source.join("nested").join("rel-link"),
            false,
        );

        let manifest = copy_profile_tree(&TEST_SPEC, &source, &dest).unwrap();
        verify_copied_tree(&source, &dest, &manifest).unwrap();

        // Extra entry rejected.
        write_file(&dest.join("extra.txt"), "sneak");
        assert!(verify_copied_tree(&source, &dest, &manifest).is_err());
        fs::remove_file(dest.join("extra.txt")).unwrap();

        // Missing entry rejected.
        if maybe_symlink {
            // keep structure
        }
        fs::remove_file(dest.join("nested").join("file.txt")).unwrap();
        assert!(verify_copied_tree(&source, &dest, &manifest).is_err());

        // Restore and detect source size drift.
        write_file(&dest.join("nested").join("file.txt"), "abc");
        write_file(&source.join("nested").join("file.txt"), "abcdef");
        assert!(verify_copied_tree(&source, &dest, &manifest)
            .unwrap_err()
            .to_string()
            .contains("size mismatch"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn symlink_copy_does_not_follow_outside() {
        let root = temp_root("symlinks");
        let paths = paths_for(&root);
        write_file(&root.join("outside-secret.txt"), "outside-secret");
        fs::create_dir_all(paths.legacy_path.join("nested")).unwrap();
        write_file(
            &paths.legacy_path.join("nested").join("inside.txt"),
            "inside",
        );

        let created_out = try_create_test_symlink(
            Path::new("../outside-secret.txt"),
            &paths.legacy_path.join("nested").join("link-out"),
            false,
        );
        let created_in = try_create_test_symlink(
            Path::new("inside.txt"),
            &paths.legacy_path.join("nested").join("link-in"),
            false,
        );
        if !created_out || !created_in {
            let _ = fs::remove_dir_all(&root);
            return;
        }

        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Migrated);
        assert_eq!(
            fs::read_link(paths.primary_path.join("nested").join("link-out")).unwrap(),
            PathBuf::from("../outside-secret.txt")
        );
        assert_eq!(
            fs::read_link(paths.primary_path.join("nested").join("link-in")).unwrap(),
            PathBuf::from("inside.txt")
        );
        assert!(!paths.primary_path.join("outside-secret.txt").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn special_file_rejected() {
        use std::os::unix::net::UnixListener;

        let root = temp_root("special");
        let paths = paths_for(&root);
        fs::create_dir_all(&paths.legacy_path).unwrap();
        // Unix socket is a special file that must fail closed.
        let sock = paths.legacy_path.join("sock");
        let _listener = match UnixListener::bind(&sock) {
            Ok(listener) => listener,
            Err(_) => {
                let _ = fs::remove_dir_all(&root);
                return;
            }
        };
        let result = prepare(&root);
        assert_eq!(result.source, ProfileHandoffSource::Legacy);
        assert_eq!(result.reason, "migration-failed");
        let _ = fs::remove_dir_all(&root);
    }
}
