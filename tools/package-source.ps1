param([string]$OutputPath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    if (-not $OutputPath) { $OutputPath=Join-Path $projectRoot 'artifacts/hpb-voice-standalone-source-v0.2.0.zip' }
    $OutputPath=[IO.Path]::GetFullPath($OutputPath)
    if (Test-Path -LiteralPath $OutputPath) { throw '输出包已经存在；请指定一个新的OutputPath，保留旧版本。' }
    $stageRoot=Join-Path $projectRoot ('.cache/delivery/source-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    $candidatePaths=& git -c core.quotepath=false ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw '无法读取Git文件清单。' }
    $fileCount=0
    foreach ($relativePath in $candidatePaths) {
        $normalPath=$relativePath.Replace('\','/')
        $fileName=[IO.Path]::GetFileName($relativePath)
        if ($normalPath.StartsWith('artifacts/',[StringComparison]::OrdinalIgnoreCase) -or
            ($fileName -match '^\.env($|\.)' -and $fileName -ine '.env.example')) { continue }
        $sourcePath=[IO.Path]::GetFullPath((Join-Path $projectRoot $relativePath))
        if (-not $sourcePath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '源码路径超出项目范围。' }
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
        $targetPath=Join-Path $stageRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath
        $fileCount++
    }
    if (Test-Path -LiteralPath $OutputPath) { throw '输出包已经存在；请指定一个新的OutputPath，保留旧版本。' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stageRoot,$OutputPath,[IO.Compression.CompressionLevel]::Optimal,$false)
    [pscustomobject]@{path=$OutputPath;files=$fileCount;bytes=(Get-Item -LiteralPath $OutputPath).Length;sha256=(Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json
} finally { Pop-Location }
