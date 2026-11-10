param(
    [string]$Client,
    [string]$Provider,
    [string]$Model,
    [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$Version = if ($env:YSK_VERSION) { $env:YSK_VERSION } else { '0.2.0' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid YSK_VERSION' }
$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Architecture -notin @('x64', 'arm64')) { throw 'Supported architectures: x64 and arm64.' }
$Root = if ($env:YSK_INSTALL_DIR) { $env:YSK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'YouShouldKnow' }
$Base = if ($env:YSK_RELEASE_BASE_URL) { $env:YSK_RELEASE_BASE_URL } else { "https://github.com/polanski13/you-should-know/releases/download/v$Version" }
$Asset = "you-should-know-windows-$Architecture.tar.gz"
$Versions = Join-Path $Root 'versions'
New-Item -ItemType Directory -Force -Path $Versions | Out-Null
$LockPath = Join-Path $Root '.install-lock'
$Lock = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$Temporary = Join-Path $Versions ('.download.' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $Temporary | Out-Null
    Write-Host "`nInstalling You Should Know $Version for Windows/$Architecture..."
    $Archive = Join-Path $Temporary $Asset
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $Archive
    $ChecksumsPath = Join-Path $Temporary 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile $ChecksumsPath
    $Checksums = Get-Content -Raw -LiteralPath $ChecksumsPath
    $Line = ($Checksums -split "`n" | Where-Object { $_.Trim() -match ('^[0-9a-f]{64}\s+' + [regex]::Escape($Asset) + '$') })
    if (@($Line).Count -ne 1) { throw 'Missing release checksum.' }
    $Expected = ($Line.Trim() -split '\s+')[0]
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToLowerInvariant() -ne $Expected) { throw 'Release checksum mismatch; installation stopped.' }
    $Payload = Join-Path $Temporary 'payload'
    New-Item -ItemType Directory -Path $Payload | Out-Null
    & tar -xzf $Archive -C $Payload
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the release. Windows tar is required.' }
    if ((Get-Content -Raw -LiteralPath (Join-Path $Payload 'VERSION')).Trim() -ne $Version) { throw 'Release version mismatch.' }
    & (Join-Path $Payload 'runtime/node.exe') (Join-Path $Payload 'app/cli.js') --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The bundled runtime could not start.' }
    Set-Content -LiteralPath (Join-Path $Payload 'ARCHIVE_SHA256') -Value $Expected -Encoding ASCII
    $Target = Join-Path $Versions $Version
    if (Test-Path -LiteralPath $Target) {
        if ((Get-Content -Raw -LiteralPath (Join-Path $Target 'ARCHIVE_SHA256')).Trim() -ne $Expected) { throw 'The existing version differs from this release. Preserve it and choose a different YSK_INSTALL_DIR.' }
    } else { Move-Item -LiteralPath $Payload -Destination $Target }
    $Arguments = @((Join-Path $Target 'app/cli.js'), 'setup', '--install-root', $Root)
    if ($Client) { $Arguments += @('--host', $Client) }
    if ($Provider) { $Arguments += @('--provider', $Provider) }
    if ($Model) { $Arguments += @('--model', $Model) }
    if ($NoPath) { $Arguments += '--no-path' }
    & (Join-Path $Target 'runtime/node.exe') @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Setup was not completed. The downloaded release has been preserved.' }
} finally {
    $Lock.Dispose()
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
}
