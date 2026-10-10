<#
.SYNOPSIS
  Host audio bridge for Windows. macOS/Linux: scripts/audio-bridge.sh.

.DESCRIPTION
  Streams an audio input device (DirectShow), or a WAV file in real time, as raw s16le,
  48 kHz, stereo to the Turjuman container on tcp://127.0.0.1:<Port>
  (config: audio.input.kind: network). The bridge is deliberately dumb: channel pick, gain
  and resampling happen in the container, so config\config.yaml stays the single source of truth.

  Device mode reconnects forever (container restarted, cable pulled): 1 s pause and one
  timestamped line per reconnect. File mode streams the file once, retrying until the
  container accepts the connection. Ctrl-C stops.

  Always run it through Windows PowerShell like this (the make targets do):
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 <options>

  Autostart: -InstallAutostart registers the Task Scheduler task "Turjuman audio bridge" that
  starts the bridge hidden at logon (log: %LOCALAPPDATA%\Turjuman\audio-bridge.log). Remove it
  with -UninstallAutostart (make bridge-uninstall), or delete the task in Task Scheduler
  (taskschd.msc). A task from before the rename ("Khutbah captions audio bridge") is replaced.

  Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -List
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -Device "Line (USB Audio CODEC)"
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -File data\recordings\test.wav
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -InstallAutostart -Device "Line (USB Audio CODEC)"
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -UninstallAutostart
#>
[CmdletBinding()]
param(
  # Exact DirectShow device name, or its "Alternative name" (both are printed by -List).
  [string] $Device = '',
  # Container port on 127.0.0.1 (compose publishes 127.0.0.1:7000).
  [int] $Port = 7000,
  # List the audio input devices.
  [switch] $List,
  # Stream this WAV in real time instead of a device (tests and rehearsals).
  [string] $File = '',
  # Start the bridge hidden at logon (Task Scheduler). Needs -Device.
  [switch] $InstallAutostart,
  # Remove the logon task and stop a running bridge for this port.
  [switch] $UninstallAutostart,
  # Also append the timestamped lines to this file (the autostart task sets it).
  [string] $LogFile = '',
  [string] $TaskName = 'Turjuman audio bridge'
)

# The default task's name before the project was called Turjuman: installing or uninstalling the
# default task replaces or removes it too. A second instance's task has its own name (make passes
# "Turjuman audio bridge (<project>)").
$DefaultTaskName = 'Turjuman audio bridge'
$LegacyTaskName = 'Khutbah captions audio bridge'

function Remove-Task([string] $Name) {
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $false }
  Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue | Out-Null
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false | Out-Null
  return $true
}

$ErrorActionPreference = 'Stop'

function Write-Log([string] $Message) {
  $line = '{0} audio-bridge: {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  if ($LogFile) {
    try {
      $dir = Split-Path -Parent $LogFile
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 1MB)) {
        Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.1') -Force
      }
      Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch {
      # Logging must never stop the bridge.
    }
  }
}

function Show-Usage {
  Write-Host 'Usage (run from the repository folder):'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -List'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -Device "<name>" [-Port 7000]'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -File <wav> [-Port 7000]'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -InstallAutostart -Device "<name>"'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -UninstallAutostart'
  Write-Host 'Or via make (Git Bash): make bridge-list | make bridge DEVICE="<name>" | make bridge-install DEVICE="<name>"'
}

function Assert-Ffmpeg {
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host 'ffmpeg was not found on PATH. Install it with:  winget install Gyan.FFmpeg'
    Write-Host '(then open a new terminal, so the updated PATH is picked up)'
    exit 127
  }
}

function Get-DshowAudioDevice([object[]] $Lines) {
  # Parses `ffmpeg -list_devices true -f dshow -i dummy` output into @{ Name; Alt } entries.
  $devices = New-Object System.Collections.ArrayList
  $section = ''
  $current = $null
  foreach ($raw in $Lines) {
    $line = [string]$raw
    if ($line -match 'DirectShow (audio|video) devices') {
      # ffmpeg 4.x prints section headers
      $section = $Matches[1]
      continue
    }
    if ($line -match '^\[dshow @ [^\]]*\]\s+"(.+)"\s+\(([^)]*)\)\s*$') {
      # ffmpeg 5+: "Name" (audio) | (video) | (audio, video) | (none)
      $name = $Matches[1]
      $kinds = $Matches[2]
      $current = $null
      if ($kinds -like '*audio*') {
        $current = @{ Name = $name; Alt = '' }
        [void]$devices.Add($current)
      }
      continue
    }
    if ($line -match '^\[dshow @ [^\]]*\]\s+"(.+)"\s*$') {
      # ffmpeg 4.x: "Name" below a "DirectShow audio devices" header
      $name = $Matches[1]
      $current = $null
      if ($section -eq 'audio') {
        $current = @{ Name = $name; Alt = '' }
        [void]$devices.Add($current)
      }
      continue
    }
    if (($null -ne $current) -and ($line -match 'Alternative name\s+"(.+)"')) {
      $current.Alt = $Matches[1]
      continue
    }
  }
  return ,$devices
}

function Show-Devices {
  # ffmpeg prints the listing on stderr and exits non-zero; cmd.exe merges stderr into stdout,
  # so PowerShell receives plain strings. ffmpeg writes UTF-8, so decode it as UTF-8.
  $previous = [Console]::OutputEncoding
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
  try {
    $lines = @(cmd.exe /d /c 'ffmpeg -hide_banner -list_devices true -f dshow -i dummy 2>&1')
  } finally {
    try { [Console]::OutputEncoding = $previous } catch { }
  }

  $devices = Get-DshowAudioDevice $lines
  if ($devices.Count -eq 0) {
    Write-Host 'No DirectShow audio devices were recognised. Raw ffmpeg output:'
    foreach ($l in $lines) { Write-Host ('  ' + [string]$l) }
    return
  }
  Write-Host 'Audio input devices. Pass the name to -Device / DEVICE= (the alternative name also works'
  Write-Host 'and survives renames and odd characters):'
  foreach ($d in $devices) {
    Write-Host ('  "{0}"' -f $d.Name)
    if ($d.Alt) { Write-Host ('      alternative name: {0}' -f $d.Alt) }
  }
  Write-Host ''
  Write-Host 'Next:  make bridge DEVICE="<name>"   (foreground)   or   make bridge-install DEVICE="<name>"   (autostart at logon)'
}

function Start-Bridge {
  if ($File) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { Write-Host ('File not found: {0}' -f $File); exit 2 }
    $full = (Resolve-Path -LiteralPath $File).Path
    $inputArgs = @('-re', '-i', $full)
    $description = 'file ' + $full
  } else {
    $inputArgs = @('-f', 'dshow', '-audio_buffer_size', '50', '-i', ('audio=' + $Device))
    $description = 'DirectShow device "' + $Device + '"'
  }
  $target = 'tcp://127.0.0.1:{0}?tcp_nodelay=1' -f $Port
  $outputArgs = @('-ac', '2', '-ar', '48000', '-f', 's16le', '-flush_packets', '1', $target)

  Write-Log ('streaming {0} -> {1} (s16le, 48 kHz, stereo). Ctrl-C stops.' -f $description, $target)
  $reconnects = 0
  $quickFails = 0
  $logLevel = 'warning'
  while ($true) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $ffArgs = @('-hide_banner', '-loglevel', $logLevel, '-nostdin') + $inputArgs + $outputArgs
    & ffmpeg @ffArgs
    $rc = $LASTEXITCODE
    $watch.Stop()
    if ($File -and $rc -eq 0) {
      Write-Log ('finished streaming {0}' -f $full)
      return
    }
    # While the container is down every attempt fails at once; after 3 quick failures in a
    # row, silence ffmpeg's repeated "Connection refused" until a connection holds again.
    if ($watch.Elapsed.TotalSeconds -lt 3) {
      $quickFails++
      if ($quickFails -eq 3) {
        Write-Log "still failing - hiding ffmpeg's messages until a connection holds"
        $logLevel = 'quiet'
      }
    } else {
      $quickFails = 0
      $logLevel = 'warning'
    }
    $reconnects++
    Write-Log ('ffmpeg exited (code {0}) - reconnecting in 1 s (reconnect #{1}; is the container up? make status)' -f $rc, $reconnects)
    Start-Sleep -Seconds 1
  }
}

function Install-Autostart {
  if (-not $Device) {
    Write-Host '-InstallAutostart needs -Device "<name>" (see -List).'
    exit 2
  }
  $script = $PSCommandPath
  $logName = if ($Port -eq 7000) { 'audio-bridge.log' } else { 'audio-bridge-{0}.log' -f $Port }
  $logPath = Join-Path (Join-Path $env:LOCALAPPDATA 'Turjuman') $logName
  $argLine = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Device "{1}" -Port {2} -LogFile "{3}"' -f $script, $Device, $Port, $logPath
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine -WorkingDirectory (Split-Path -Parent $script)
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  # ExecutionTimeLimit 0 = run forever (the default would stop the bridge after 3 days).
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
      -Description 'Streams the audio interface to the Turjuman container (scripts\audio-bridge.ps1).' -Force | Out-Null
  } catch {
    Write-Host ('Could not register the scheduled task: {0}' -f $_.Exception.Message)
    Write-Host 'Try again from a PowerShell window opened with "Run as administrator".'
    exit 1
  }
  if ($TaskName -eq $DefaultTaskName -and (Remove-Task $LegacyTaskName)) {
    Write-Host ('Replaced the older task "{0}".' -f $LegacyTaskName)
  }
  Start-ScheduledTask -TaskName $TaskName
  Write-Host ('Installed "{0}": starts hidden at logon and is running now.' -f $TaskName)
  Write-Host ('  device: {0}   port: {1}' -f $Device, $Port)
  Write-Host ('  log:    {0}' -f $logPath)
  Write-Host 'Remove it with: make bridge-uninstall  (or -UninstallAutostart, or delete the task in taskschd.msc)'
}

function Uninstall-Autostart {
  if (Remove-Task $TaskName) {
    Write-Host ('Removed the scheduled task "{0}".' -f $TaskName)
  } else {
    Write-Host ('No scheduled task named "{0}" - nothing to remove.' -f $TaskName)
  }
  if ($TaskName -eq $DefaultTaskName -and (Remove-Task $LegacyTaskName)) {
    Write-Host ('Removed the older scheduled task "{0}".' -f $LegacyTaskName)
  }
  # Stop hidden bridge loops started by the task, then their ffmpeg for this port.
  $self = $PID
  $loops = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like '*audio-bridge.ps1*' -and $_.CommandLine -like '*-LogFile*' })
  foreach ($p in $loops) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $pattern = '*tcp://127.0.0.1:{0}*' -f $Port
  $ffmpegs = @(Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like $pattern })
  foreach ($p in $ffmpegs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if (($loops.Count + $ffmpegs.Count) -gt 0) {
    Write-Host ('Stopped {0} running bridge process(es).' -f ($loops.Count + $ffmpegs.Count))
  }
}

# ---- main ---------------------------------------------------------------------------------
if ($UninstallAutostart) { Uninstall-Autostart; exit 0 }
Assert-Ffmpeg
if ($List) { Show-Devices; exit 0 }
if ($InstallAutostart) { Install-Autostart; exit 0 }
if (-not $Device -and -not $File) { Show-Usage; exit 2 }
Start-Bridge
