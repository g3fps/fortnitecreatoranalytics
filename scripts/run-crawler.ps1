# Always-on crawler runner for Windows (pm2-free).
#
# Runs `node src/main.js` and automatically restarts it if it ever exits
# (crash, transient Supabase/Epic error, etc.), with a short backoff so a
# hard-failing process doesn't spin the CPU. Logs stdout/stderr to
# data/crawler.log so you can see what it's doing after the fact.
#
# Start it manually with:   powershell -ExecutionPolicy Bypass -File scripts\run-crawler.ps1
# Or let Task Scheduler run it at logon (see scripts/install-crawler-task.ps1).
#
# Stop it: close the window, or `Stop-Process` the node.exe running main.js,
# or (if installed as a task) `Stop-ScheduledTask -TaskName "UEFN Stats Crawler"`.

$ErrorActionPreference = 'Stop'

# Project root = parent of this script's folder.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$node = (Get-Command node).Source
$logDir = Join-Path $root 'data'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir 'crawler.log'

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Output $line
  Add-Content -Path $log -Value $line
}

Write-Log "run-crawler starting (node: $node, root: $root)"

# node writes its own stdout/stderr to a separate file via Start-Process's
# native redirect (the OS hands node a file handle directly - no PowerShell
# pipeline in the middle, which is what caused the earlier hang and the
# UTF-16 spacing garbage). Keeping node's output in its own file also means
# the wrapper's own status lines (this $log) stay clean and readable.
$nodeOut = Join-Path $logDir 'crawler.out.log'
$nodeErr = Join-Path $logDir 'crawler.err.log'

$backoff = 2
while ($true) {
  Write-Log "launching: node src/main.js"
  $started = Get-Date

  # -Wait blocks until node exits; -NoNewWindow keeps it in this session;
  # -PassThru gives us the process object so we can read the real exit code.
  $proc = Start-Process -FilePath $node -ArgumentList 'src/main.js' `
    -WorkingDirectory $root -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $nodeOut -RedirectStandardError $nodeErr
  $code = $proc.ExitCode
  $ranSeconds = [int]((Get-Date) - $started).TotalSeconds

  # If it ran healthily for a while (>60s) before dying, treat this as a
  # fresh transient failure: reset the backoff. Only rapid crash-loops
  # escalate the delay (capped at 60s), so a bad env or Supabase-down state
  # retries calmly instead of hammering.
  if ($ranSeconds -gt 60) { $backoff = 2 }

  Write-Log "crawler exited with code $code after ${ranSeconds}s - restarting in ${backoff}s"
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, 60)
}
