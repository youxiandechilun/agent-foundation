#requires -Version 7.0
param([string]$ArchivePath,[switch]$HostApplications)
$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ArchivePath) { $ArchivePath = Join-Path (Split-Path $sourceRoot -Parent) 'agent-foundation-source.zip' }
$archiveFull = (Resolve-Path -LiteralPath $ArchivePath).Path
$taskWorkRoot = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot '../../work'))
$rebuildRoot = Join-Path $taskWorkRoot ('source-rebuild-' + [Guid]::NewGuid().ToString('N'))
$reportRoot = Join-Path $sourceRoot 'verification'
New-Item -ItemType Directory -Path $rebuildRoot -Force | Out-Null
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
Expand-Archive -LiteralPath $archiveFull -DestinationPath $rebuildRoot
$freshProject = Join-Path $rebuildRoot 'agent-foundation'
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$taskSteps = @(
  @{ Name='npm-ci'; Command=$npmCommand; Arguments=@('ci','--omit=optional','--ignore-scripts','--no-audit','--no-fund') },
  @{ Name='build'; Command=$npmCommand; Arguments=@('run','build') },
  @{ Name='source-check'; Command=$nodeCommand; Arguments=@('scripts/verify-source.mjs') },
  @{ Name='core-isolation'; Command=$nodeCommand; Arguments=@('scripts/verify-core-isolation.mjs') },
  @{ Name='core-tests'; Command=$npmCommand; Arguments=@('test') },
  @{ Name='compiled-smoke'; Command=$nodeCommand; Arguments=@('test/smoke.compiled.mjs') }
)
if($HostApplications) {
 $taskSteps=@(
  @{Name='npm-ci';Command=$npmCommand;Arguments=@('ci','--ignore-scripts','--no-audit','--no-fund')},
  @{Name='build';Command=$npmCommand;Arguments=@('run','build:host')},
  @{Name='source-check';Command=$nodeCommand;Arguments=@('scripts/verify-source.mjs')},
  @{Name='host-tests';Command=$npmCommand;Arguments=@('run','test:host')},
  @{Name='compiled-smoke';Command=$nodeCommand;Arguments=@('test/smoke-host.compiled.mjs')}
 )
}
$taskResults = @()
Push-Location -LiteralPath $freshProject
try {
  foreach ($step in $taskSteps) {
    Write-Output ('Fresh source: ' + $step.Name)
    $started = [DateTime]::UtcNow
    $taskCommand = $step.Command
    $taskArguments = $step.Arguments
    $taskLog = & $taskCommand @taskArguments 2>&1 | Out-String
    $taskExitCode = $LASTEXITCODE
    $taskLogPrefix=if($HostApplications){'clean-host-source-'}else{'clean-source-'}
    $logName = $taskLogPrefix + $step.Name + '.log'
    [System.IO.File]::WriteAllText((Join-Path $reportRoot $logName), $taskLog, [System.Text.UTF8Encoding]::new($false))
    $taskResults += @{ name=$step.Name; exitCode=$taskExitCode; passed=($taskExitCode -eq 0); durationMs=[int]([DateTime]::UtcNow-$started).TotalMilliseconds; log=$logName }
    if ($taskExitCode -ne 0) { throw ('Fresh source failed: ' + $step.Name + "`n" + $taskLog) }
  }
  $originalManifest = Get-Content -LiteralPath (Join-Path $sourceRoot 'verification/source-manifest.json') -Raw | ConvertFrom-Json
  $freshManifest = Get-Content -LiteralPath (Join-Path $freshProject 'verification/source-manifest.json') -Raw | ConvertFrom-Json
  if (($originalManifest.files | ConvertTo-Json -Compress) -ne ($freshManifest.files | ConvertTo-Json -Compress)) { throw 'Source hashes differ between workspace and packaged rebuild' }
} finally { Pop-Location }
$report = [ordered]@{
  version=(Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version; checkedAt=[DateTime]::UtcNow.ToString('o'); passed=$true
  archiveVerified=$archiveFull; testedArchiveSha256=(Get-FileHash -LiteralPath $archiveFull -Algorithm SHA256).Hash
  extractedProject=$freshProject; nodeVersion=(& $nodeCommand --version); steps=$taskResults
  sourceHashesMatch=$true; sourceFiles=$originalManifest.sourceFiles
  prerequisites=$(if($HostApplications){'Fresh host npm install and host build. Actual cached Playwright Chromium, Chrome extension, optional Office/PDF/canvas libraries and Windows native APIs tested; no Docker or old dist/runtime state used.'}else{'Core requires Node/npm. This Windows rebuild exercises native ConPTY plus optional AppContainer commands/plugins/MCP/persistent pipes and lifecycle denial/cleanup by compiling bundled C# source with the OS .NET Framework csc. Isolated PTY and legacy Node child capture pipes remain unsupported. POSIX PTY and non-Windows OS sandboxes are not platform-validated here. No Docker, Chromium, Office libraries, old dist or runtime state used.'})
  optionalDependenciesOmitted=(-not $HostApplications)
  note='Repacking this report changes the ZIP hash; testedArchiveSha256 identifies the first tested archive. Source hashes remain identical.'
}
$reportJson = $report | ConvertTo-Json -Depth 10
$taskReportName=if($HostApplications){'clean-host-source-rebuild.json'}else{'clean-source-rebuild.json'}
[System.IO.File]::WriteAllText((Join-Path $reportRoot $taskReportName),$reportJson,[System.Text.UTF8Encoding]::new($false))
Write-Output $reportJson
