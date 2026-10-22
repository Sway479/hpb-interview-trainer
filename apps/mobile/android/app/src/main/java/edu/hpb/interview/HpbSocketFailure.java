package edu.hpb.interview;

import java.io.InterruptedIOException;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLException;

/** Fixed classifications only. Throwable messages, URLs and headers never cross the bridge. */
final class HpbSocketFailure {
    final String failureKind;
    final String stage;
    final String errorType;
    final Integer httpStatus;
    final String timeoutKind;
    final String message;

    HpbSocketFailure(Throwable error, Integer status, boolean connected) {
        stage = connected ? "connected" : "handshake";
        String simpleName = error == null ? "Unknown" : error.getClass().getSimpleName();
        errorType = simpleName.matches("[A-Za-z][A-Za-z0-9]{0,79}") ? simpleName : "Unknown";
        httpStatus = status != null && status >= 100 && status <= 599 ? status : null;
        boolean timeout = error instanceof InterruptedIOException;
        // This exact library-owned prefix identifies OkHttp's missed-pong branch. It is
        // compared in native memory and is never returned, logged or interpolated.
        boolean pong = error instanceof SocketTimeoutException && error.getMessage() != null
            && error.getMessage().startsWith("sent ping but didn't receive pong within ");
        timeoutKind = timeout ? (pong ? "pong" : "io") : null;
        if (httpStatus != null && (httpStatus == 401 || httpStatus == 403)) {
            failureKind = "authentication";
            message = "实时 API 鉴权未通过（HTTP " + httpStatus + "）。";
        } else if (timeout) {
            failureKind = "timeout";
            message = pong ? "实时连接心跳响应超时（未收到 pong）。" : (connected ? "实时连接读写超时。" : "实时连接握手超时。");
        } else if (error instanceof SSLException) {
            failureKind = "tls";
            message = "实时 API 安全连接失败，请核对证书、设备时间与网络。";
        } else if (!connected && httpStatus != null) {
            failureKind = "handshake";
            message = "实时连接握手未通过（HTTP " + httpStatus + "）。";
        } else {
            failureKind = "network";
            message = connected ? "实时连接建立后网络中断。" : "实时 API 网络连接尚未建立。";
        }
    }
}
