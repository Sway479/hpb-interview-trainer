#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$SdkRoot = 'E:\Android',
    [string]$JavaHome = '',
    [switch]$SkipWebBuild,
    [switch]$SkipSync,
    [switch]$Preliminary
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$mobileRoot = Join-Path $projectRoot 'apps\mobile'
$androidRoot = Join-Path $mobileRoot 'android'
$gradleCache = Join-Path $projectRoot '.cache\gradle'
$artifactRoot = Join-Path $projectRoot 'artifacts\android'
if ([string]::IsNullOrWhiteSpace($JavaHome)) {
    $JavaHome = Join-Path $PSScriptRoot 'runtime\jdk21\jdk-21.0.12.1+1'
}
$JavaHome = [IO.Path]::GetFullPath($JavaHome)
$SdkRoot = [IO.Path]::GetFullPath($SdkRoot)
$requiredFiles = @(
    (Join-Path $JavaHome 'bin\java.exe'),
    (Join-Path $SdkRoot 'platforms\android-36\android.jar'),
    (Join-Path $SdkRoot 'build-tools\36.0.0\aapt2.exe'),
    (Join-Path $androidRoot 'gradlew.bat')
)
foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required build file missing: $requiredFile. Install JDK21 and SDK platform android-36/build-tools 36.0.0; keep the Capacitor 8 SDK defaults."
    }
}
New-Item -ItemType Directory -Path $gradleCache, $artifactRoot -Force | Out-Null
$previousEnv = @{}
foreach ($envName in @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_USER_HOME')) {
    $previousEnv[$envName] = [Environment]::GetEnvironmentVariable($envName, 'Process')
}
try {
    $env:JAVA_HOME = $JavaHome
    $env:ANDROID_HOME = $SdkRoot
    $env:ANDROID_SDK_ROOT = $SdkRoot
    $env:GRADLE_USER_HOME = $gradleCache
    $sdkProperty = $SdkRoot.Replace('\', '/')
    Set-Content -LiteralPath (Join-Path $androidRoot 'local.properties') -Value "sdk.dir=$sdkProperty" -Encoding utf8
    Push-Location $projectRoot
    try {
        if (-not $SkipWebBuild) {
            & npm.cmd run build --workspace '@hpb/mobile'
            if ($LASTEXITCODE -ne 0) { throw "Mobile web build failed ($LASTEXITCODE)." }
        }
    } finally { Pop-Location }
    Push-Location $mobileRoot
    try {
        if (-not $SkipSync) {
            & npx.cmd --no-install cap sync android
            if ($LASTEXITCODE -ne 0) { throw "Capacitor Android sync failed ($LASTEXITCODE)." }
        }
    } finally { Pop-Location }
    $noticeRoot = Join-Path $androidRoot 'app\src\main\assets\third-party-notices'
    New-Item -ItemType Directory -Path $noticeRoot -Force | Out-Null
    $noticeFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'licenses') -Filter '*.LICENSE' -File) +
        @(Get-ChildItem -LiteralPath (Join-Path $androidRoot 'upstream-licenses') -Filter '*.LICENSE' -File)
    if ($noticeFiles.Count -eq 0) { throw 'Upstream license notices are missing.' }
    foreach ($noticeFile in $noticeFiles) {
        Copy-Item -LiteralPath $noticeFile.FullName -Destination (Join-Path $noticeRoot $noticeFile.Name) -Force
    }
    Push-Location $androidRoot
    try {
        & .\gradlew.bat --gradle-user-home $gradleCache --no-daemon --console=plain :app:assembleDebug
        if ($LASTEXITCODE -ne 0) { throw "Android debug build failed ($LASTEXITCODE)." }
    } finally { Pop-Location }
    $sourceApk = Join-Path $androidRoot 'app\build\outputs\apk\debug\app-debug.apk'
    $artifactBase = if ($Preliminary) { 'hpb-voice-standalone-preliminary-debug' } else { 'hpb-voice-standalone-debug' }
    $outputApk = Join-Path $artifactRoot "$artifactBase.apk"
    $webRoot = Join-Path $mobileRoot 'dist'
    $webAssets = @()
    $noticeAssets = @()
    $apkArchive = [IO.Compression.ZipFile]::OpenRead($sourceApk)
    try {
        foreach ($webFile in (Get-ChildItem -LiteralPath $webRoot -File -Recurse)) {
            $assetPath = [IO.Path]::GetRelativePath($webRoot, $webFile.FullName).Replace('\', '/')
            $entry = $apkArchive.GetEntry("assets/public/$assetPath")
            if ($null -eq $entry) { throw "Current web asset missing from APK: $assetPath" }
            $expectedHash = (Get-FileHash -LiteralPath $webFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            $assetStream = $entry.Open()
            $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
            try {
                $packagedHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($assetStream)).Replace('-', '').ToLowerInvariant()
            } finally {
                $assetStream.Dispose()
                $hashAlgorithm.Dispose()
            }
            if ($expectedHash -ne $packagedHash) { throw "APK contains a different web asset: $assetPath" }
            $webAssets += [ordered]@{ path = $assetPath; sha256 = $packagedHash; bytes = $webFile.Length }
        }
        if ($webAssets.Count -eq 0) { throw 'No built web assets found to verify in the APK.' }
        foreach ($noticeFile in $noticeFiles) {
            $noticePath = "third-party-notices/$($noticeFile.Name)"
            $entry = $apkArchive.GetEntry("assets/$noticePath")
            if ($null -eq $entry) { throw "Upstream notice missing from APK: $noticePath" }
            $expectedHash = (Get-FileHash -LiteralPath $noticeFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            $noticeStream = $entry.Open()
            $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
            try {
                $packagedHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($noticeStream)).Replace('-', '').ToLowerInvariant()
            } finally {
                $noticeStream.Dispose()
                $hashAlgorithm.Dispose()
            }
            if ($expectedHash -ne $packagedHash) { throw "APK contains a different upstream notice: $noticePath" }
            $noticeAssets += [ordered]@{ path = $noticePath; sha256 = $packagedHash }
        }
    } finally { $apkArchive.Dispose() }
    Copy-Item -LiteralPath $sourceApk -Destination $outputApk -Force
    $apkFile = Get-Item -LiteralPath $outputApk
    $webAssets = @($webAssets | Sort-Object { $_.path })
    $webManifestPath = Join-Path $artifactRoot "$artifactBase.web-assets.sha256"
    $webManifestText = (($webAssets | ForEach-Object { "$($_.sha256)  $($_.path)" }) -join "`n") + "`n"
    [IO.File]::WriteAllText($webManifestPath, $webManifestText, [Text.UTF8Encoding]::new($false))
    $receipt = [ordered]@{
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        apk = $apkFile.FullName
        bytes = $apkFile.Length
        sha256 = (Get-FileHash -LiteralPath $outputApk -Algorithm SHA256).Hash.ToLowerInvariant()
        packageId = 'edu.hpb.interview'
        variant = 'debug'
        stage = if ($Preliminary) { 'preliminary' } else { 'candidate' }
        versionName = '0.2.0'
        versionCode = 2
        sdkRoot = $SdkRoot
        compileSdk = 36
        buildTools = '36.0.0'
        javaHome = $JavaHome
        gradleUserHome = $gradleCache
        deviceVoiceVerified = $false
        packagedWebAssetsVerified = $true
        webAssetManifest = $webManifestPath
        webAssetManifestSha256 = (Get-FileHash -LiteralPath $webManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        webAssets = $webAssets
        packagedUpstreamNoticesVerified = $true
        upstreamNotices = $noticeAssets
    }
    $receiptName = if ($Preliminary) { 'standalone-preliminary-build-receipt.json' } else { 'standalone-build-receipt.json' }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $artifactRoot $receiptName) -Encoding utf8
    Write-Host "APK: $outputApk"
    Write-Host "SHA256: $($receipt.sha256)"
} finally {
    foreach ($envName in $previousEnv.Keys) {
        [Environment]::SetEnvironmentVariable($envName, $previousEnv[$envName], 'Process')
    }
}
