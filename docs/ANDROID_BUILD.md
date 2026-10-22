# Android standalone v0.2 debug build on Windows

## Toolchain

The generated Capacitor 8.5.3 project retains upstream `compileSdk=36`, `targetSdk=36`, minimum API24, AGP 8.13.0 and Gradle 8.14.3. Do not downgrade these values to work around missing downloads.

Build Tools 36.0.0 is explicitly applied to the app and Capacitor library modules. An initial preflight exposed AGP's implicit Build Tools 35.0.0 request; the final build uses the installed 36.0.0 toolchain. This does not change compile/target SDK.

Verified local tools:

- SDK: `E:\Android`, platform `android-36` revision 2 and build tools `36.0.0`.
- JDK21: `tools/runtime/jdk21/jdk-21.0.12.1+1` (the build script also accepts `-JavaHome`).
- Existing `android-30` / build tools `30.0.3` are retained.
- Gradle user home: project `.cache/gradle`, not a new cache on the system drive.
- Gradle ZIP SHA-256: `ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c`, from [the official checksum](https://services.gradle.org/distributions/gradle-8.14.3-all.zip.sha256).

## Build

Run from this project's root:

```powershell
pwsh -ExecutionPolicy Bypass -File .\tools\build-android.ps1
```

The script requires PowerShell 7, builds the web application, runs Capacitor sync, builds `:app:assembleDebug`, verifies the packaged web assets against the current Vite bundle, copies the version0.2.0/code2 APK to `artifacts/android/hpb-voice-standalone-debug.apk`, and writes `standalone-build-receipt.json`. It reads no provider credential. The earlier version0.1 prototype artifact is preserved under its previous name. After a failed frontend build, fix that failure before packaging; do not use an earlier `dist` as final acceptance evidence.

During iteration, `-Preliminary` creates a separately named preliminary APK and receipt. The default build receipt describes a candidate artifact; runtime acceptance remains a separate check.

The build verifies packaged notices from both root `licenses` and Android `upstream-licenses` (six existing MIT notices plus Apache-2.0 notices for OkHttp, Okio and Kotlin) and writes `hpb-voice-standalone-debug.web-assets.sha256`. Its records are sorted by relative asset path, encoded as UTF-8 without BOM with LF line endings, in the form `sha256  relative/path`. The standalone build receipt records the SHA-256 of this complete manifest as `webAssetManifestSha256`.

If the web bundle and sync were already verified, the optional `-SkipWebBuild` and `-SkipSync` switches allow a targeted native build. They must not be used to conceal an unbuilt frontend.

Inspect the resulting package separately:

```powershell
pwsh -ExecutionPolicy Bypass -File .\tools\inspect-android.ps1 -ApkPath .\artifacts\android\hpb-voice-standalone-debug.apk
```

This verifies the APK signature, package/version/SDK values, required permissions, disabled backup, restricted network/FileProvider policies, bundled Capacitor logging/mixed-content settings and notice count. It writes a sibling `.inspection.json` tied to the APK SHA-256. It does not install the application or make a provider request; runtime results remain separate.

## Direct API networking and local fixtures

The v0.2 app configures provider profiles on the phone and calls their HTTPS/WSS endpoints using the native `HpbNative` bridge. Provider keys are kept in encrypted native storage and injected into native requests. A Windows gateway is not required for standalone operation. The old v0.1 gateway workflow is no longer this Android application's default path.

| Local test path | Fixture URL example | Setup |
| --- | --- | --- |
| Debug emulator or USB device through adb reverse | `http://127.0.0.1:8787` | Start a local mock fixture and run `E:\Android\platform-tools\adb.exe reverse tcp:8787 tcp:8787`. Authorize that exact test origin in the temporary test profile. |
| Real provider | `https://<provider-host>/...` / `wss://<provider-host>/...` | Configure the provider URL, model and key on the phone; the native origin allowlist applies. |

The port must match the fixture. On Android, `localhost` without `adb reverse` refers to the device itself. Debug cleartext exceptions are restricted to literal `localhost`, `127.0.0.1` and `::1`; `10.0.2.2` and LAN cleartext URLs are rejected.

## Permissions and network policy

The main manifest includes `INTERNET`, `RECORD_AUDIO`, and `MODIFY_AUDIO_SETTINGS`. Capacitor's existing `BridgeWebChromeClient.onPermissionRequest` requests microphone permission when browser `getUserMedia` needs it. This app does not replace that bridge with unconditional custom permission grants.

Debug builds overlay a network security XML file with loopback-only cleartext exceptions for local test fixtures. The default/release XML disables cleartext. The native bridge also checks the transport and exact authorized origin before using a credential, disables redirects and uses Android's normal TLS trust. The bundled WebView retains its secure Capacitor origin for browser audio APIs; native provider transport is a separate connection. `MainActivity` disables mixed content and Capacitor logging before bridge initialization. Automatic backup/device transfer of app-private data is excluded.

[Android network security configuration](https://developer.android.com/privacy-and-security/security-config) documents the cleartext opt-in and build configuration mechanism.

See [NATIVE_BRIDGE.md](./NATIVE_BRIDGE.md) for method contracts, private storage, streaming WAV/ZIP export, source licenses and limitations.

## Verification limits

### WebView syntax compatibility

The available API30 emulator reports Android System WebView `83.0.4103.106`. An initial frontend build targeting Chrome100 failed at JavaScript parsing (`Unexpected token '='`, logical assignment syntax). The frontend build target was adjusted to Chrome83 and `Array.at` use was removed; Android compile/target SDK remains36. Any APK built before this compatibility correction is a preliminary build and must not be described as a working Android application. The candidate APK must include the corrected current bundle and pass the emulator's actual startup check. A minimum Android API level alone does not establish JavaScript or audio API compatibility.

### What the build confirms

An APK hash proves artifact identity. A Gradle success proves native compilation/packaging. Neither proves microphone capture, audible PCM playback, echo cancellation, Bluetooth routing, recovery from interruptions, educational benefit, or clinical correctness. Record real Android voice checks separately from the build receipt.
