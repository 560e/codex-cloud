param([string]$TaskName = 'CodexPrivateWorkbench', [string]$CaddyBin = 'caddy.exe')
$ErrorActionPreference = 'Stop'
$workspaceDir = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot 'Start-Workbench.ps1'
$caddyPath = (Get-Command $CaddyBin -ErrorAction Stop).Source
$credential = Get-Credential -UserName ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -Message '使用已安装并登录 Codex 的 Windows 账户；用于开机后未登录桌面时运行'
if (-not $credential) { throw '已取消' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -CaddyBin `"$caddyPath`"" -WorkingDirectory $workspaceDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$plainPassword = $credential.GetNetworkCredential().Password
try { Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -User $credential.UserName -Password $plainPassword -Force | Out-Null }
finally { $plainPassword = $null }
Write-Host "已注册 $TaskName。用 Start-ScheduledTask -TaskName '$TaskName' 启动。"
Write-Host '不要同时手动运行另一个实例。开机后请验证 Codex 登录、模型连接及项目工具链。'
