# Registers the crawler as a Windows Scheduled Task so it starts automatically
# at logon and is kept alive by Windows (pm2-free, survives reboots).
#
# Run ONCE, from an elevated PowerShell (Run as Administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\install-crawler-task.ps1
#
# What it does: creates a task named "UEFN Stats Crawler" that runs
# scripts/run-crawler.ps1 (the keep-alive wrapper) at your logon. The wrapper
# itself restarts node if it crashes; the task ensures the wrapper is running
# after a reboot/login.
#
# Manage it afterwards:
#   Start-ScheduledTask  -TaskName "UEFN Stats Crawler"   # start now
#   Stop-ScheduledTask   -TaskName "UEFN Stats Crawler"   # stop
#   Get-ScheduledTask    -TaskName "UEFN Stats Crawler"   # status
#   Unregister-ScheduledTask -TaskName "UEFN Stats Crawler" -Confirm:$false  # remove

$ErrorActionPreference = 'Stop'
$taskName = 'UEFN Stats Crawler'

$root = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $root 'scripts\run-crawler.ps1'
if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

# The action: run powershell hidden, executing the keep-alive wrapper.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""

# Trigger: at logon of the current user.
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Settings: keep it running indefinitely, restart if it fails, don't stop it
# on idle or battery (a laptop shouldn't kill the crawler when unplugged).
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # 0 = no time limit

# Run as the current user, only when logged on (so it inherits your env /
# .env.local access without storing a password).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# Replace any existing task of the same name.
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Output "Removed existing task '$taskName' to re-register."
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description 'Keeps the UEFN Stats crawler (src/main.js) running; auto-starts at logon.' | Out-Null

Write-Output "Registered scheduled task '$taskName'."
Write-Output "Start it now with:  Start-ScheduledTask -TaskName `"$taskName`""
