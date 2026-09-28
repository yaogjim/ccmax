---
title: Download and install
nav_title: Install
description: Installers for macOS, Windows, and Linux, plus what to do when the OS blocks them.
order: 1
---

# Download and install

Install and go. You don't need Node.js, Python, or Claude Code — the CLI engine and the ripgrep binary used for file search are both bundled inside the installer.

## Pick the right package

Everything lives on [GitHub Releases](https://github.com/yaogjim/ccmax/releases/latest). Choose by operating system and CPU architecture:

| Your system | Download |
|---|---|
| macOS, Apple Silicon | `ccmax-<version>-mac-arm64.dmg` |
| macOS, Intel | `ccmax-<version>-mac-x64.dmg` |
| Windows x64 | `ccmax-<version>-win-x64.exe` |
| Windows ARM64 | `ccmax-<version>-win-arm64.exe` |
| Linux x64 | `ccmax-<version>-linux-x86_64.AppImage` or `-linux-amd64.deb` |
| Linux ARM64 | `ccmax-<version>-linux-arm64.AppImage` or `-linux-arm64.deb` |

Not sure which architecture you have? On macOS check the chip listed in "About This Mac"; on Windows check the system type under Settings → System → About. Don't guess from the brand of the machine.

The `.blockmap` and `latest*.yml` files are used by the app's own updater. You don't need to download them.

## macOS

1. Open the DMG.
2. Drag ccmax into Applications.
3. Launch it from Applications.

### If macOS blocks the first launch

A self-signed build has not been notarized by Apple. After verifying the package source, right-click ccmax in Applications and choose Open; if macOS offers System Settings → Privacy & Security → Open Anyway, the user on the receiving Mac must confirm it. This does not disable Gatekeeper or change system-wide security settings. **Self-signing does not replace Apple notarization**: if macOS only says the app is damaged and provides no per-app approval option, use a Developer ID signature and notarization instead of clearing the quarantine attribute.

## Windows

1. Fully quit any running copy of the old version, including the system tray icon.
2. Double-click the `.exe`.
3. **Don't** right-click and choose "Run as administrator" — the installer is per-user, and running it elevated puts your data directory in the wrong place.

Unsigned packages trigger a SmartScreen warning. Once you've confirmed the file came from this repository's Releases, click "More info" → "Run anyway".

When upgrading in place, the installer inspects user data in the old install directory. If it reports that the program is still running, quit the main window and the tray icon, give the background sidecar, terminal, and IM adapter processes a few seconds to exit, then run the installer again. Don't delete the old install directory by hand first.

## Linux

**AppImage** (no installation, just run it):

```bash
chmod +x ccmax-<version>-linux-x86_64.AppImage
./ccmax-<version>-linux-x86_64.AppImage
```

If it fails with a FUSE-related error, install the runtime: `sudo apt install libfuse2` on Ubuntu 22.04 and earlier, `libfuse2t64` on 24.04 and later.

**deb** (installs into your application menu):

```bash
sudo apt install ./ccmax-<version>-linux-amd64.deb
```

On ARM64 machines, use the corresponding `linux-arm64` file.

## Running from source

If you want to modify the code, debug the engine, or just use the CLI in a terminal:

```bash
git clone https://github.com/yaogjim/ccmax.git
cd ccmax
bun install
cp .env.example .env
./bin/ccmax
```

Requires [Bun](https://bun.sh) and Git. This runs the CLI only; for building the desktop app and configuring the local server, see [Command line](../cli/index.md).

### Build the macOS desktop app locally (Apple Silicon)

To package the desktop app yourself, run this from the repository root:

```bash
./desktop/scripts/build-macos-arm64.sh
```

**A self-signed build can preserve a complete Computer Use signing chain without an Apple developer certificate, but first launch on another Mac is still subject to Gatekeeper policy.** The build script automatically picks a **stable signing identity** from your keychain — Developer ID first, then Apple Development, then the self-signed `cu-helper-dev` — and puts the host app, the sidecar, and the Computer Use helper on **one certificate**. All three must match: if any of them is ad-hoc or lands on a different certificate, the helper rejects Computer Use with `unauthorized_client`.

Create the self-signed certificate once per machine: open Keychain Access → menu **Certificate Assistant** → **Create a Certificate…**, name it `cu-helper-dev`, set Identity Type to **Self Signed Root** and Certificate Type to **Code Signing**, and leave it in the `login` keychain; the script detects it automatically. The certificate and its private key stay in this machine's keychain — **there is no need to export a p12** — and must not be committed to the repository. Reusing the same certificate every time is what keeps the signing identity stable, so the OS grants survive a rebuild.

Every machine needs its own first-launch confirmation through the macOS prompts above; if macOS does not offer per-app approval for the self-signed build, Developer ID signing and notarization are required rather than clearing quarantine. Then grant **Screen Recording** and **Accessibility**. These grants are per machine and do not travel with the app. See [Computer Use](../desktop/computer-use.md).

## Updating

**In-app updates (recommended).** Open Settings → About → App Updates and click "Check now". It compares your installed version against the latest GitHub Release, downloads the new build, and offers "Install and restart".

Before updating, stop any running sessions and save uncommitted work.

If the download stalls, you probably can't reach GitHub. The same panel has an "Advanced update proxy" setting where you can switch to the system proxy or enter a local HTTP proxy address (`http://127.0.0.1:7890`, for instance). This proxy only affects the app's own update downloads — it has no effect on model requests.

**Manual replacement.** Download the new installer from Releases and repeat the steps for your platform. Sessions, provider configuration, skills, agents, and memory live under `~/.claude`, not in the application directory, so installing over the top doesn't touch them.

:::warning
The installer's data protection is not a backup. Keep your own copy of anything you can't afford to lose.
:::

## Code signing policy

See the [Code signing policy](./code-signing.md) for the Windows signing scope, manual approval, responsible roles, and verification steps. Until SignPath Foundation onboarding is complete, Windows releases remain explicitly identified as unsigned. See [Privacy and network access](./privacy.md) for network and local-data behavior.

## Next

Go to [Connect a model](./models.md). Until a model is connected, the app opens but can't send a single message.

If it won't install or won't open, see [Won't install, won't open, won't connect](./troubleshooting.md).
