param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $env:npm_config_cache=Join-Path $projectRoot '.cache/npm'
    if (-not (Test-Path -LiteralPath '.env')) { throw '缺少本地.env配置。请参考.env.example在本机配置API Key。' }
    if (-not (Test-Path -LiteralPath 'node_modules/tsx')) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
    }
    if (-not $SkipBuild -or -not (Test-Path -LiteralPath 'apps/mobile/dist/index.html')) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw '界面构建失败。' }
    }
    Write-Host '浏览器预览：http://127.0.0.1:8787；在此窗口按Ctrl+C停止。'
    & npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw '服务未能启动。若端口已占用，请先检查已有服务窗口。' }
} finally { Pop-Location }
