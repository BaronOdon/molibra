<#
  Build Molibra-Miner-Setup.exe.

    powershell -ExecutionPolicy Bypass -File installers\windows\build.ps1 [-Iscc <path to ISCC.exe>]

  1. the official Node.js for Windows, checked against a PINNED SHA-256, staged untouched;
  2. the Molibra app from `git archive HEAD` (exactly one commit, nothing uncommitted),
     with its dependencies from the lockfile;
  3. compile with Inno Setup;
  4. ⛔ scan the output with Microsoft Defender and refuse to publish anything it flags;
  5. write SHA256SUMS entries for the release.
#>
param([string]$Iscc = 'ISCC.exe', [string]$Version = '1.0.0')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$Here = $PSScriptRoot
$Repo = (Resolve-Path (Join-Path $Here '..\..')).Path
$Stage = Join-Path $Here 'stage'
$Dist = Join-Path $Here '..\dist'

$NodeVersion = 'v24.21.0'
$NodeZip = "node-$NodeVersion-win-x64.zip"
$NodeSha = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage, $Dist | Out-Null

# ---- 1. runtime
$zip = Join-Path $env:TEMP $NodeZip
if (-not (Test-Path $zip) -or (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $NodeSha) {
  Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/$NodeZip" -OutFile $zip
}
$got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($got -ne $NodeSha) { throw "Node.js zip hash $got does not match the pinned $NodeSha" }
Expand-Archive -Force $zip -DestinationPath $Stage
Rename-Item (Join-Path $Stage "node-$NodeVersion-win-x64") 'runtime'
$sig = Get-AuthenticodeSignature (Join-Path $Stage 'runtime\node.exe')
if ($sig.Status -ne 'Valid') { throw "node.exe is not validly signed: $($sig.Status)" }
Write-Host "runtime  $NodeVersion, node.exe signed by: $($sig.SignerCertificate.Subject)"

# ---- 2. app, from one commit
$commit = (git -C $Repo rev-parse HEAD).Trim()
$tar = Join-Path $env:TEMP 'molibra-app.tar'
git -C $Repo archive --format=tar -o $tar HEAD src genesis.json package.json package-lock.json LICENSE NOTICE
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'app') | Out-Null
# ⛔ Windows' own tar, by full path. A bare `tar` can resolve to Git's MSYS tar,
#    which reads "C:" as a REMOTE HOST, extracts nothing and says so only on
#    stderr - the first build shipped an installer with an empty app folder.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $tar -C (Join-Path $Stage 'app')
Remove-Item $tar
# ⛔ Checked BEFORE npm runs: in a folder with no package.json, npm walks UP and
#    operates on whatever package.json it finds - here, the repository's own.
foreach ($must in 'src\cli.js', 'package.json', 'package-lock.json', 'genesis.json') {
  if (-not (Test-Path (Join-Path $Stage "app\$must"))) { throw "staged app is missing $must - not building" }
}
Push-Location (Join-Path $Stage 'app')
& (Join-Path $Stage 'runtime\node.exe') (Join-Path $Stage 'runtime\node_modules\npm\bin\npm-cli.js') ci --omit=dev --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
Pop-Location
Set-Content -Path (Join-Path $Stage 'app\COMMIT') -Value $commit -Encoding ASCII
Copy-Item (Join-Path $Repo 'installers\launcher\molibra-miner.mjs') $Stage
Write-Host "app      $($commit.Substring(0,7))"

# ---- 3. compile
& $Iscc "/DAppVersion=$Version" /Q (Join-Path $Here 'molibra-miner.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)" }
$exe = Join-Path $Dist 'Molibra-Miner-Setup.exe'
Write-Host "built    $exe  $([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB"

# ---- 4. Defender, on the installer AND on everything inside it
$mp = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
if (Test-Path $mp) {
  foreach ($target in @($exe, $Stage)) {
    $out = & $mp -Scan -ScanType 3 -File $target -DisableRemediation 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $out -match 'found \d+ threats' -and $out -notmatch 'found no threats') {
      throw "Microsoft Defender flagged $target :`n$out"
    }
    Write-Host "defender clean: $target"
  }
} else { Write-Warning 'Microsoft Defender is not available here: the build is NOT scanned' }

# ---- 5. checksums
$h = (Get-FileHash -Algorithm SHA256 $exe).Hash.ToLower()
Set-Content -Path (Join-Path $Dist 'SHA256SUMS-windows.txt') -Value "$h  Molibra-Miner-Setup.exe" -Encoding ASCII
Write-Host "sha256   $h"
