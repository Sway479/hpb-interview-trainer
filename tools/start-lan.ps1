param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$pairBytes=[byte[]]::new(12)
$pairGenerator=[Security.Cryptography.RandomNumberGenerator]::Create()
$pairGenerator.GetBytes($pairBytes)
$pairGenerator.Dispose()
$previousPairingToken=$env:APP_ACCESS_TOKEN
$previousBindAddress=$env:HOST
$env:APP_ACCESS_TOKEN=([BitConverter]::ToString($pairBytes)).Replace('-','').ToLowerInvariant()
$env:HOST='0.0.0.0'
Write-Host '手机和电脑需连接同一Wi-Fi。安卓连接设置中填写以下地址之一及配对码：'
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
    ForEach-Object { Write-Host ('服务地址：http://' + $_.IPAddress + ':8787') }
Write-Host ('配对码：' + $env:APP_ACCESS_TOKEN)
try { & (Join-Path $PSScriptRoot 'start.ps1') -SkipBuild:$SkipBuild }
finally {
    if ($null -eq $previousPairingToken) { Remove-Item Env:APP_ACCESS_TOKEN -ErrorAction SilentlyContinue } else { $env:APP_ACCESS_TOKEN=$previousPairingToken }
    if ($null -eq $previousBindAddress) { Remove-Item Env:HOST -ErrorAction SilentlyContinue } else { $env:HOST=$previousBindAddress }
}
