<#
.SYNOPSIS
  Creates an "OBS Studio (captions)" desktop shortcut that starts OBS with microphone access
  for browser caption pages.

.DESCRIPTION
  OBS Browser Sources only get microphone access when OBS is started with
  --enable-media-stream. This script creates a desktop shortcut to the installed OBS
  (default C:\Program Files\obs-studio\bin\64bit\obs64.exe), with the working directory set
  to OBS's own folder (OBS needs that to find its files) and that flag added.

  -AutoAccept also adds --use-fake-ui-for-media-stream, which grants the microphone without
  a prompt. Use it only if the microphone is still not granted, because then every page
  loaded in OBS gets the microphone.

  Run it through Windows PowerShell (make obs-shortcut does this):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\obs-media-shortcut.ps1 [-AutoAccept]

  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\obs-media-shortcut.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\obs-media-shortcut.ps1 -AutoAccept
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\obs-media-shortcut.ps1 -ObsPath "D:\Apps\obs-studio\bin\64bit\obs64.exe"
#>
[CmdletBinding()]
param(
  # Also pass --use-fake-ui-for-media-stream (auto-accept media permission prompts).
  [switch] $AutoAccept,
  # Full path to obs64.exe when OBS is not installed in the default location.
  [string] $ObsPath = '',
  # Shortcut name on the desktop.
  [string] $Name = 'OBS Studio (captions)'
)

$ErrorActionPreference = 'Stop'

$candidates = New-Object System.Collections.ArrayList
if ($ObsPath) { [void]$candidates.Add($ObsPath) }
if ($env:ProgramFiles) { [void]$candidates.Add((Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe')) }
[void]$candidates.Add('C:\Program Files\obs-studio\bin\64bit\obs64.exe')
# The OBS installer records its folder as the default value of HKLM\SOFTWARE\OBS Studio.
foreach ($key in @('HKLM:\SOFTWARE\OBS Studio', 'HKLM:\SOFTWARE\WOW6432Node\OBS Studio')) {
  try {
    $dir = (Get-Item -LiteralPath $key -ErrorAction Stop).GetValue('')
    if ($dir) { [void]$candidates.Add((Join-Path $dir 'bin\64bit\obs64.exe')) }
  } catch {
    # key not present
  }
}

$exe = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { $exe = (Resolve-Path -LiteralPath $c).Path; break }
}
if (-not $exe) {
  Write-Host 'OBS Studio (obs64.exe) was not found. Looked in:'
  foreach ($c in $candidates) { Write-Host ('  ' + $c) }
  Write-Host 'Pass the path:  ... -File scripts\obs-media-shortcut.ps1 -ObsPath "C:\path\to\obs-studio\bin\64bit\obs64.exe"'
  exit 1
}

$obsArgs = '--enable-media-stream'
if ($AutoAccept) { $obsArgs += ' --use-fake-ui-for-media-stream' }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop ($Name + '.lnk')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnk)
$shortcut.TargetPath = $exe
$shortcut.Arguments = $obsArgs
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.IconLocation = $exe + ',0'
$shortcut.Description = 'OBS Studio with microphone access for browser caption pages'
$shortcut.Save()

Write-Host ('Created: {0}' -f $lnk)
Write-Host ('Target:  "{0}" {1}' -f $exe, $obsArgs)
Write-Host ('Start in: {0}' -f (Split-Path -Parent $exe))
Write-Host 'Close OBS completely (also from the tray) and start it with this shortcut.'
Write-Host 'OBS uses the Windows default recording device; or add ?mic=<part of the device name> to the caption-page URL.'
