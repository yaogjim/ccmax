import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

export type MacUpdateArch = 'arm64' | 'x64'

export type MacUpdateFileInfo = {
  url: string
  sha512?: string
  size?: number
}

export type MacUpdateScriptInput = {
  appPath: string
  zipPath: string
  backupPath: string
  logPath: string
}

// electron-builder publishes the macOS payload as a zip; the dmg is the manual
// install image and carries no part in the update path.
function isZipAsset(file: MacUpdateFileInfo): boolean {
  const url = file.url.split('?')[0] ?? ''
  return /\.zip$/i.test(url)
}

function isArm64Asset(file: MacUpdateFileInfo): boolean {
  return /arm64/i.test(file.url)
}

/**
 * Mirrors MacUpdater's own filter: arm64 hosts take arm64 builds when any
 * exists, everything else takes the non-arm64 build. Builds without an
 * architecture marker stay eligible for both.
 */
export function selectMacUpdateZip(files: MacUpdateFileInfo[], arch: MacUpdateArch): MacUpdateFileInfo | null {
  const zips = files.filter(isZipAsset)
  if (zips.length === 0) return null

  const arm64Zips = zips.filter(isArm64Asset)
  const candidates = arch === 'arm64' && arm64Zips.length > 0
    ? arm64Zips
    : zips.filter(file => !isArm64Asset(file))

  return candidates[0] ?? null
}

export function createSha512Inspector(): { update(chunk: Uint8Array): void, digestBase64(): string } {
  const hash = createHash('sha512')
  return {
    update(chunk) {
      hash.update(chunk)
    },
    digestBase64() {
      return hash.digest('base64')
    },
  }
}

export function isAdhocSignedCodesignOutput(output: string): boolean {
  if (/Authority=Developer ID Application:/.test(output)) return false
  return /Signature=adhoc/.test(output) || /flags=[^\n]*\badhoc\b/.test(output) || /code object is not signed at all/.test(output)
}

export function resolveAppBundlePath(execPath: string): string | null {
  let current = dirname(execPath)
  while (current !== dirname(current)) {
    if (current.endsWith('.app')) return current
    current = dirname(current)
  }
  return null
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Squirrel.Mac refuses to install an update whose signature is ad-hoc, so the
 * replacement runs as a detached script after this process exits: wait for the
 * bundle to be released, swap it with the downloaded zip, and restore the old
 * bundle if the new one does not come up.
 */
export function renderMacUpdateScript(input: MacUpdateScriptInput): string {
  return `#!/bin/bash
set -uo pipefail
exec >>${shellQuote(input.logPath)} 2>&1
echo "ccmax update started: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

app_path=${shellQuote(input.appPath)}
zip_path=${shellQuote(input.zipPath)}
backup_path=${shellQuote(input.backupPath)}
target_pid="$1"

while kill -0 "$target_pid" 2>/dev/null; do sleep 0.5; done

work_dir="$(mktemp -d "\${TMPDIR:-/tmp}/ccmax-update.XXXXXX")" || exit 1
if ! ditto -x -k "$zip_path" "$work_dir"; then
  echo "cannot extract $zip_path"
  rm -rf "$work_dir"
  exit 1
fi
new_app="$work_dir/ccmax.app"
if [ ! -d "$new_app" ]; then
  echo "extracted archive does not contain ccmax.app"
  rm -rf "$work_dir"
  exit 1
fi

rm -rf "$backup_path"
if ! mv "$app_path" "$backup_path"; then
  echo "cannot move $app_path aside; install it manually from $zip_path"
  open -R "$zip_path"
  rm -rf "$work_dir"
  open "$app_path"
  exit 1
fi

if ! ditto "$new_app" "$app_path"; then
  echo "copy failed; restoring previous app"
  rm -rf "$app_path"
  mv "$backup_path" "$app_path"
  rm -rf "$work_dir"
  open "$app_path"
  exit 1
fi

xattr -dr com.apple.quarantine "$app_path" 2>/dev/null || true
if ! open "$app_path"; then
  echo "launch failed; restoring previous app"
  rm -rf "$app_path"
  mv "$backup_path" "$app_path"
  open "$app_path"
  rm -rf "$work_dir"
  exit 1
fi

# LaunchServices 接纳启动请求不等于应用已就绪；保留备份，不按固定延迟误判并删除新应用。
echo "update installed; launch requested; previous app retained: $backup_path"
rm -rf "$work_dir"
exit 0
`
}
