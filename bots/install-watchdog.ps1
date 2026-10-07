# Install the bridge-bot watchdog (bots/watchdog.mjs) as a scheduled task that
# runs every 5 minutes as the same least-privilege account as the bot.
#   powershell -File bots\install-watchdog.ps1 -User molibra-bot
#   powershell -File bots\install-watchdog.ps1 -Remove
param(
  [string]$DataDir = 'C:\Users\Administrator\molibra-bots',
  [string]$User = 'molibra-bot',
  [string]$Vault = 'C:\Users\Administrator\Desktop\Server Ops\vault.ps1',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$TaskName = 'Molibra bridge watchdog'
if ($Remove) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "removed: $TaskName"; return }
$Repo = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "bots\watchdog.mjs --data-dir `"$DataDir`"" -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$pw = & $Vault get "$User-password"
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -User $User -Password $pw -RunLevel Limited -Settings $settings -Force | Out-Null
Remove-Variable pw
"installed: $TaskName (as $User, every 5 min, from $Repo)"
