param([string]$CaddyBin = 'caddy.exe')
$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspaceDir
if (-not (Test-Path -LiteralPath 'dist/server/index.js')) { throw '请先运行 npm run build' }
$envData = & node 'scripts/deploy-config.mjs'
if ($LASTEXITCODE -ne 0) { throw '读取 .env 失败' }
$settings = $envData | ConvertFrom-Json
if (-not $settings.origin -or -not $settings.cert -or -not $settings.key) { throw '请配置 PUBLIC_ORIGIN、CADDY_TLS_CERT、CADDY_TLS_KEY' }
if (-not (Test-Path -LiteralPath $settings.cert) -or -not (Test-Path -LiteralPath $settings.key)) { throw 'TLS 证书或私钥不存在' }
$env:WORKBENCH_ADDRESS = $settings.origin
$env:WORKBENCH_TLS_CERT = [System.IO.Path]::GetFullPath($settings.cert)
$env:WORKBENCH_TLS_KEY = [System.IO.Path]::GetFullPath($settings.key)
$env:WORKBENCH_BACKEND = "127.0.0.1:$($settings.port)"
$caddyPath = (Get-Command $CaddyBin -ErrorAction Stop).Source
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
& $caddyPath validate --config 'deploy/Caddyfile' --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddy 配置无效' }
$logDir = Join-Path ([System.IO.Path]::GetFullPath($settings.data)) 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$nodeProcess = $null
try {
  $nodeProcess = Start-Process -FilePath $nodePath -ArgumentList @('scripts/run-service.mjs', ('"' + $caddyPath + '"'), ('"' + $logDir + '"')) -WorkingDirectory $workspaceDir -WindowStyle Hidden -PassThru
  Write-Host "工作台已启动：$($settings.origin)"
  while (-not $nodeProcess.HasExited) { Start-Sleep -Seconds 2 }
  throw '后端或 Caddy 已退出。请查看 data/logs，计划任务将按配置重启服务。'
}
finally {
  foreach ($ownedProcess in @($nodeProcess)) {
    if ($ownedProcess -and -not $ownedProcess.HasExited) { & taskkill.exe /PID $ownedProcess.Id /T /F | Out-Null }
  }
}
