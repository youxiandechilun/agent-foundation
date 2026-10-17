#requires -Version 7.0
param([string]$ArchivePath)
$ErrorActionPreference = 'Stop'
$sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $ArchivePath) { $ArchivePath = Join-Path (Split-Path $sourceRoot -Parent) 'agent-foundation-source.zip' }
$archiveFull = [System.IO.Path]::GetFullPath($ArchivePath)
if ([System.IO.Path]::GetExtension($archiveFull) -ne '.zip') { throw 'Archive must end with .zip' }
if ($archiveFull.StartsWith($sourceRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must be outside the source tree' }
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Open($archiveFull, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
$script:count = 0
function Add-SourceDirectory([string]$Directory) {
  foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($item.PSIsContainer) {
      if ($item.Name -notin @('node_modules','dist','workspace','demo-output','.git') -and -not $item.Name.StartsWith('.agent-data')) {
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw ('Refuse to package a linked directory: ' + $item.FullName) }
        Add-SourceDirectory $item.FullName
      }
    } else {
      if ($item.Name -in @('.env','config.local.json','api-token')) { continue }
      $relative = [System.IO.Path]::GetRelativePath($sourceRoot, $item.FullName).Replace('\','/')
      $currentEvidence = @('report.json','source-manifest.json','core-acceptance.json','build.log','source-independence.log','core-integration.log','production-dependency-audit.log','compiled-smoke.log','acceptance-evidence.log','clean-source-rebuild.json','clean-source-npm-ci.log','clean-source-build.log','clean-source-source-check.log','clean-source-core-tests.log','clean-source-compiled-smoke.log','clean-source-core-isolation.log')
      $currentEvidence += @('audit-report.json','audit-baseline.log','audit-runtime-baseline.log','audit-data-baseline.log','audit-storage-baseline.log','audit-features-intermediate.log')
      $currentEvidence += @('docker-runtime.json','windows-sandbox-network.json')
      $currentEvidence += @('application-report.json','application-build.log','application-integration.log','application-dependency-audit.log','application-compiled-smoke.log','clean-host-source-rebuild.json','clean-host-source-npm-ci.log','clean-host-source-build.log','clean-host-source-source-check.log','clean-host-source-host-tests.log','clean-host-source-compiled-smoke.log')
      if ($relative.StartsWith('verification/') -and $item.Name -notin $currentEvidence) { continue }
      $entry = $zip.CreateEntry('agent-foundation/' + $relative, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      $inputStream = [System.IO.File]::OpenRead($item.FullName)
      try { $inputStream.CopyTo($entryStream) } finally { $inputStream.Dispose(); $entryStream.Dispose() }
      $script:count++
    }
  }
}
try { Add-SourceDirectory $sourceRoot } finally { $zip.Dispose(); $stream.Dispose() }
[pscustomobject]@{ Archive=$archiveFull; Files=$script:count; Bytes=(Get-Item -LiteralPath $archiveFull).Length; SHA256=(Get-FileHash -LiteralPath $archiveFull -Algorithm SHA256).Hash }
