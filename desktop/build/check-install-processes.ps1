[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$InstallDirs = '',
  [string]$ProcessName = '',
  [string]$ProcessNames = '',
  [ValidateSet('Find', 'Kill', 'KillForce')][string]$Action = 'Find',
  [int]$InstallerPid = 0,
  [int]$InstallerParentPid = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedList {
  param([AllowEmptyString()][string[]]$Values)

  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $result = New-Object 'System.Collections.Generic.List[string]'
  foreach ($value in $Values) {
    if ([string]::IsNullOrWhiteSpace($value)) {
      continue
    }
    foreach ($part in ([string]$value).Split(@(';', ','), [StringSplitOptions]::RemoveEmptyEntries)) {
      $trimmed = $part.Trim()
      if ([string]::IsNullOrWhiteSpace($trimmed)) {
        continue
      }
      if ($seen.Add($trimmed)) {
        $result.Add($trimmed)
      }
    }
  }
  return $result.ToArray()
}

function Test-PathInsideInstallDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
  $rootWithSeparator = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
  return $resolvedCandidate.StartsWith(
    $rootWithSeparator,
    [StringComparison]::OrdinalIgnoreCase)
}

try {
  $protectedRoots = @(Get-NormalizedList -Values @($InstallDir, $InstallDirs))
  if ($protectedRoots.Count -eq 0) {
    throw 'At least one install directory is required for process matching.'
  }
  foreach ($root in $protectedRoots) {
    if (-not [IO.Path]::IsPathRooted($root)) {
      throw "Application install directory is relative and cannot be checked safely: $root"
    }
  }

  $appProcessNames = @(Get-NormalizedList -Values @($ProcessName, $ProcessNames))
  if ($appProcessNames.Count -eq 0) {
    throw 'At least one application process name is required for unknown-path fail-closed matching.'
  }

  $matches = New-Object 'System.Collections.Generic.List[object]'
  $unknownPathMatches = New-Object 'System.Collections.Generic.List[object]'
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.ProcessId -eq $InstallerPid) {
      continue
    }

    $executablePath = [string]$process.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($executablePath)) {
      foreach ($name in $appProcessNames) {
        if (([string]$process.Name).Equals($name, [StringComparison]::OrdinalIgnoreCase)) {
          $unknownPathMatches.Add($process)
          break
        }
      }
      continue
    }

    foreach ($root in $protectedRoots) {
      if (Test-PathInsideInstallDirectory -Root $root -Candidate $executablePath) {
        $matches.Add($process)
        break
      }
    }
  }

  foreach ($process in $matches) {
    $path = if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
      '<path unavailable>'
    } else {
      [string]$process.ExecutablePath
    }
    [Console]::Out.WriteLine(
      "Matched protected install process: PID=$($process.ProcessId); Name=$($process.Name); Path=$path")
  }

  foreach ($process in $unknownPathMatches) {
    [Console]::Out.WriteLine(
      "Blocked unknown-path application process: PID=$($process.ProcessId); Name=$($process.Name); close it manually")
  }

  if ($matches.Count -eq 0 -and $unknownPathMatches.Count -eq 0) {
    exit 1
  }
  if ($Action -eq 'Find') {
    # Unknown-path main app processes fail closed: Find reports them as blocking
    # but Kill paths never terminate without a proven install-root path.
    exit 0
  }

  if ($unknownPathMatches.Count -gt 0 -and $matches.Count -eq 0) {
    [Console]::Out.WriteLine(
      'Refusing to terminate unknown-path application processes; close them manually.')
    exit 0
  }

  $force = $Action -eq 'KillForce'
  foreach ($process in $matches) {
    Stop-Process -Id $process.ProcessId -Force:$force -ErrorAction Stop
  }
  # Path-proven matches were killed; unknown-path names remain fail-closed and
  # are never terminated by image name.
  exit 0
} catch {
  $message = ([string]$_.Exception.Message) -replace '[\r\n]+', ' '
  [Console]::Out.WriteLine("Install process check failed closed: $message")
  exit 0
}