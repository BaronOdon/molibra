# Install the anchoring cron on THIS Windows box.
#
#   powershell -File deploy\install-anchor-publisher.ps1 -IntervalMinutes 180
#   powershell -File deploy\install-anchor-publisher.ps1 -Remove
#
# ⛔⛔ EXACTLY ONE HOST MAY RUN THIS. `anchor()` requires strictly increasing
#    height and work, so a second scheduler racing this one pays full gas for a
#    reverted transaction out of a wallet with a countable number of anchors in
#    it. The lock in anchor-publisher.mjs is per-host and cannot see the other.
#
# ⛔ Why here and not on a node. The publisher key lives in CREDENTIALS.md on
#    this box and controls a mainnet wallet holding ETH and a 20,000 WSRO bond.
#    Installing the cron on node 1 means copying that key onto an
#    internet-facing host, which is the blast radius the separate publisher
#    existed to avoid. The cost of running it here is that anchoring stops when
#    this box is off - the floor then holds where it was, which is the safe
#    direction. Nothing about the chain depends on this host being up.
#
# ⛔ LogonType S4U, not Interactive: an Interactive task receives CTRL_CLOSE and
#    dies with STATUS_CONTROL_C_EXIT whenever the RDP session ends. This is a
#    short-lived task rather than a daemon, but the failure is the same one and
#    it fails silently, which is worse in a job nobody watches.

param(
  [int]$IntervalMinutes = 180,
  [string]$Node = 'http://193.123.191.142:8545',
  [int]$Depth = 200,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Molibra anchor publisher'
$Repo = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed: $TaskName"
  exit 0
}

# ⛔ NOT $node. PowerShell variable names are case-insensitive, so `$node` IS the
#    `-Node` parameter: assigning the interpreter path here silently overwrote
#    the RPC URL, and the task installed with `--node C:\Program Files\...`.
#    It was caught only because the command is printed back below - which is the
#    argument for printing it back.
$nodeExe = (Get-Command node).Source
$log  = Join-Path $Repo 'anchor-publisher.log'

# ⛔ The whole command as one string, quoted for cmd, appending to a log. A
#    scheduled task that writes nowhere is a task whose failures nobody sees -
#    and this one fails by DESIGN most runs ("the chain has not advanced past
#    the last anchor yet"), so the log is the only way to tell that apart from
#    a broken key or an empty wallet.
#    ⛔ The whole thing gets ONE outer pair of quotes on top of the inner ones.
#    `cmd /c` strips the first and last quote of its argument when the argument
#    starts with one, so `/c "C:\Program Files\nodejs\node.exe" ...` loses the
#    quotes that make the space in the path survive, and the task fails with
#    "'C:\Program' is not recognized" - in a log nobody reads.
$cmd = "`"$nodeExe`" anchor-publisher.mjs --send --node $Node --depth $Depth"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"$cmd >> `"$log`" 2>&1`"" -WorkingDirectory $Repo

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$principal = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
Write-Host "installed: $TaskName"
Write-Host "  every    : $IntervalMinutes min"
Write-Host "  command  : $cmd"
Write-Host "  log      : $log"
Write-Host "  logon    : $($t.Principal.LogonType)  (must be S4U)"
Write-Host ""
Write-Host "Verify the FIRST run before trusting it:"
Write-Host "  Get-Content '$log' -Tail 30"
