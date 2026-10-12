param([Parameter(ValueFromRemainingArguments=$true)][string[]]$InstallerArgs)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProjectRoot = $PSScriptRoot
$NodeVersion = '24.21.0'
$Network = $env:CODEX_CLOUD_INSTALL_NETWORK
foreach ($item in $InstallerArgs) { if ($item -match '^--network=(.+)$') { $Network = $Matches[1] } }
$CheckOnly = @($InstallerArgs | Where-Object { $_ -in @('--check','--dry-run','--help') }).Count -gt 0
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { throw '需要 64 位 Windows。' }
Write-Host "系统：Windows / $Arch"
$NodeReady = $false
$NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($NodeCommand -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  & $NodeCommand.Source -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1);require("node:sqlite")' 2>$null
  $NodeReady = $LASTEXITCODE -eq 0
}
if ($CheckOnly -and -not $NodeReady) {
  Write-Host '需要安装 Node.js 24 LTS（含 npm）。检查模式未修改服务器。'
  exit 0
}
if (-not $Network -and -not $CheckOnly) {
  $Choice = Read-Host '下载网络：1 中国网络（默认） / 2 海外网络 / 3 自定义'
  $Network = switch ($Choice) { '2' { 'global' } '3' { 'custom' } default { 'cn' } }
}
if ($Network -and $Network -notin @('cn','global','custom')) { throw '网络选项必须是 cn/global/custom' }
$env:CODEX_CLOUD_INSTALL_NETWORK = $Network
if (-not $NodeReady) {
  $Mirror = if ($Network -eq 'cn') { 'https://registry.npmmirror.com/-/binary/node' } else { 'https://nodejs.org/dist' }
  if ($env:CODEX_CLOUD_NODE_MIRROR) { $Mirror = $env:CODEX_CLOUD_NODE_MIRROR }
  elseif ($Network -eq 'custom') { $Mirror = Read-Host 'Node 下载 HTTPS 地址（例如 https://nodejs.org/dist）' }
  if (-not $Mirror.StartsWith('https://')) { throw 'Node 下载源必须使用 HTTPS。' }
  $Runtime = if ($env:CODEX_CLOUD_RUNTIME_DIR) { $env:CODEX_CLOUD_RUNTIME_DIR } else { Join-Path $env:LOCALAPPDATA 'CodexCloud\runtime' }
  $TempDir = Join-Path ([IO.Path]::GetTempPath()) ('codex-cloud-node-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
  $ArchiveName = "node-v$NodeVersion-win-$Arch.zip"
  $Archive = Join-Path $TempDir $ArchiveName
  $Checksums = Join-Path $TempDir 'SHASUMS256.txt'
  try {
    try {
      Invoke-WebRequest "$($Mirror.TrimEnd('/'))/v$NodeVersion/$ArchiveName" -OutFile $Archive -UseBasicParsing
      Invoke-WebRequest "$($Mirror.TrimEnd('/'))/v$NodeVersion/SHASUMS256.txt" -OutFile $Checksums -UseBasicParsing
    } catch {
      Write-Host '下载源不可用，尝试 Node 官方源。'
      Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$ArchiveName" -OutFile $Archive -UseBasicParsing
      Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $Checksums -UseBasicParsing
    }
    $ChecksumLine = Get-Content $Checksums | Where-Object { $_ -match ('\s' + [regex]::Escape($ArchiveName) + '$') } | Select-Object -First 1
    if (-not $ChecksumLine) { throw '下载校验清单缺少 Node 安装包。' }
    $Expected = ($ChecksumLine -split '\s+')[0]
    if ((Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected.ToLowerInvariant()) { throw 'Node 安装包 SHA256 校验失败。' }
    Expand-Archive -LiteralPath $Archive -DestinationPath $TempDir -Force
    New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
    Copy-Item -Path (Join-Path $TempDir "node-v$NodeVersion-win-$Arch\*") -Destination $Runtime -Recurse -Force
    $env:Path = "$Runtime;$env:Path"
  } finally { Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue }
}
$NodeCommand = Get-Command node.exe -ErrorAction Stop
& $NodeCommand.Source (Join-Path $ProjectRoot 'scripts\install\setup.mjs') @InstallerArgs
exit $LASTEXITCODE
