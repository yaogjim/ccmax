import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const installerHook = readFileSync('desktop/build/installer.nsh', 'utf8')
const recoveryHelper = readFileSync(
  'desktop/build/recover-legacy-install-data.ps1',
  'utf8',
)
const installerSmoke = readFileSync(
  'desktop/scripts/windows-installer-smoke.ps1',
  'utf8',
)
const desktopPackage = JSON.parse(
  readFileSync('desktop/package.json', 'utf8'),
)

describe('Windows installer recovery prerequisites', () => {
  test('does not compile native path helpers at install time', () => {
    expect(recoveryHelper).not.toContain('Add-Type')
    expect(recoveryHelper).toContain('function Assert-NoReparsePointInPath')
    expect(recoveryHelper).toContain('$rootAttributes = [IO.File]::GetAttributes($current)')
    expect(recoveryHelper).toContain(
      'contains a reparse point and cannot be recovered safely',
    )
    expect(recoveryHelper).toContain('function Get-CanonicalPathIdentity')
    expect(recoveryHelper).toContain('System32\\mountvol.exe')
    expect(recoveryHelper).toContain('SUBST aliases cannot be recovered safely')
    expect(recoveryHelper).toContain('Possible 8.3 path alias cannot be proven safe')
    expect(recoveryHelper).toContain('Alternate path alias cannot be recovered safely')
    expect(recoveryHelper).toContain('Get-ChildItem -LiteralPath $current -Force')
    expect(recoveryHelper).toContain("([string]$_.Name).Equals($segment")
    expect(recoveryHelper).toContain("Join-Path $testRoot 'project~notes'")
    expect(recoveryHelper).toContain("Join-Path $testRoot 'MISSIN~1'")
    expect(recoveryHelper).not.toContain("'PROGRA~1'")
    expect(recoveryHelper).toContain('possible 8.3 alias did not fail closed')
    expect(recoveryHelper).toContain('legal long directory name containing a tilde')
    expect(recoveryHelper).toContain('extended volume alias did not fail closed')
    expect(recoveryHelper).toContain('SUBST alias did not fail closed')
  })

  test('skips PowerShell only for a proven default per-user installation', () => {
    const fastPathStart = installerHook.indexOf(
      'Function CcHahaCanSkipLegacyRecovery',
    )
    const recoveryCall = installerHook.indexOf(
      'UAC_AsUser_Call Function CcHahaRecoverLegacy',
    )

    expect(fastPathStart).toBeGreaterThan(-1)
    expect(fastPathStart).toBeLessThan(recoveryCall)
    expect(installerHook).toMatch(
      /Function CcHahaCanSkipLegacyRecovery[\s\S]*\$8 != "trusted-user"/,
    )
    expect(installerHook).toMatch(
      /StrCpy \$8 "trusted-user"[\s\S]*UAC_IsAdmin[\s\S]*StrCpy \$8 "untrusted-elevated"[\s\S]*UAC_IsInnerInstance[\s\S]*StrCpy \$8 "trusted-uac-outer"[\s\S]*Call CcHahaCanSkipLegacyRecovery/,
    )
    expect(installerHook).toContain(
      '$ccHahaPerUserInstallLocation == ""',
    )
    expect(installerHook).toContain(
      '$ccHahaPerMachineInstallLocation != ""',
    )
    expect(installerHook).toContain(
      '$ccHahaPerMachineUninstallString != ""',
    )
    expect(installerHook).toContain(
      'StrCmp $ccHahaPerUserInstallLocation $INSTDIR',
    )
    expect(installerHook).toContain('ReadEnvStr $R0 CLAUDE_CONFIG_DIR')
    expect(installerHook).toContain(
      'IfFileExists "$ccHahaPerUserInstallLocation\\CLAUDE_CONFIG_DIR\\*.*"',
    )
    expect(installerHook).toContain(
      'FileOpen $R2 "$R1\\Claude Code Haha\\app-mode.json" r',
    )
    expect(installerHook).toContain('StrCmp $R3 \'  "mode": "default",$\\n\'')
    expect(installerHook).toContain('StrCmp $R3 \'  "portable_dir": null$\\n\'')
    expect(installerHook).toContain('FileClose $R2')
    expect(installerHook).toMatch(
      /Call CcHahaCanSkipLegacyRecovery[\s\S]*No legacy data candidates found for the registered per-user installation[\s\S]*UAC_AsUser_Call Function CcHahaRecoverLegacy/,
    )
    expect(installerHook).toContain('$ccHahaHasDistinctRegisteredInstall == "1"')
    expect(installerHook).toContain('$ccHahaHasMachineRegistration == "1"')
    expect(installerHook).toContain(
      'IfFileExists "$R1\\${CCMAX_PRIMARY_USER_DATA_NAME}\\app-mode.json"',
    )
    expect(installerHook).toContain(
      'IfFileExists "$R1\\${CCMAX_LEGACY_USER_DATA_NAME}\\app-mode.json"',
    )
  })

  test('reads primary and legacy registry slots with current write-side package identity as primary', () => {
    expect(desktopPackage.build.appId).toBe('com.ccmax.desktop')
    expect(desktopPackage.build.artifactName).toBe(
      'ccmax-${version}-${os}-${arch}.${ext}',
    )
    expect(desktopPackage.build.publish?.[0]?.owner).toBe('yaogjim')
    expect(desktopPackage.build.publish?.[0]?.repo).toBe('ccmax')
    expect(desktopPackage.build.productName).toBe('ccmax')
    expect(desktopPackage.description).toContain('ccmax')
    expect(desktopPackage.homepage).toContain('yaogjim/ccmax')

    expect(installerHook).toContain(
      '!define CCMAX_LEGACY_APP_GUID "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"',
    )
    expect(installerHook).toContain(
      '!define CCMAX_PRIMARY_APP_GUID "7587c564-d121-50d5-b0bd-63ccf9c72aeb"',
    )
    expect(installerHook).not.toContain('c63953f7-c499-5bd0-a264-6a70fd55ab5d')
    expect(installerHook).not.toContain('com.yaogjim.ccmax.desktop')
    expect(installerHook).toContain(
      'ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    expect(installerHook).toContain(
      'ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    expect(installerHook).toContain(
      'ReadRegStr $ccHahaPrimaryPerUserInstallLocation HKCU "${CCMAX_PRIMARY_INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    expect(installerHook).toContain(
      'ReadRegStr $ccHahaPrimaryPerMachineInstallLocation HKLM "${CCMAX_PRIMARY_INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    expect(installerHook).toContain(
      'ReadRegStr $ccHahaLegacyPerUserInstallLocation HKCU "${CCMAX_LEGACY_INSTALL_REGISTRY_KEY}" InstallLocation',
    )
    expect(installerHook).toContain(
      'ReadRegStr $ccHahaLegacyPerMachineInstallLocation HKLM "${CCMAX_LEGACY_INSTALL_REGISTRY_KEY}" InstallLocation',
    )

    const recoverCall = installerHook.match(
      /nsExec::ExecToStack '[\s\S]*?recover-legacy-install-data\.ps1[\s\S]*?'/,
    )
    expect(recoverCall?.[0]).toBeTruthy()
    const call = recoverCall![0]
    const requiredFlags = [
      '-PrimaryPerUserInstallDir',
      '-PrimaryPerMachineInstallDir',
      '-LegacyPerUserInstallDir',
      '-LegacyPerMachineInstallDir',
      '-PerUserInstallDir',
      '-PerMachineInstallDir',
      '-CandidateInstallDir',
      '-PrimaryUserDataDir',
      '-LegacyUserDataDir',
      '-UserDataDir',
      '-RecoveryRoot',
      '-ProcessName',
      '-ProcessNames',
      '-ActiveConfigDir',
      '-ActiveConfigManaged',
      '-InstallerIdentitySafety',
    ]
    let previousIndex = -1
    for (const flag of requiredFlags) {
      const index = call.indexOf(flag)
      expect(index).toBeGreaterThan(previousIndex)
      previousIndex = index
    }
    expect(call).toContain('$2\\${CCMAX_PRIMARY_USER_DATA_NAME}')
    expect(call).toContain('$2\\${CCMAX_LEGACY_USER_DATA_NAME}')
    expect(call).toContain('$3\\${CCMAX_PRIMARY_RECOVERY_NAME}')
    expect(call).toContain('${CCMAX_PRIMARY_PROCESS_NAME};${CCMAX_LEGACY_PROCESS_NAME}')
    expect(installerHook).toContain('ReadEnvStr $R9 CCMAX_APP_PORTABLE_DIR')
    expect(installerHook).toContain('ReadEnvStr $7 CC_HAHA_APP_PORTABLE_DIR')
    expect(installerHook).toMatch(
      /ReadEnvStr \$R9 CCMAX_APP_PORTABLE_DIR[\s\S]*ReadEnvStr \$7 CC_HAHA_APP_PORTABLE_DIR[\s\S]*\$R9 != ""[\s\S]*StrCpy \$7 \$R9/,
    )
  })

  test('recovery helper dual-profile source resolution is fail-closed and primary-safe', () => {
    expect(recoveryHelper).toContain("foreach ($childDir in @('Cache', 'EBWebView', 'projects', 'skills', 'plugins', 'cowork_plugins', 'ccmax', 'cc-haha'))")
    expect(recoveryHelper).toContain('function Get-InstallLocalLegacySource')
    expect(recoveryHelper).toContain('function Get-ProfilePointedLegacySource')
    expect(recoveryHelper).toContain("ProfileKind 'primary'")
    expect(recoveryHelper).toContain("ProfileKind 'legacy'")
    expect(recoveryHelper).toContain("ProfileKind 'install-fingerprint'")
    expect(recoveryHelper).toContain('Test-ProfileHasUserState')
    expect(recoveryHelper).toContain(
      'never overwrite an existing primary profile',
    )
    expect(recoveryHelper).toContain(
      'four registry install roots were collapsed instead of fail-closed on ambiguity',
    )
    expect(recoveryHelper).toContain(
      'existing primary profile was overwritten by install-fingerprint recovery',
    )
    expect(recoveryHelper).toContain(
      'primary profile source was not recovered',
    )
    expect(recoveryHelper).toContain(
      'ccmax fork-owned fingerprint was not recovered',
    )
    expect(recoveryHelper).toContain(
      'CCMAX-managed active config was not recovered',
    )
    expect(recoveryHelper).toMatch(
      /if \(\[string\]::IsNullOrWhiteSpace\(\$ActiveConfigManaged\)\)[\s\S]*CCMAX_APP_PORTABLE_DIR[\s\S]*CC_HAHA_APP_PORTABLE_DIR/,
    )
    expect(recoveryHelper).toContain(
      '-SharedInstallDirs @($PerMachineInstallDir)',
    )
    expect(recoveryHelper).toMatch(
      /\$source = Get-UnsafeLegacySource|\$sourceInfo = Get-UnsafeLegacySource[\s\S]*Assert-NoRunningApplication/,
    )
    expect(recoveryHelper).toMatch(
      /Assert-TreeManifestsEqual[\s\S]*Assert-NoRunningApplication[\s\S]*Write-AppModeAtomically/,
    )
    expect(recoveryHelper).not.toContain('Add-Type')
  })

  test('keeps no-CLR default and portable upgrade cases in Windows smoke', () => {
    expect(installerSmoke).toContain("$env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'")
    expect(installerSmoke).toContain('Test-IsProcessElevated')
    expect(installerSmoke).toContain('Elevated default-mode reinstall without CLR')
    expect(installerSmoke).toMatch(
      /Elevated default-mode reinstall without CLR' -ExpectedExitCode 20/,
    )
    expect(installerSmoke).toContain('Trusted-user default-mode reinstall without CLR')
    expect(installerSmoke).toContain('Portable reinstall without CLR')
    expect(installerSmoke).toMatch(
      /Portable reinstall without CLR' -ExpectedExitCode 20/,
    )
    expect(installerSmoke).toContain('Invoke-ProcessExpectFailure')
    expect(installerSmoke).toContain('must-survive-failed-upgrade')
    expect(installerSmoke).toContain("'CCMAX_APP_PORTABLE_DIR'")
    expect(installerSmoke).toContain("'CC_HAHA_APP_PORTABLE_DIR'")
    expect(installerSmoke).toContain("-PrimaryUserDataDir")
    expect(installerSmoke).toContain("-LegacyUserDataDir")
    expect(installerSmoke).toContain("Join-Path $appData 'ccmax'")
    expect(installerSmoke).toContain("Join-Path $userProfile 'ccmax Data\\Recovered'")
    // Artifact lookup uses the current ccmax installer prefix.
    expect(installerSmoke).toContain(
      'ccmax-*-win-$Arch.exe',
    )
  })

  test('locks current install identity to ccmax while preserving true legacy compatibility', () => {
    expect(installerSmoke).toContain("'中文 安装目录\\ccmax'")
    expect(installerSmoke).toContain("Join-Path $installDir 'ccmax.exe'")
    expect(installerSmoke).toContain("Join-Path $installDir 'Uninstall ccmax.exe'")
    expect(installerSmoke).not.toContain("'中文 安装目录\\Claude Code Haha'")
    expect(installerSmoke).not.toContain("Join-Path $installDir 'Claude Code Haha.exe'")
    expect(installerSmoke).not.toContain(
      "Join-Path $installDir 'Uninstall Claude Code Haha.exe'",
    )

    expect(recoveryHelper).toContain("[string]$ProcessName = 'ccmax.exe'")
    expect(recoveryHelper).not.toContain(
      "[string]$ProcessName = 'Claude Code Haha.exe'",
    )
    expect(recoveryHelper).toContain(
      'Active CLAUDE_CONFIG_DIR is managed outside ccmax',
    )
    expect(recoveryHelper).toContain("Contains('managed outside ccmax')")
    expect(recoveryHelper).not.toContain('managed outside Claude Code Haha')

    expect(installerHook).toContain(
      'ccmax stopped setup before removing the old version',
    )
    expect(installerHook).toContain('ccmax 已在删除旧版本前停止安装')
    expect(installerHook).not.toContain(
      'Claude Code Haha stopped setup before removing the old version',
    )
    expect(installerHook).not.toContain(
      'Claude Code Haha 已在删除旧版本前停止安装',
    )

    expect(installerSmoke).toContain('ccmax-*-win-$Arch.exe')
    expect(installerSmoke).not.toContain('Claude-Code-Haha-*-win-$Arch.exe')
    expect(installerSmoke).toContain("Join-Path $appData 'Claude Code Haha'")
    expect(installerSmoke).toContain("'ccmax.exe;Claude Code Haha.exe'")
    expect(installerSmoke).toContain(
      "$siblingProbe = Join-Path $siblingDir 'Claude Code Haha.exe'",
    )
    expect(recoveryHelper).toContain(
      "-ProcessName 'ccmax.exe' -ProcessNames 'Claude Code Haha.exe'",
    )
    expect(installerHook).toContain(
      'Checking registered installations for legacy Claude Code Haha / ccmax data',
    )
    expect(installerHook).toContain(
      'Legacy Claude Code Haha data safety check completed',
    )
  })
})