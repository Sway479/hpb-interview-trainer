# WebSocket failure diagnostics — 2026-10-21

## Trigger and current conclusion

A real Qwen-compatible gateway session passed text HTTP, WSS handshake/probe, opening speech, ASR and one complete clinical question/answer, then disconnected during a later patient transcription stream after roughly one minute. The prior JavaScript handler replaced all native `error` messages with a generic network/authentication message, so that observation alone did not establish a timeout, authentication problem or gateway heartbeat incompatibility.

The native bridge now returns structured, sanitized diagnostics. The configured native timeouts remain connect15s / read60s / write30s, ping25s. No heartbeat policy was changed before a classified runtime failure was obtained. The already-open conversation should be used for the next bounded reproduction; a new paid full-flow run is not required merely to obtain failure metadata.

## Exact upstream source checked

Source is the Maven Central release [okhttp-jvm-5.4.0-sources.jar](https://repo.maven.apache.org/maven2/com/squareup/okhttp3/okhttp-jvm/5.4.0/okhttp-jvm-5.4.0-sources.jar), retained in `.cache/native-upstream`. This corresponds to the project-pinned OkHttp5.4.0 source tag [parent-5.4.0](https://github.com/lysine-dev/okhttp/tree/parent-5.4.0), commit `61423f472da24e0ccc42b6a2c0863fb27932fea5`.

| Source / released source line | Verified behavior | Interpretation |
| --- | --- | --- |
| `commonJvmAndroid/okhttp3/internal/ws/RealWebSocket.kt` lines288–295 | A nonzero ping interval schedules repeated calls to `writePingFrame`. | With the app's25s setting the first ping occurs after about25s. |
| Same file, lines593–606 | If the previous ping still awaits its pong at the next ping task, OkHttp fails the socket using `SocketTimeoutException`. | A missing first pong can cause failure around50s after connection setup. Scheduling and connection timing prevent an exact wall-clock guarantee. This is a plausible mechanism for the observed time pattern, not yet a confirmed diagnosis. |
| Same file, lines410–415 | Receiving a pong clears `awaitingPong`. | Application JSON messages do not themselves clear the pending WebSocket control-frame pong state. |
| `commonJvmAndroid/okhttp3/internal/ws/WebSocketReader.kt` lines123–131 | The reader clears the read timeout while awaiting the first byte of a new frame, then restores it for the rest of that frame. | The configured60s read timeout is not simply a60s idle connection timer. It can still matter to stalled reads within a frame. |
| `commonJvmAndroid/okhttp3/internal/connection/RealConnection.kt` lines285–288 | `useAsSocket()` sets the underlying Java socket timeout to0. | A successful socket upgrade uses socket behavior distinct from ordinary HTTP. This does not disable the explicit scheduled ping watchdog. |

## Safe event fields

`socketEvent` with `type:'error'` can now include:

| Field | Restriction |
| --- | --- |
| `failureKind` | One of `timeout`, `authentication`, `tls`, `network`, `handshake`. |
| `stage` | `handshake` before `onOpen`, otherwise `connected`. |
| `errorType` | `Throwable.getClass().getSimpleName()` only when matching `[A-Za-z][A-Za-z0-9]{0,79}`; otherwise `Unknown`. No exception message or stack trace. |
| `httpStatus` | Integer100–599, when an HTTP handshake response exists. |
| `timeoutKind` | `pong` only for a `SocketTimeoutException` whose message starts with OkHttp's exact library-owned missed-pong prefix; otherwise a timeout has `io`. The raw message is compared in native memory and never returned or logged. |
| `elapsedMs` | Nonnegative duration from local monotonic clock since the socket was queued. No wall-clock or URL. |
| `pingIntervalMs` | Current configured constant25000. |

401/403 produces authentication classification; TLS exceptions are distinct from ordinary network interruptions. A connected network failure says the connection broke after establishment. Native application code logs none of these failures or their original inputs; the caller can retain the safe metadata for QA. The JavaScript presentation must map these enumerated fields and fixed classifications instead of discarding them.

Five additional JVM tests cover missed-pong identification, ordinary timeout separation, HTTP401 classification, TLS versus connected EOF/network failure, status bounds and exclusion of synthetic private text from public messages. These tests verify classification behavior without using a real key, network service or Android device. A classified actual Qwen run is still required before attributing the observed disconnection to ping/pong.
