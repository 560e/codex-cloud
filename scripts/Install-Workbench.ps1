param(
  [Parameter(Mandatory=$true)][string]$PublicOrigin,
  [string]$CodexBin = '',
  [string]$TlsCert = '',
  [string]$TlsKey = ''
)
$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspaceDir
$uri = [uri]$PublicOrigin
if ($uri.Scheme -ne 'https') { throw '生产部署请提供 https://域名或IP:18473' }
if ($uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'PublicOrigin 只能包含协议、主机和端口' }
if ([int](node -p 'parseInt(process.versions.node)') -lt 24) { throw '需要 Node.js 24 或更新的 LTS 版本' }
if (Test-Path -LiteralPath '.env') { Write-Host '保留现有 .env；请核对 PUBLIC_ORIGIN 和证书路径。' }
else {
  $originValue = $uri.GetLeftPart([System.UriPartial]::Authority)
  $values = @{ PUBLIC_ORIGIN = $originValue }
  foreach ($entry in @(@('CODEX_BIN',$CodexBin),@('CADDY_TLS_CERT',$TlsCert),@('CADDY_TLS_KEY',$TlsKey))) {
    if ($entry[1]) { $value = $entry[1].Replace('\','/'); if ($value.Contains('"') -or $value.Contains("`n")) { throw '配置值含非法字符' }; $values[$entry[0]] = "`"$value`"" }
  }
  # Keep the template's per-variable explanations in the generated .env.
  $configLines = foreach ($line in Get-Content -LiteralPath '.env.example' -Encoding UTF8) {
    if ($line -match '^(?:#\s*)?([A-Z_]+)=' -and $values.ContainsKey($Matches[1])) {
      "$($Matches[1])=$($values[$Matches[1]])"
    } else { $line }
  }
  [System.IO.File]::WriteAllLines((Join-Path $workspaceDir '.env'), $configLines, [System.Text.UTF8Encoding]::new($false))
}
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
& npm.cmd run password
if ($LASTEXITCODE -ne 0) { throw '设置密码失败' }
& npm.cmd run doctor
if ($LASTEXITCODE -ne 0) { throw 'Codex 诊断未通过，请修复后继续' }
Write-Host '安装完成。请配置 Caddy 和证书，再运行 scripts/Start-Workbench.ps1。'
