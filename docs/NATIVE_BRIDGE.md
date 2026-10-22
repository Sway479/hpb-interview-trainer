# Android standalone bridge v0.2.0

The standalone application uses the Capacitor 8.5.3 plugin `HpbNative`. The TypeScript entry point is `apps/mobile/src/platform/native-bridge.ts`; native implementation is under `apps/mobile/android/app/src/main/java/edu/hpb/interview`. Registering the plugin and disabling Capacitor logging occur before `BridgeActivity.onCreate` initializes the bridge.

## Reused upstream components

| Component | Version / source | Use and limits |
| --- | --- | --- |
| Capacitor Android | 8.5.3, [official native plugin guide](https://capacitorjs.com/docs/plugins/android) | Promise methods and listener events; native credential entry is write only. Local installed source was checked for `PluginMethod`, `PluginCall`, listener and lifecycle APIs. |
| OkHttp | `com.squareup.okhttp3:okhttp:5.4.0`, [official documentation](https://lysine.dev/okhttp/), [tag parent-5.4.0](https://github.com/lysine-dev/okhttp/tree/parent-5.4.0) | HTTPS and authenticated WebSocket with Android TLS, connection pooling and asynchronous calls. API21+ supports this app's minimum API24. Gradle selects its Android variant. No custom TLS engine, trust bypass, logging interceptor or extra relay service is introduced. |
| Okio | 3.17.0 in OkHttp's [published POM](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp/5.4.0/okhttp-5.4.0.pom), [tag parent-3.17.0](https://github.com/lysine-dev/okio/tree/parent-3.17.0) | OkHttp I/O dependency. |
| Kotlin standard library | 2.1.21 requested by the same POM, [tag v2.1.21](https://github.com/JetBrains/kotlin/tree/v2.1.21) | Runtime dependency; resolved Gradle versions can be higher when another library requires them. |
| Android KeyStore | [official guide](https://developer.android.com/privacy-and-security/keystore) | Device-held AES key, AES-GCM encryption, random nonce and profile ID as authenticated data. Hardware backing depends on the device; no claim of hardware-backed storage is made. |
| Android AtomicFile / AndroidX FileProvider | [AtomicFile API](https://developer.android.com/reference/android/util/AtomicFile), [FileProvider API](https://developer.android.com/reference/androidx/core/content/FileProvider) | Atomic document/metadata/export writes and temporary read-only sharing of generated ZIPs. Audio PCM chunks append on a single storage executor. |

OkHttp and Okio publish their current source under `lysine-dev`; the older Square GitHub URLs redirect there. This was cross-checked against Maven Central SCM metadata and the official project documentation on 2026-10-21. Apache-2.0 license copies for OkHttp, Okio and Kotlin are retained in `apps/mobile/android/upstream-licenses` and copied into APK `assets/third-party-notices` by the build script. They supplement the six existing MIT notices. Original upstream networking code is used through Gradle dependency; application policy and bridge glue are project code.

Version selection was verified against the actual official Android AAR metadata: newer5.5.0 requires `minCompileSdk=37` and fails this SDK36 project's dependency gate; selected5.4.0 declares `minCompileSdk=36`. The app retains SDK36 and AGP8.13.0. The exact selected source commit is `61423f472da24e0ccc42b6a2c0863fb27932fea5` (tag `parent-5.4.0`); local metadata/checksum evidence is saved in `.cache/native-upstream/selection-receipt.json`. Runtime minimum Android API and the AAR's compilation SDK requirement are separate constraints.

## Credentials and network methods

All methods return promises. A failure returns a fixed public message and code; exception text, request headers, request URL and stored keys are not passed into a rejection or Android log. The app source config sets `loggingBehavior: 'none'`; `MainActivity` independently enforces disabled Capacitor logging and mixed content. The debug APK still permits WebView developer inspection for testing and is not a production security boundary against someone controlling the device.

| Method | Contract |
| --- | --- |
| `saveCredential({id,key,origins})` | Encrypts the key and origin list together in private SharedPreferences using an AndroidKeyStore AES-256-GCM key. The plaintext key is accepted for this write and never returned. Replacing a profile cancels its active requests and sockets. |
| `credentialStatus({ids})` | Returns only `{entries:[{id,hasKey}]}`. Missing or unreadable encrypted credentials report `hasKey:false`. |
| `deleteCredential({id})` | Deletes that encrypted profile entry and cancels its network operations. |
| `http({profileId,url,body,timeoutMs?})` | POST JSON with a string body and native `Authorization: Bearer` header. Returns `{status,body:string}`. Default timeout60s, accepted range100ms–120s. Redirects and automatic connection retry are disabled. |
| `openSocket({id,profileId,url})` | Queues an authenticated WebSocket connection. Active IDs must be unique. The promise means connection setup was queued; `socketEvent.type='open'` confirms the handshake. |
| `sendSocket({id,data})` / `closeSocket({id})` | JSON text sends and closes are serialized in invocation order. Local close uses1000 and cancels remaining resources after3s if no close callback arrives. |
| `addListener('socketEvent', listener)` | Returns a promise of `{remove():Promise<void>}`. Events contain `{id,type:'open'|'message'|'error'|'close',data?,message?,code?}`. Binary protocols are rejected; Qwen/OpenAI realtime JSON messages are text. |

Native WebSocket failures additionally carry safe optional fields: `failureKind` (`timeout`, `authentication`, `tls`, `network`, `handshake`), `stage` (`handshake`, `connected`), `errorType` (exception simple class name restricted to letters/digits), `httpStatus` (100–599 only), `timeoutKind` (`pong` or `io`), `elapsedMs` and `pingIntervalMs`. The display message is a fixed Chinese classification. Raw throwable messages, URLs and headers remain private. See [NATIVE_WEBSOCKET_DIAGNOSTICS.md](./NATIVE_WEBSOCKET_DIAGNOSTICS.md) for the source audit and interpretation boundary.

Origins are exact normalized `scheme://host[:port]` values; the standard port is omitted, host comparison is case insensitive, and `wss` maps to `https` (`ws` maps to `http`). Origins cannot contain credentials, a query, fragment or non-root path. Every network target must match a stored authorized origin before the key is used. HTTPS/WSS are accepted. A debug build accepts HTTP/WS only for literal `localhost`, `127.0.0.1` or `::1`, intended for a local fixture reached through `adb reverse`. LAN addresses and emulator-host alias `10.0.2.2` are not cleartext exceptions. The release network XML permits no cleartext. Redirect responses are returned without following them.

HTTP bodies/responses are bounded to16MiB; WebSocket text messages to3MiB characters. Exact stored key values, JSON-escaped values and URL-encoded values are redacted from returned response bodies/messages if a remote endpoint echoes them. The bridge supplies no method to reveal stored credentials. A hostile provider can still receive the key explicitly authorized for its origin, so the user must configure trusted API endpoints.

## Private documents, recordings and export

`readData`, `writeData`, `listData`, `deleteData` address only relative paths under private `files/hpb/data`. Canonical containment is checked. Absolute paths, backslashes, colons, traversal components, control characters and AtomicFile `.bak` / `.new` companion names are rejected. `listData` returns sorted file paths relative to the data root. `deleteData` rejects directories. Text is UTF-8 and a single document is bounded to16MiB. There is no bridge access to SharedPreferences or AndroidKeyStore files.

Audio occupies a separate private `files/hpb/audio/<sessionId>/` directory. IDs use letters, digits, dot, underscore and hyphen; role is `learner` or `patient`. `appendAudio` accepts base64 mono PCM16LE chunks and `sampleRate`; omitted rates default to16000 for learner and24000 for patient. Each stream has atomic format/rate metadata. A changed sample rate within one existing stream is rejected. Chunks and storage operations run serially to retain order. Two role streams are separate recordings; a shared wall-clock, mixed stereo recording and precise cross-role time alignment are not claimed.

`readAudio` returns `{exists,audio,sampleRate?}`, where `audio` is a complete RIFF/WAVE file encoded in base64. Bridge playback reads are limited to32MiB; longer streams can still be exported using native streaming ZIP. `deleteAudio({sessionId})` deletes only the two recognized role PCM/metadata files and the exact session directory if empty.

`exportPackage` validates each supplied text ZIP entry, prevents duplicate entries and path traversal, and writes to private cache `hpb-exports` with AtomicFile. It streams recording PCM into `audio/<sessionId>/<role>.wav` using the recorded sample rate and a standard44-byte PCM16 mono WAV header. It does not load all recording bytes into JavaScript or native heap. The reserved `recordings-manifest.json` lists each requested session and both roles as `included`, `missing`, or `not_requested`; missing recordings are not synthesized. The result includes `{uri,fileName,bytes,recordingFiles,missingAudio}`. A malformed existing recording/metadata file makes export fail, rather than labeling it a valid WAV.

The ZIP URI is supplied by this app's FileProvider. Its only configured root is `cache/hpb-exports/`; the provider is not exported and no external-storage root is exposed. `sharePackage` validates the exact provider authority, generated file path and display-name URI, then launches Android's share sheet with temporary read permission. Resolution confirms the share sheet launched; it is not proof that another app saved or sent the package. Exported ZIPs are unencrypted and may contain the selected research records and audio; the app's export choice controls inclusion. Cache files can be reclaimed by Android, so a returned cache URI is not a durable external backup until the user saves it through a receiving app.

`allowBackup=false`, `fullBackupContent=false` and Android12+ data extraction exclusions prevent automatic cloud backup/device transfer of private credentials and local research data under this app's declared backup configuration. Reinstallation or device loss can remove local data; user-initiated ZIP/JSON export remains necessary.

## Verification boundary

The native Java/resource compile and eight local JVM origin-policy tests passed on2026-10-21. These tests cover exact host/port authorization, lookalike/subdomain/userinfo rejection, protocol separation, loopback exceptions, LAN denial, invalid ports and encoded authority. They make no network calls and do not exercise AndroidKeyStore, file I/O, Android sharesheets or real provider behavior. A later integration APK build compiles any subsequent source changes again.

Native source implementation, dependency resolution/compilation, package inspection, mocked local networking, actual provider networking and physical-device acoustics are distinct checks. Only a runtime receipt establishes which were exercised for a particular APK hash. Emulator voice capability does not establish physical speaker echo control, Bluetooth routing, background recovery, credential hardware backing, educational validity or clinical efficacy.
