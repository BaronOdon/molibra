# Install the Molibra bridge bot as a Windows scheduled task on THIS box.
#
#   powershell -File bots\install-bridge-bot.ps1 -DryRun     # first: watch it read, send nothing
#   powershell -File bots\install-bridge-bot.ps1             # live (returns stay dry-run below the flag day)
#   powershell -File bots\install-bridge-bot.ps1 -Remove
#
# ⛔ NOT run by the session that wrote it. The operator (or the main session,
#    with the operator's go-ahead) installs it, after: the push, both nodes
#    upgraded (node 2, then node 1) before BOT_HEADER_ACTIVATION, and the two
#    bot addresses funded. See the report that came with this commit.
#
# ⛔⛔ EXACTLY ONE HOST MAY RUN THE LIVE BOT. Two would race the same nonces on
#    both chains. The lock in bridge-bot.mjs is per data dir and cannot see
#    another machine.
#
# How it stays up (the same S4U pattern as "\Molibra anchor publisher", which
# is a short-lived job; this one is a daemon, so three things differ):
#   - triggers: at startup, AND every 10 minutes. MultipleInstances=IgnoreNew,
#     so while it runs the repeats do nothing, and if it ever dies the next
#     repeat starts it again: a crash costs at most ten minutes.
#   - ExecutionTimeLimit = 0 (no limit): it is meant to run forever.
#   - RestartOnFailure: 3 tries a minute apart, for a fatal exit (exit code 1).
# ⛔ LogonType S4U, not Interactive: an Interactive task dies with
#    STATUS_CONTROL_C_EXIT whenever the RDP session ends - silently.
#
# Watching it: heartbeat.json in the data dir is rewritten every loop and every
# minute while it sleeps. If its "at" is older than ~15 minutes, it is dead or
# hung. pending-operator.json lists everything that needs a person.
# Stopping it cleanly: create an empty file named STOP in the data dir.

param(
  [string]$DataDir = 'C:\Users\Administrator\molibra-bots',
  [int]$IntervalSec = 300,
  [switch]$DryRun,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = if ($DryRun) { 'Molibra bridge bot (dry-run)' } else { 'Molibra bridge bot' }
$Repo = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed: $TaskName"
  exit 0
}

if (-not (Test-Path (Join-Path $DataDir 'keys.json'))) {
  throw "no keys.json in $DataDir - the bot keys are recorded in CREDENTIALS.md (2 Oct 2026)"
}
if (Test-Path (Join-Path $Repo 'keys.json')) {
  throw "a keys.json exists INSIDE the repository at $Repo - move it out before anything else"
}

# ⛔ NOT $node: PowerShell variables are case-insensitive (see install-anchor-publisher.ps1).
$nodeExe = (Get-Command node).Source
$errLog  = Join-Path $DataDir 'bridge-bot.stderr.log'
$flags   = "--data-dir `"$DataDir`" --interval $IntervalSec"
if ($DryRun) { $flags = "--dry-run $flags" }

# One outer pair of quotes for cmd /c, or the space in "Program Files" splits it.
$cmd = "`"$nodeExe`" bots\bridge-bot.mjs $flags"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"$cmd 2>> `"$errLog`"`"" -WorkingDirectory $Repo

$atStartup = New-ScheduledTaskTrigger -AtStartup
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $repeat) `
  -Principal $principal -Settings $settings -Force | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
Write-Host "installed: $TaskName"
Write-Host "  command  : $cmd"
Write-Host "  data dir : $DataDir"
Write-Host "  logon    : $($t.Principal.LogonType)  (must be S4U)"
Write-Host ""
Write-Host "Verify the FIRST run before trusting it (about 2 minutes from now):"
Write-Host "  Get-Content '$DataDir\heartbeat$(if ($DryRun) { '.dry-run' }).json'"
Write-Host "  Get-Content '$DataDir\bridge-bot$(if ($DryRun) { '.dry-run' }).log' -Tail 20"
Write-Host "  Get-Content '$DataDir\pending-operator$(if ($DryRun) { '.dry-run' }).json'"
