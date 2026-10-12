param(
  [ValidateSet('Extract','Register')][string]$Action,
  [string]$Archive, [string]$Destination,
  [string]$Node, [string]$Prefix, [string]$Data,
  [string]$Nginx, [string]$NginxConfig, [string]$NginxPrefix,
  [string]$AcmeConfig
)
$ErrorActionPreference = 'Stop'
if ($Action -eq 'Extract') {
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
  exit 0
}
$Config = @{ prefix=$Prefix; node=$Node; data=$Data; nginx=$Nginx; nginxConfig=$NginxConfig; nginxPrefix=$NginxPrefix; runtimePath=$env:Path }
$ConfigFile = Join-Path $Data 'windows-service.json'
[IO.File]::WriteAllText($ConfigFile, ($Config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$Account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$Credential = Get-Credential -UserName $Account -Message '后台任务使用此 Windows 账户；输入系统账户密码以支持未登录桌面时运行（不是工作台密码）'
if (-not $Credential) { throw '已取消后台任务配置，可使用 --no-service 手动运行。' }
$Arguments = '"' + (Join-Path $Prefix 'scripts\install\windows-service.mjs') + '" "' + $ConfigFile + '"'
$TaskAction = New-ScheduledTaskAction -Execute $Node -Argument $Arguments -WorkingDirectory $Prefix
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$Password = $Credential.GetNetworkCredential().Password
try {
  Register-ScheduledTask -TaskName 'CodexCloud' -Action $TaskAction -Trigger $Trigger -Settings $Settings -User $Credential.UserName -Password $Password -Force | Out-Null
  Start-ScheduledTask -TaskName 'CodexCloud'
  if ($AcmeConfig) {
    $RenewArgs = '"' + (Join-Path $Prefix 'scripts\install\acme.mjs') + '" "' + $AcmeConfig + '"'
    $RenewAction = New-ScheduledTaskAction -Execute $Node -Argument $RenewArgs -WorkingDirectory $Prefix
    $RenewTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
    Register-ScheduledTask -TaskName 'CodexCloudCertificate' -Action $RenewAction -Trigger $RenewTrigger -Settings $Settings -User $Credential.UserName -Password $Password -Force | Out-Null
  }
} finally { $Password = $null; $Credential = $null }
Write-Host '已注册 CodexCloud 后台任务。查看状态：Get-ScheduledTask -TaskName CodexCloud'
