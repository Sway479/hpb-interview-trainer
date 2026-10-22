#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ApkPath,
    [string]$SdkRoot = 'E:/Android',
    [string]$JavaHome = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ApkPath = [IO.Path]::GetFullPath($ApkPath)
if (-not $JavaHome) { $JavaHome = Join-Path $PSScriptRoot 'runtime/jdk21/jdk-21.0.12.1+1' }
$aapt = Join-Path $SdkRoot 'build-tools/36.0.0/aapt2.exe'
$signer = Join-Path $SdkRoot 'build-tools/36.0.0/apksigner.bat'
$previousJava = $env:JAVA_HOME
try {
    $env:JAVA_HOME = [IO.Path]::GetFullPath($JavaHome)
    $signature = (& $signer verify --verbose --print-certs $ApkPath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    $badging = (& $aapt dump badging $ApkPath | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'APK badging inspection failed.' }
    $manifest = (& $aapt dump xmltree --file AndroidManifest.xml $ApkPath | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'APK manifest inspection failed.' }
    $network = (& $aapt dump xmltree --file res/xml/network_security_config.xml $ApkPath | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'APK network policy inspection failed.' }
    $provider = (& $aapt dump xmltree --file res/xml/file_paths.xml $ApkPath | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'APK FileProvider inspection failed.' }
    $archive = [IO.Compression.ZipFile]::OpenRead($ApkPath)
    try {
        $reader = [IO.StreamReader]::new($archive.GetEntry('assets/capacitor.config.json').Open())
        try { $config = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        $noticeNames = @($archive.Entries | Where-Object FullName -like 'assets/third-party-notices/*.LICENSE' | ForEach-Object FullName)
    } finally { $archive.Dispose() }
    $checks = [ordered]@{
        packageAndVersion = $badging -match "name='edu.hpb.interview' versionCode='3' versionName='0.2.1'"
        minSdk24 = $badging -match "minSdkVersion:'24'"
        targetSdk36 = $badging -match "targetSdkVersion:'36'"
        internetPermission = $badging -match "uses-permission: name='android.permission.INTERNET'"
        microphonePermission = $badging -match "uses-permission: name='android.permission.RECORD_AUDIO'"
        audioSettingsPermission = $badging -match "uses-permission: name='android.permission.MODIFY_AUDIO_SETTINGS'"
        automaticBackupDisabled = $manifest -match 'allowBackup[^\r\n]*=false' -and $manifest -match 'fullBackupContent[^\r\n]*=false'
        dataExtractionRulesPresent = $manifest -match 'dataExtractionRules'
        networkBaseDeniesCleartext = $network -match '(?s)E: base-config[^\r\n]*\r?\n\s+A: cleartextTrafficPermitted=false'
        debugLoopbackWhitelist = $network -match "T: 'localhost'" -and $network -match "T: '127.0.0.1'" -and $network -match "T: '::1'" -and ([regex]::Matches($network, 'E: domain \(').Count -eq 3)
        providerOnlyExportCache = $provider -match 'name="hpb_exports"' -and $provider -match 'path="hpb-exports/"' -and ([regex]::Matches($provider, 'E: (?:cache|external|files|root|external-files|external-cache)-path').Count -eq 1)
        nativeLogsDisabled = $config.loggingBehavior -eq 'none'
        webViewHttpsOrigin = $config.server.androidScheme -eq 'https'
        mixedContentDisabled = $config.android.allowMixedContent -eq $false
        nineUpstreamNotices = $noticeNames.Count -eq 9
        signatureV2 = $signature -match 'Verified using v2 scheme \(APK Signature Scheme v2\): true'
    }
    $failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)
    $certificate = [regex]::Match($signature, 'certificate SHA-256 digest: ([0-9a-f]{64})').Groups[1].Value
    $receipt = [ordered]@{
        checkedAtUtc = [DateTime]::UtcNow.ToString('o')
        apk = $ApkPath
        sha256 = (Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureCertificateSha256 = $certificate
        checks = $checks
        allChecksPassed = $failed.Count -eq 0
        runtimeVerified = $false
        notices = $noticeNames
        networkPolicy = $network.Trim()
        fileProviderPolicy = $provider.Trim()
    }
    $receiptPath = [IO.Path]::ChangeExtension($ApkPath, '.inspection.json')
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
    if ($failed.Count) { throw ('APK inspection failed: ' + ($failed -join ', ')) }
    [pscustomobject]@{ receipt = $receiptPath; sha256 = $receipt.sha256; checksPassed = $checks.Count } | ConvertTo-Json
} finally { $env:JAVA_HOME = $previousJava }
