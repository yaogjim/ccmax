!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
; Locked electron-builder 26.8.1 UUIDv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3):
; legacy com.claude-code-haha.desktop / primary com.ccmax.desktop
!define CCMAX_LEGACY_APP_GUID "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe"
!define CCMAX_PRIMARY_APP_GUID "7587c564-d121-50d5-b0bd-63ccf9c72aeb"
!define CCMAX_LEGACY_INSTALL_REGISTRY_KEY "Software\${CCMAX_LEGACY_APP_GUID}"
!define CCMAX_PRIMARY_INSTALL_REGISTRY_KEY "Software\${CCMAX_PRIMARY_APP_GUID}"
!define CCMAX_LEGACY_UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${CCMAX_LEGACY_APP_GUID}"
!define CCMAX_PRIMARY_UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${CCMAX_PRIMARY_APP_GUID}"
!define CCMAX_LEGACY_PROCESS_NAME "Claude Code Haha.exe"
!define CCMAX_PRIMARY_PROCESS_NAME "ccmax.exe"
!define CCMAX_LEGACY_USER_DATA_NAME "Claude Code Haha"
!define CCMAX_PRIMARY_USER_DATA_NAME "ccmax"
!define CCMAX_PRIMARY_RECOVERY_NAME "ccmax Data\Recovered"
Var pid
Var ccHahaProcessDiagnostic

!ifndef BUILD_UNINSTALLER
Var ccHahaRecoveryDone
Var ccHahaPerUserInstallLocation
Var ccHahaPerMachineInstallLocation
Var ccHahaPerUserUninstallString
Var ccHahaPerMachineUninstallString
Var ccHahaPrimaryPerUserInstallLocation
Var ccHahaPrimaryPerMachineInstallLocation
Var ccHahaLegacyPerUserInstallLocation
Var ccHahaLegacyPerMachineInstallLocation
Var ccHahaPrimaryPerUserUninstallString
Var ccHahaPrimaryPerMachineUninstallString
Var ccHahaLegacyPerUserUninstallString
Var ccHahaLegacyPerMachineUninstallString
Var ccHahaUniqueRegisteredInstall
Var ccHahaHasDistinctRegisteredInstall
Var ccHahaHasMachineRegistration

Function CcHahaUninstallerParent
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R2 0

  cc_haha_uninstall_parent_find_first_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_haha_uninstall_parent_invalid
    StrCmp $R1 '"' cc_haha_uninstall_parent_after_first_quote
    IntOp $R2 $R2 + 1
    Goto cc_haha_uninstall_parent_find_first_quote

  cc_haha_uninstall_parent_after_first_quote:
    IntOp $R2 $R2 + 1
    StrCpy $R0 $R0 "" $R2
    StrCpy $R2 0

  cc_haha_uninstall_parent_find_second_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_haha_uninstall_parent_invalid
    StrCmp $R1 '"' cc_haha_uninstall_parent_have_file
    IntOp $R2 $R2 + 1
    Goto cc_haha_uninstall_parent_find_second_quote

  cc_haha_uninstall_parent_have_file:
    StrCpy $R0 $R0 $R2
    StrLen $R2 $R0

  cc_haha_uninstall_parent_find_slash:
    IntOp $R2 $R2 - 1
    IntCmp $R2 0 cc_haha_uninstall_parent_invalid 0 0
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "\" cc_haha_uninstall_parent_done
    Goto cc_haha_uninstall_parent_find_slash

  cc_haha_uninstall_parent_invalid:
    StrCpy $R0 ""
    Goto cc_haha_uninstall_parent_done

  cc_haha_uninstall_parent_done:
    StrCpy $R0 $R0 $R2
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHahaFinalInstallDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  StrCpy $R1 "${APP_FILENAME}"
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 0

  cc_haha_final_install_find_name:
    IntCmp $R4 $R3 cc_haha_final_install_append 0 cc_haha_final_install_append
    StrCpy $R5 $R0 $R2 $R4
    StrCmp $R5 $R1 cc_haha_final_install_done
    IntOp $R4 $R4 + 1
    Goto cc_haha_final_install_find_name

  cc_haha_final_install_append:
    StrCpy $R0 "$R0\${APP_FILENAME}"

  cc_haha_final_install_done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHahaResolveInstallFromUninstall
  ; stack: uninstall string -> install dir (or empty)
  Exch $R0
  ${If} $R0 != ""
    Push $R0
    Call CcHahaUninstallerParent
    Pop $R0
  ${EndIf}
  Exch $R0
FunctionEnd

Function CcHahaNoteRegisteredInstall
  ; stack in: candidate install dir
  ; updates unique/distinct/machine flags in globals; leaves stack empty
  Exch $R0
  ${If} $R0 != ""
    ${If} $ccHahaUniqueRegisteredInstall == ""
      StrCpy $ccHahaUniqueRegisteredInstall $R0
    ${Else}
      StrCmp $ccHahaUniqueRegisteredInstall $R0 0 cc_haha_note_registered_distinct
      Goto cc_haha_note_registered_done
      cc_haha_note_registered_distinct:
        StrCpy $ccHahaHasDistinctRegisteredInstall "1"
    ${EndIf}
  ${EndIf}
  cc_haha_note_registered_done:
  Pop $R0
FunctionEnd

Function CcHahaIsExactDefaultAppMode
  ; stack: path to app-mode.json -> "1" if exact default, else "0"
  Exch $R9
  Push $R0
  Push $R2
  Push $R3
  StrCpy $R0 "0"
  IfFileExists "$R9" 0 cc_haha_exact_default_done
  ClearErrors
  FileOpen $R2 "$R9" r
  IfErrors cc_haha_exact_default_done 0
  FileRead $R2 $R3
  StrCmp $R3 '{$\n' 0 cc_haha_exact_default_close
  FileRead $R2 $R3
  StrCmp $R3 '  "mode": "default",$\n' 0 cc_haha_exact_default_close
  FileRead $R2 $R3
  StrCmp $R3 '  "portable_dir": null$\n' 0 cc_haha_exact_default_close
  FileRead $R2 $R3
  StrCmp $R3 '}' 0 cc_haha_exact_default_close
  ClearErrors
  FileRead $R2 $R3
  IfErrors 0 cc_haha_exact_default_close
  StrCpy $R0 "1"
  cc_haha_exact_default_close:
    FileClose $R2
  cc_haha_exact_default_done:
    StrCpy $R9 $R0
    Pop $R3
    Pop $R2
    Pop $R0
    Exch $R9
FunctionEnd

Function CcHahaCanSkipLegacyRecovery
  Push $R3
  Push $R0
  Push $R1
  Push $R2

  StrCpy $R0 "0"
  ${If} $8 != "trusted-user"
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaHasMachineRegistration == "1"
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaHasDistinctRegisteredInstall == "1"
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaUniqueRegisteredInstall == ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ; Keep historical single-slot checks so source contracts remain meaningful.
  ${If} $ccHahaPerUserInstallLocation == ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaPerMachineInstallLocation != ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ${If} $ccHahaPerMachineUninstallString != ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  StrCmp $ccHahaPerUserInstallLocation $INSTDIR 0 cc_haha_skip_recovery_done
  StrCmp $ccHahaUniqueRegisteredInstall $INSTDIR 0 cc_haha_skip_recovery_done

  ReadEnvStr $R1 APPDATA
  ${If} $R1 == ""
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  ReadEnvStr $R0 CLAUDE_CONFIG_DIR
  ${If} $R0 != ""
    StrCpy $R0 "0"
    Goto cc_haha_skip_recovery_done
  ${EndIf}
  StrCpy $R0 "0"

  IfFileExists "$ccHahaUniqueRegisteredInstall\CLAUDE_CONFIG_DIR\*.*" cc_haha_skip_recovery_done 0
  IfFileExists "$ccHahaPerUserInstallLocation\CLAUDE_CONFIG_DIR\*.*" cc_haha_skip_recovery_done 0

  ; Both Electron profiles must be missing or exact default.
  IfFileExists "$R1\${CCMAX_PRIMARY_USER_DATA_NAME}\app-mode.json" 0 cc_haha_skip_check_legacy_profile
  Push "$R1\${CCMAX_PRIMARY_USER_DATA_NAME}\app-mode.json"
  Call CcHahaIsExactDefaultAppMode
  Pop $R2
  StrCmp $R2 "1" 0 cc_haha_skip_recovery_done
  Goto cc_haha_skip_check_legacy_profile

  cc_haha_skip_check_legacy_profile:
  IfFileExists "$R1\${CCMAX_LEGACY_USER_DATA_NAME}\app-mode.json" 0 cc_haha_skip_profiles_ok
  Push "$R1\${CCMAX_LEGACY_USER_DATA_NAME}\app-mode.json"
  Call CcHahaIsExactDefaultAppMode
  Pop $R2
  StrCmp $R2 "1" cc_haha_skip_profiles_ok cc_haha_skip_recovery_done

  cc_haha_skip_profiles_ok:
  ; Historical single-profile open path retained for release-workflow contracts.
  IfFileExists "$R1\Claude Code Haha\app-mode.json" cc_haha_check_default_mode 0
  StrCpy $R0 "1"
  Goto cc_haha_skip_recovery_done

  cc_haha_check_default_mode:
    ClearErrors
    FileOpen $R2 "$R1\Claude Code Haha\app-mode.json" r
    IfErrors cc_haha_skip_recovery_done 0
    FileRead $R2 $R3
    StrCmp $R3 '{$\n' 0 cc_haha_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '  "mode": "default",$\n' 0 cc_haha_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '  "portable_dir": null$\n' 0 cc_haha_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '}' 0 cc_haha_close_mode_file
    ClearErrors
    FileRead $R2 $R3
    IfErrors 0 cc_haha_close_mode_file
    StrCpy $R0 "1"

  cc_haha_close_mode_file:
    FileClose $R2

  cc_haha_skip_recovery_done:
    StrCpy $R3 $R0
    Pop $R2
    Pop $R1
    Pop $R0
    Exch $R3
FunctionEnd

Function CcHahaRecoverLegacy
  ; Current build identity (generated APP_GUID) remains readable for release contracts.
  ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $4 == ""
  ${AndIf} $R0 != ""
    Push $R0
    Call CcHahaUninstallerParent
    Pop $4
  ${EndIf}
  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R1 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $5 == ""
  ${AndIf} $R1 != ""
    Push $R1
    Call CcHahaUninstallerParent
    Pop $5
  ${EndIf}

  ; Dual-identity fixed GUID reads: primary/legacy × HKCU/HKLM. Never write.
  ReadRegStr $ccHahaPrimaryPerUserInstallLocation HKCU "${CCMAX_PRIMARY_INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $ccHahaPrimaryPerMachineInstallLocation HKLM "${CCMAX_PRIMARY_INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $ccHahaLegacyPerUserInstallLocation HKCU "${CCMAX_LEGACY_INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $ccHahaLegacyPerMachineInstallLocation HKLM "${CCMAX_LEGACY_INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $ccHahaPrimaryPerUserUninstallString HKCU "${CCMAX_PRIMARY_UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $ccHahaPrimaryPerMachineUninstallString HKLM "${CCMAX_PRIMARY_UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $ccHahaLegacyPerUserUninstallString HKCU "${CCMAX_LEGACY_UNINSTALL_REGISTRY_KEY}" UninstallString
  ReadRegStr $ccHahaLegacyPerMachineUninstallString HKLM "${CCMAX_LEGACY_UNINSTALL_REGISTRY_KEY}" UninstallString

  ${If} $ccHahaPrimaryPerUserInstallLocation == ""
  ${AndIf} $ccHahaPrimaryPerUserUninstallString != ""
    Push $ccHahaPrimaryPerUserUninstallString
    Call CcHahaUninstallerParent
    Pop $ccHahaPrimaryPerUserInstallLocation
  ${EndIf}
  ${If} $ccHahaPrimaryPerMachineInstallLocation == ""
  ${AndIf} $ccHahaPrimaryPerMachineUninstallString != ""
    Push $ccHahaPrimaryPerMachineUninstallString
    Call CcHahaUninstallerParent
    Pop $ccHahaPrimaryPerMachineInstallLocation
  ${EndIf}
  ${If} $ccHahaLegacyPerUserInstallLocation == ""
  ${AndIf} $ccHahaLegacyPerUserUninstallString != ""
    Push $ccHahaLegacyPerUserUninstallString
    Call CcHahaUninstallerParent
    Pop $ccHahaLegacyPerUserInstallLocation
  ${EndIf}
  ${If} $ccHahaLegacyPerMachineInstallLocation == ""
  ${AndIf} $ccHahaLegacyPerMachineUninstallString != ""
    Push $ccHahaLegacyPerMachineUninstallString
    Call CcHahaUninstallerParent
    Pop $ccHahaLegacyPerMachineInstallLocation
  ${EndIf}

  Push "$INSTDIR"
  Call CcHahaFinalInstallDir
  Pop $9

  ${If} $4 == ""
  ${AndIf} $5 == ""
  ${AndIf} $ccHahaPrimaryPerUserInstallLocation == ""
  ${AndIf} $ccHahaPrimaryPerMachineInstallLocation == ""
  ${AndIf} $ccHahaLegacyPerUserInstallLocation == ""
  ${AndIf} $ccHahaLegacyPerMachineInstallLocation == ""
    StrCpy $0 "0"
    StrCpy $1 "No registered installation needs legacy data recovery"
    DetailPrint "$1"
    Return
  ${EndIf}

  InitPluginsDir
  File /oname=$PLUGINSDIR\recover-legacy-install-data.ps1 "${BUILD_RESOURCES_DIR}\recover-legacy-install-data.ps1"

  ReadEnvStr $2 APPDATA
  ReadEnvStr $3 USERPROFILE
  ReadEnvStr $6 CLAUDE_CONFIG_DIR
  ; Prefer CCMAX managed portable marker; fall back to historical CC_HAHA only when empty.
  ReadEnvStr $R9 CCMAX_APP_PORTABLE_DIR
  ReadEnvStr $7 CC_HAHA_APP_PORTABLE_DIR
  ${If} $R9 != ""
    StrCpy $7 $R9
  ${EndIf}
  ${If} $2 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user APPDATA"
    Return
  ${EndIf}
  ${If} $3 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user USERPROFILE"
    Return
  ${EndIf}

  DetailPrint "Checking registered installations for legacy Claude Code Haha / ccmax data..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\recover-legacy-install-data.ps1" -PrimaryPerUserInstallDir "$ccHahaPrimaryPerUserInstallLocation" -PrimaryPerMachineInstallDir "$ccHahaPrimaryPerMachineInstallLocation" -LegacyPerUserInstallDir "$ccHahaLegacyPerUserInstallLocation" -LegacyPerMachineInstallDir "$ccHahaLegacyPerMachineInstallLocation" -PerUserInstallDir "$4" -PerMachineInstallDir "$5" -CandidateInstallDir "$9" -PrimaryUserDataDir "$2\${CCMAX_PRIMARY_USER_DATA_NAME}" -LegacyUserDataDir "$2\${CCMAX_LEGACY_USER_DATA_NAME}" -UserDataDir "$2\Claude Code Haha" -RecoveryRoot "$3\${CCMAX_PRIMARY_RECOVERY_NAME}" -ProcessName "${CCMAX_PRIMARY_PROCESS_NAME}" -ProcessNames "${CCMAX_PRIMARY_PROCESS_NAME};${CCMAX_LEGACY_PROCESS_NAME}" -ActiveConfigDir "$6" -ActiveConfigManaged "$7" -InstallerIdentitySafety "$8"'
  Pop $0
  Pop $1
FunctionEnd

!macro CcHahaRunLegacyRecovery
  ${If} $ccHahaRecoveryDone != "1"
    StrCpy $ccHahaUniqueRegisteredInstall ""
    StrCpy $ccHahaHasDistinctRegisteredInstall "0"
    StrCpy $ccHahaHasMachineRegistration "0"

    ReadRegStr $ccHahaPerUserInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPerMachineInstallLocation HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHahaPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $ccHahaPerUserUninstallString == ""
        ReadRegStr $ccHahaPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
      ${If} $ccHahaPerMachineUninstallString == ""
        ReadRegStr $ccHahaPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif

    ReadRegStr $ccHahaPrimaryPerUserInstallLocation HKCU "${CCMAX_PRIMARY_INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPrimaryPerMachineInstallLocation HKLM "${CCMAX_PRIMARY_INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaLegacyPerUserInstallLocation HKCU "${CCMAX_LEGACY_INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaLegacyPerMachineInstallLocation HKLM "${CCMAX_LEGACY_INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHahaPrimaryPerUserUninstallString HKCU "${CCMAX_PRIMARY_UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHahaPrimaryPerMachineUninstallString HKLM "${CCMAX_PRIMARY_UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHahaLegacyPerUserUninstallString HKCU "${CCMAX_LEGACY_UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHahaLegacyPerMachineUninstallString HKLM "${CCMAX_LEGACY_UNINSTALL_REGISTRY_KEY}" UninstallString

    ${If} $ccHahaPerUserInstallLocation == ""
    ${AndIf} $ccHahaPerUserUninstallString != ""
      Push $ccHahaPerUserUninstallString
      Call CcHahaUninstallerParent
      Pop $ccHahaPerUserInstallLocation
    ${EndIf}
    ${If} $ccHahaPerMachineInstallLocation == ""
    ${AndIf} $ccHahaPerMachineUninstallString != ""
      Push $ccHahaPerMachineUninstallString
      Call CcHahaUninstallerParent
      Pop $ccHahaPerMachineInstallLocation
    ${EndIf}
    ${If} $ccHahaPrimaryPerUserInstallLocation == ""
    ${AndIf} $ccHahaPrimaryPerUserUninstallString != ""
      Push $ccHahaPrimaryPerUserUninstallString
      Call CcHahaUninstallerParent
      Pop $ccHahaPrimaryPerUserInstallLocation
    ${EndIf}
    ${If} $ccHahaPrimaryPerMachineInstallLocation == ""
    ${AndIf} $ccHahaPrimaryPerMachineUninstallString != ""
      Push $ccHahaPrimaryPerMachineUninstallString
      Call CcHahaUninstallerParent
      Pop $ccHahaPrimaryPerMachineInstallLocation
    ${EndIf}
    ${If} $ccHahaLegacyPerUserInstallLocation == ""
    ${AndIf} $ccHahaLegacyPerUserUninstallString != ""
      Push $ccHahaLegacyPerUserUninstallString
      Call CcHahaUninstallerParent
      Pop $ccHahaLegacyPerUserInstallLocation
    ${EndIf}
    ${If} $ccHahaLegacyPerMachineInstallLocation == ""
    ${AndIf} $ccHahaLegacyPerMachineUninstallString != ""
      Push $ccHahaLegacyPerMachineUninstallString
      Call CcHahaUninstallerParent
      Pop $ccHahaLegacyPerMachineInstallLocation
    ${EndIf}

    ${If} $ccHahaPerMachineInstallLocation != ""
    ${OrIf} $ccHahaPerMachineUninstallString != ""
    ${OrIf} $ccHahaPrimaryPerMachineInstallLocation != ""
    ${OrIf} $ccHahaPrimaryPerMachineUninstallString != ""
    ${OrIf} $ccHahaLegacyPerMachineInstallLocation != ""
    ${OrIf} $ccHahaLegacyPerMachineUninstallString != ""
      StrCpy $ccHahaHasMachineRegistration "1"
    ${EndIf}

    Push $ccHahaPrimaryPerUserInstallLocation
    Call CcHahaNoteRegisteredInstall
    Push $ccHahaLegacyPerUserInstallLocation
    Call CcHahaNoteRegisteredInstall
    Push $ccHahaPerUserInstallLocation
    Call CcHahaNoteRegisteredInstall
    Push $ccHahaPrimaryPerMachineInstallLocation
    Call CcHahaNoteRegisteredInstall
    Push $ccHahaLegacyPerMachineInstallLocation
    Call CcHahaNoteRegisteredInstall
    Push $ccHahaPerMachineInstallLocation
    Call CcHahaNoteRegisteredInstall

    ${If} $ccHahaPerUserInstallLocation == ""
    ${AndIf} $ccHahaPerMachineInstallLocation == ""
    ${AndIf} $ccHahaPerUserUninstallString == ""
    ${AndIf} $ccHahaPerMachineUninstallString == ""
    ${AndIf} $ccHahaPrimaryPerUserInstallLocation == ""
    ${AndIf} $ccHahaPrimaryPerMachineInstallLocation == ""
    ${AndIf} $ccHahaLegacyPerUserInstallLocation == ""
    ${AndIf} $ccHahaLegacyPerMachineInstallLocation == ""
    ${AndIf} $ccHahaPrimaryPerUserUninstallString == ""
    ${AndIf} $ccHahaPrimaryPerMachineUninstallString == ""
    ${AndIf} $ccHahaLegacyPerUserUninstallString == ""
    ${AndIf} $ccHahaLegacyPerMachineUninstallString == ""
      StrCpy $ccHahaRecoveryDone "1"
      DetailPrint "No registered installation needs legacy data recovery"
    ${Else}
      StrCpy $8 "trusted-user"
      ${If} ${UAC_IsAdmin}
      ${AndIfNot} ${UAC_IsInnerInstance}
        StrCpy $8 "untrusted-elevated"
      ${EndIf}
      ${If} ${UAC_IsInnerInstance}
        StrCpy $8 "trusted-uac-outer"
      ${EndIf}

      Call CcHahaCanSkipLegacyRecovery
      Pop $R0
      ${If} $R0 == "1"
        StrCpy $ccHahaRecoveryDone "1"
        DetailPrint "No legacy data candidates found for the registered per-user installation"
      ${Else}
        ${If} ${UAC_IsInnerInstance}
          !insertmacro UAC_AsUser_Call Function CcHahaRecoverLegacy ${UAC_SYNCREGISTERS}|${UAC_SYNCOUTDIR}|${UAC_SYNCINSTDIR}
        ${Else}
          Call CcHahaRecoverLegacy
        ${EndIf}

        ${If} $0 != "0"
          DetailPrint "Legacy data recovery stopped the installer (helper exit code: $0; output: $1)"
          ${If} $1 == ""
            StrCpy $1 "Recovery helper failed without diagnostic output (exit code $0)"
          ${EndIf}
          StrCpy $R2 "$1" 360
          MessageBox MB_ICONSTOP|MB_OK "ccmax stopped setup before removing the old version. Reason: $R2$\r$\n$\r$\nClose the app and retry. If the reason mentions an elevated installer, launch setup normally instead of using Run as administrator.$\r$\n$\r$\nccmax 已在删除旧版本前停止安装。原因：$R2$\r$\n$\r$\n请关闭旧程序后重试；如果原因提到安装器权限过高，请直接双击运行，不要使用“以管理员身份运行”。旧版本和原数据尚未删除。" /SD IDOK
          SetErrorLevel 20
          Quit
        ${EndIf}
        StrCpy $ccHahaRecoveryDone "1"
        DetailPrint "Legacy Claude Code Haha data safety check completed"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro CcHahaFindInstallProcess _FILE _RETURN
  ${If} $IsPowerShellAvailable == 0
    nsExec::ExecToStack '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-install-processes.ps1" -InstallDir "$INSTDIR" -ProcessName "${_FILE}" -ProcessNames "${CCMAX_PRIMARY_PROCESS_NAME};${CCMAX_LEGACY_PROCESS_NAME}" -Action Find -InstallerPid "$pid" -InstallerParentPid "$1"'
    Pop ${_RETURN}
    Pop $ccHahaProcessDiagnostic
    ${If} $ccHahaProcessDiagnostic != ""
      DetailPrint "$ccHahaProcessDiagnostic"
    ${EndIf}
  ${Else}
    Delete "$PLUGINSDIR\cc-haha-processes.csv"
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec '"$CmdPath" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\cc-haha-processes.csv"'
    !else
      nsExec::Exec '"$CmdPath" /D /C tasklist /FI "USERNAME eq %USERNAME%" /FO CSV /NH > "$PLUGINSDIR\cc-haha-processes.csv"'
    !endif
    Pop ${_RETURN}
    ${If} ${_RETURN} != 0
      StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable and tasklist process enumeration failed (exit code ${_RETURN}); blocking setup."
      StrCpy ${_RETURN} 0
    ${Else}
      nsExec::Exec '"$SYSDIR\findstr.exe" /I /L /C:"${_FILE}" /C:"${CCMAX_PRIMARY_PROCESS_NAME}" /C:"${CCMAX_LEGACY_PROCESS_NAME}" /C:"claude-sidecar-x86_64-pc-windows-msvc.exe" /C:"claude-sidecar-aarch64-pc-windows-msvc.exe" /C:"claude-sidecar.exe" /C:"OpenConsole.exe" /C:"winpty-agent.exe" /C:"rg.exe" "$PLUGINSDIR\cc-haha-processes.csv"'
      Pop ${_RETURN}
      ${If} ${_RETURN} == 0
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; the main app, a known sidecar, or a bundled terminal/search helper is running with an unknown path. Close it manually."
      ${ElseIf} ${_RETURN} == 1
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; exact-image fallback found no main app, known sidecar, or bundled terminal/search helper. Differently named child processes cannot be attributed without path data."
      ${Else}
        StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable and fallback process filtering failed (exit code ${_RETURN}); blocking setup."
        StrCpy ${_RETURN} 0
      ${EndIf}
    ${EndIf}
    DetailPrint "$ccHahaProcessDiagnostic"
  ${EndIf}
!macroend

!macro CcHahaKillInstallProcess _FILE _FORCE
  Push $0
  ${If} ${_FORCE} == 1
    StrCpy $0 "KillForce"
  ${Else}
    StrCpy $0 "Kill"
  ${EndIf}

  ${If} $IsPowerShellAvailable == 0
    nsExec::ExecToStack '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-install-processes.ps1" -InstallDir "$INSTDIR" -ProcessName "${_FILE}" -ProcessNames "${CCMAX_PRIMARY_PROCESS_NAME};${CCMAX_LEGACY_PROCESS_NAME}" -Action "$0" -InstallerPid "$pid" -InstallerParentPid "$1"'
    Pop $0
    Pop $ccHahaProcessDiagnostic
    ${If} $ccHahaProcessDiagnostic != ""
      DetailPrint "$ccHahaProcessDiagnostic"
    ${EndIf}
  ${Else}
    StrCpy $ccHahaProcessDiagnostic "PowerShell unavailable; refusing to terminate by image name because the executable path is unknown. Close the app manually."
    DetailPrint "$ccHahaProcessDiagnostic"
  ${EndIf}
  Pop $0
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\check-install-processes.ps1 "${BUILD_RESOURCES_DIR}\check-install-processes.ps1"
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $ccHahaProcessDiagnostic ""
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${If} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${If} ${isUpdated}
      Sleep 300
    ${EndIf}

    !insertmacro CcHahaFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${If} ${isUpdated}
        Sleep 1000
        Goto cc_haha_stop_process
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK cc_haha_stop_process
      SetErrorLevel 22
      Quit

      cc_haha_stop_process:
        DetailPrint "$(appClosing)"
        !insertmacro CcHahaKillInstallProcess "${APP_EXECUTABLE_FILENAME}" 0
        Sleep 300
        StrCpy $R1 0

      cc_haha_process_retry:
        IntOp $R1 $R1 + 1
        !insertmacro CcHahaFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          Sleep 1000
          !insertmacro CcHahaKillInstallProcess "${APP_EXECUTABLE_FILENAME}" 1
          !insertmacro CcHahaFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
          ${If} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${Else}
            Goto cc_haha_process_not_running
          ${EndIf}
        ${Else}
          Goto cc_haha_process_not_running
        ${EndIf}

        ${If} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)$\r$\n$\r$\n$ccHahaProcessDiagnostic" /SD IDCANCEL IDRETRY cc_haha_process_retry
          SetErrorLevel 22
          Quit
        ${Else}
          Goto cc_haha_process_retry
        ${EndIf}

      cc_haha_process_not_running:
    ${EndIf}
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    !insertmacro CcHahaRunLegacyRecovery
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Function CcHahaRecoveryBeforeInstall
    ${If} ${UAC_IsInnerInstance}
      !insertmacro CcHahaRunLegacyRecovery
    ${EndIf}
    Abort
  FunctionEnd
  Page custom CcHahaRecoveryBeforeInstall
!macroend

!macro customInit
  StrCpy $ccHahaRecoveryDone "0"
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${Silent}
    !insertmacro CcHahaRunLegacyRecovery
  ${EndIf}
!macroend
!endif