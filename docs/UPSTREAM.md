# Upstream software and reuse contract

Verified on 2026-10-21. This application integrates existing open source UI, native packaging, and PCM audio code. The clinical training workflow is project specific.

## Fixed sources

| Component | Source and fixed revision | Reused capability | License and retained notice |
| --- | --- | --- | --- |
| Ionic official React Vite starter | [ionic-team/starters](https://github.com/ionic-team/starters/tree/15aee8b93f46b48e4db7464bceb4b0560ea5dc35/react-vite/base), commit `15aee8b93f46b48e4db7464bceb4b0560ea5dc35` | `react-vite/base` application structure, React/Vite setup, Ionic CSS and component conventions | MIT; `licenses/ionic-starters.LICENSE` |
| Ionic React | [ionic-team/ionic-framework](https://github.com/ionic-team/ionic-framework/tree/a974f6b72637217b0416bfc5c4dbc97a121ed40f), npm `@ionic/react@9.0.8` | Mobile page, content, navigation, input and feedback components | MIT; installed Ionic core notice retained as `licenses/ionic-framework.LICENSE` |
| Capacitor | [ionic-team/capacitor 8.5.3](https://github.com/ionic-team/capacitor/tree/06e3e1984337f836a4c28b2afc92faa977dea315), commit `06e3e1984337f836a4c28b2afc92faa977dea315` | Android native project/template, WebView bridge, Android WebChrome microphone permission flow, packaging | MIT; `licenses/capacitor.LICENSE` |
| wavtools | [keithwhor/wavtools](https://github.com/keithwhor/wavtools/tree/1fd282f1e3d10f45d6fb7ba73d7a917c23dcb04b), npm `wavtools@0.1.5`, commit `1fd282f1e3d10f45d6fb7ba73d7a917c23dcb04b` | `WavRecorder`, `WavStreamPlayer`, their existing audio and stream AudioWorklets | MIT, Copyright 2024 Keith Horwood / OpenAI; `licenses/wavtools.LICENSE` |
| React | npm `react@19.0.0` and `react-dom@19.0.0` | Component runtime | MIT; `licenses/react.LICENSE` |
| Ionicons | [ionic-team/ionicons](https://github.com/ionic-team/ionicons), npm `ionicons@8.1.0` | Ionic icon assets/components | MIT; `licenses/ionicons.LICENSE` |

The exact npm tarball versions and integrity values are recorded in `package-lock.json`. The wavtools npm metadata reports the same `gitHead` as the GitHub revision above. Its npm tarball integrity is `sha512-npKxMSOKMLItDk5jTZ2W/sfXOIVbv0/UId1C96Zhtm7UgmKBS4WjliK7qWpKniQvNIMH2URoRANDBMWHAyGAlg==`. Capacitor 8.5.3 was released on 2026-10-07 according to the [official release](https://github.com/ionic-team/capacitor/releases/tag/8.5.3).

The build script includes these six MIT notices plus the OkHttp, Okio and Kotlin Apache-2.0 notices (nine in total) in APK `assets/third-party-notices/` and verifies their hashes against the source notice files before issuing a receipt.

## Reuse contract

- **Mode:** `generalize` / integration. This is a new training application using upstream components. It does not reproduce a published medical education intervention.
- **Source artifact:** the fixed official starter and the npm packages above. `.cache/ionic-starters` is a local checkout for source inspection; dependencies are restored from the lockfile.
- **Preserved:** upstream recording, PCM16 conversion, stream queuing/interruption, native bridge and native permission implementation. No alternative recorder or player is described as upstream code.
- **Allowed changes:** application screens, case/session domain logic, server protocol adapter, gateway URL configuration, native microphone permissions, debug network configuration, build tooling and logging.
- **Acceptance oracle:** package versions resolve to the pinned sources; browser code imports the existing `WavRecorder` / `WavStreamPlayer`; Android debug build packages the actual frontend; APK manifest includes microphone permission; runtime microphone and playback must be verified separately on a device.
- **Claim boundary:** a locally buildable prototype and a tested model gateway establish engineering feasibility. They do not establish teaching efficacy, scoring validity, production security, Android audio quality, or clinical accuracy.
- **Current verdict:** `conditional_pass` until the resulting APK passes Android microphone/playback, interruption, reconnect and teacher review acceptance checks.

## Artifact manifest and lineage

| Path | Role | Required | Producer | Consumer | Status / identity | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `.cache/ionic-starters/react-vite/base` | Upstream source reference | Yes for provenance | Ionic | Application scaffolding | Commit `15aee8b93f46b48e4db7464bceb4b0560ea5dc35` | Cache may be restored from the fixed source. |
| `package-lock.json` | Dependency identity | Yes | npm install | npm ci / build | Versions plus tarball integrity | Inspectable restore contract. |
| `node_modules/wavtools/lib/` | Execution-critical audio implementation | Yes | wavtools 0.1.5 | Mobile audio wrapper | Hashes below | No rewritten PCM/worklet algorithm. |
| `apps/mobile/android/` | Native packaging source | Yes | Capacitor template plus project configuration | Gradle | Capacitor 8.5.3 | Permission/network changes listed below. |
| `apps/mobile/dist/` | Generated web application | Yes at package time | Vite | Capacitor sync | Generated from current application source | Never use a placeholder as final APK acceptance. |
| `licenses/` | Distribution notices | Yes | Upstream license files | Review / distribution | Local retained copies | Keep notices with substantial upstream software. |
| `artifacts/android/build-receipt.json` | Packaging QA output | After build | Build script | Artifact reviewer | APK SHA-256 / size | Does not prove runtime audio or teaching efficacy. |

Lineage: fixed starter + locked packages → application screens/audio wrapper → current Vite bundle → Capacitor assets/native bridge → Gradle debug APK → package checks → separate Android runtime acceptance. The case/session kernel and Qwen adapter are domain/protocol additions, not upstream clinical algorithms. Build receipts are QA outputs and do not feed case scoring.

## Audio source inspection

wavtools is a small browser library descended from OpenAI Realtime Console. It is useful existing audio code; it is not a maintained Android native audio SDK. The inspected source uses `navigator.mediaDevices.getUserMedia({ audio: true })`, a requested `AudioContext` sample rate, and blob URL AudioWorklet modules. `WavRecorder({ sampleRate: 16000 })` and `WavStreamPlayer({ sampleRate: 24000 })` match this project's gateway PCM contract. The browser implementation still depends on the installed WebView's audio APIs, device routing and browser audio processing.

| Installed source file | SHA-256 |
| --- | --- |
| `node_modules/wavtools/lib/wav_recorder.js` | `e157779c5f10b23c6a56e89f8ed027a195dc52dd0699ea1d8b47d2c39170442c` |
| `node_modules/wavtools/lib/wav_stream_player.js` | `c305a9ebff6427b4ab1329ddd3da7c13cd585820e5b5a2d08091ffc2cbd5a668` |
| `node_modules/wavtools/lib/worklets/audio_processor.js` | `83137bc0e508d73346143884a5c9f37cfade5634627351156fd14c26ea6c4c56` |
| `node_modules/wavtools/lib/worklets/stream_processor.js` | `9eb003313534cccb30f34b1be1143d8b985551b28af36f78914b0fb2294ba160` |

The source's `begin()` does not expose echo cancellation, noise suppression, or gain control options. A headset and actual Android device checks are needed before accepting open speaker duplex behavior. Capacitor's generic minimum WebView support does not establish AudioWorklet support on every supported OS/device.

## Provider interface and credentials

The gateway uses the requested exact model `qwen-audio-3.1-realtime-plus`, not a text-only Qwen service. [The model access reference](https://platform.qianwenai.com/docs/api-reference/qwen-audio-realtime/model-access) lists WebSocket, WebRTC and AOQ. [The Android SDK reference](https://platform.qianwenai.com/docs/api-reference/qwen-audio-realtime/android-sdk) specifies PCM16 mono input at 16 kHz and supports the exact model. Protocol details and acceptance evidence are kept separately from the UI and clinical workflow.

Current v0.2 calls the selected provider directly from the Android native HTTPS/WSS bridge. Keys are protected by AndroidKeyStore-backed native storage and injected by the native network layer. The optional v0.1 gateway instead keeps its own provider credentials in its server environment. Neither path permits keys in Vite variables, Capacitor config, Android resources, browser storage or APK assets.

## Native changes from the Capacitor template

- `app/src/main/AndroidManifest.xml`: microphone and audio settings permissions; a network security configuration.
- `app/src/main/res/xml/network_security_config.xml`: cleartext disabled for release/default builds.
- `app/src/debug/`: debug-only loopback cleartext exceptions (localhost, 127.0.0.1 and ::1); the native provider bridge requires HTTPS/WSS.
- Gradle wrapper: upstream 8.14.3 distribution retained; [official SHA-256](https://services.gradle.org/distributions/gradle-8.14.3-all.zip.sha256) pinned and network timeout increased.
- Android variables/root: all native modules explicitly use the installed Build Tools 36.0.0; version name is `0.2.1` and versionCode is `3`.

The default Capacitor compile/target SDK 36, AGP 8.13.0 and Gradle 8.14.3 were retained. Build cache and runtime downloads are machine-local and excluded from this public repository.
