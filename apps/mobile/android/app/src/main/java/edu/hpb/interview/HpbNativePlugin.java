package edu.hpb.interview;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

@CapacitorPlugin(name = "HpbNative")
public class HpbNativePlugin extends Plugin {
    private static final int MAX_HTTP_BYTES = 16 * 1024 * 1024;
    private static final int MAX_SOCKET_CHARS = 3 * 1024 * 1024;
    private static final long PING_INTERVAL_MS = 25000;
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final ExecutorService socketCommands = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService cleanup = Executors.newSingleThreadScheduledExecutor();
    private final ConcurrentHashMap<Call, String> requests = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, SocketState> sockets = new ConcurrentHashMap<>();
    private final Object credentialNetworkLock = new Object();
    private final AtomicBoolean destroyed = new AtomicBoolean(false);
    private HpbCredentialStore credentials;
    private HpbPrivateStore files;
    private OkHttpClient client;

    @Override public void load() {
        credentials = new HpbCredentialStore(getContext());
        files = new HpbPrivateStore(getContext());
        client = new OkHttpClient.Builder()
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS).pingInterval(PING_INTERVAL_MS, TimeUnit.MILLISECONDS).build();
    }

    @FunctionalInterface private interface Work { void run() throws Exception; }

    private void async(PluginCall call, ExecutorService executor, Work work) {
        if (destroyed.get()) { call.reject("原生服务已关闭。", "NATIVE_CLOSED"); return; }
        try {
            executor.execute(() -> {
                if (destroyed.get()) { call.reject("原生服务已关闭。", "NATIVE_CLOSED"); return; }
                try { work.run(); }
                catch (HpbNativeException error) { call.reject(error.getMessage(), error.code); }
                catch (Exception error) { call.reject("设备操作未完成，请检查网络与可用存储后重试。", "NATIVE_OPERATION_FAILED"); }
            });
        } catch (RejectedExecutionException error) { call.reject("原生服务已关闭。", "NATIVE_CLOSED"); }
    }

    @PluginMethod public void saveCredential(PluginCall call) {
        async(call, workers, () -> {
            String id = HpbCredentialStore.identifier(call.getString("id"));
            synchronized (credentialNetworkLock) {
                credentials.save(id, call.getString("key"), call.getArray("origins"));
                cancelProfile(id);
            }
            call.resolve();
        });
    }

    @PluginMethod public void credentialStatus(PluginCall call) {
        async(call, workers, () -> {
            JSArray ids = call.getArray("ids");
            if (ids == null || ids.length() > 1000) throw HpbNativeException.invalid();
            JSArray entries = new JSArray();
            for (int i = 0; i < ids.length(); i++) {
                String id = HpbCredentialStore.identifier(ids.getString(i));
                entries.put(new JSObject().put("id", id).put("hasKey", credentials.has(id)));
            }
            call.resolve(new JSObject().put("entries", entries));
        });
    }

    @PluginMethod public void deleteCredential(PluginCall call) {
        async(call, workers, () -> {
            String id = HpbCredentialStore.identifier(call.getString("id"));
            synchronized (credentialNetworkLock) { credentials.delete(id); cancelProfile(id); }
            call.resolve();
        });
    }

    private void cancelProfile(String id) {
        for (Map.Entry<Call, String> request : requests.entrySet()) if (id.equals(request.getValue())) request.getKey().cancel();
        for (SocketState state : sockets.values()) if (id.equals(state.profileId)) cancelSocket(state, 1000, "配置已更新，连接已关闭。");
    }

    @PluginMethod public void http(PluginCall call) {
        async(call, workers, () -> {
            String profileId = HpbCredentialStore.identifier(call.getString("profileId"));
            String url = call.getString("url");
            String body = call.getString("body");
            int timeout = call.getInt("timeoutMs", 60000);
            if (body == null || body.getBytes(StandardCharsets.UTF_8).length > MAX_HTTP_BYTES || timeout < 100 || timeout > 120000) throw HpbNativeException.invalid();
            final HpbCredentialStore.Credential credential;
            final Call requestCall;
            synchronized (credentialNetworkLock) {
                credential = credentials.read(profileId);
                credential.authorize(url, false);
                Request request = new Request.Builder().url(url)
                    .header("Authorization", "Bearer " + credential.key).header("Accept", "application/json")
                    .post(RequestBody.create(body, MediaType.get("application/json; charset=utf-8"))).build();
                requestCall = client.newCall(request);
                requestCall.timeout().timeout(timeout, TimeUnit.MILLISECONDS);
                requests.put(requestCall, profileId);
                requestCall.enqueue(new Callback() {
                    @Override public void onFailure(Call failed, IOException error) {
                        requests.remove(failed);
                        call.reject(failed.isCanceled() ? "请求已取消。" : "API 网络请求未完成，请核对配置与网络。", failed.isCanceled() ? "REQUEST_CANCELLED" : "NETWORK_FAILED");
                    }
                    @Override public void onResponse(Call completed, Response response) {
                        try (Response closeable = response) {
                            if (completed.isCanceled() || destroyed.get()) throw new HpbNativeException("REQUEST_CANCELLED", "请求已取消。");
                            ResponseBody responseBody = closeable.body();
                            String text = responseBody == null ? "" : responseText(responseBody);
                            call.resolve(new JSObject().put("status", closeable.code()).put("body", credential.redact(text)));
                        } catch (HpbNativeException error) { call.reject(error.getMessage(), error.code); }
                        catch (Exception error) { call.reject("API 响应读取未完成，请检查网络后重试。", "RESPONSE_FAILED"); }
                        finally { requests.remove(completed); }
                    }
                });
            }
        });
    }

    private static String responseText(ResponseBody body) throws Exception {
        if (body.contentLength() > MAX_HTTP_BYTES) throw new HpbNativeException("RESPONSE_TOO_LARGE", "API 响应超过本机桥接大小上限。");
        try (InputStream input = body.byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if ((long) output.size() + count > MAX_HTTP_BYTES) throw new HpbNativeException("RESPONSE_TOO_LARGE", "API 响应超过本机桥接大小上限。");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    @PluginMethod public void openSocket(PluginCall call) {
        async(call, socketCommands, () -> {
            String id = HpbCredentialStore.identifier(call.getString("id"));
            String profileId = HpbCredentialStore.identifier(call.getString("profileId"));
            String url = call.getString("url");
            synchronized (credentialNetworkLock) {
                HpbCredentialStore.Credential credential = credentials.read(profileId);
                credential.authorize(url, true);
                SocketState state = new SocketState(id, profileId, credential);
                if (sockets.putIfAbsent(id, state) != null) throw new HpbNativeException("SOCKET_ID_ACTIVE", "该连接编号仍在使用，请先关闭连接。");
                try {
                    Request request = new Request.Builder().url(url).header("Authorization", "Bearer " + credential.key).build();
                    state.socket = client.newWebSocket(request, new WebSocketListener() {
                        @Override public void onOpen(WebSocket webSocket, Response response) {
                            if (state.closed.get() || destroyed.get()) { webSocket.cancel(); return; }
                            state.open.set(true);
                            event(state, "open", null, null, null);
                        }
                        @Override public void onMessage(WebSocket webSocket, String text) {
                            if (state.closed.get()) return;
                            if (text.length() > MAX_SOCKET_CHARS) { event(state, "error", null, "实时响应超过大小上限。", null); cancelSocket(state, 1009, "实时响应超过大小上限。"); return; }
                            event(state, "message", credential.redact(text), null, null);
                        }
                        @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
                            event(state, "error", null, "此连接仅接收 JSON 文本实时协议。", null);
                            cancelSocket(state, 1003, "不支持的实时数据格式。");
                        }
                        @Override public void onClosing(WebSocket webSocket, int code, String reason) {
                            state.closing.set(true);
                            webSocket.close(code, "");
                        }
                        @Override public void onClosed(WebSocket webSocket, int code, String reason) { finishSocket(state, code, "实时连接已关闭。"); }
                        @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                            Integer httpStatus = response == null ? null : response.code();
                            if (response != null) try { response.close(); } catch (Exception ignored) { /* Still release socket state below. */ }
                            if (!state.closed.get()) socketFailure(state, error, httpStatus);
                            finishSocket(state, 1006, "实时连接已断开。");
                        }
                    });
                } catch (Exception error) { sockets.remove(id, state); state.closed.set(true); throw error; }
            }
            call.resolve();
        });
    }

    @PluginMethod public void sendSocket(PluginCall call) {
        async(call, socketCommands, () -> {
            String id = HpbCredentialStore.identifier(call.getString("id"));
            String data = call.getString("data");
            SocketState state = sockets.get(id);
            if (data == null || data.length() > MAX_SOCKET_CHARS) throw HpbNativeException.invalid();
            if (state == null || !state.open.get() || state.closed.get() || state.closing.get() || state.socket == null || !state.socket.send(data)) throw new HpbNativeException("SOCKET_NOT_OPEN", "实时连接尚未就绪或已关闭。");
            call.resolve();
        });
    }

    @PluginMethod public void closeSocket(PluginCall call) {
        async(call, socketCommands, () -> {
            String id = HpbCredentialStore.identifier(call.getString("id"));
            SocketState state = sockets.get(id);
            if (state != null && !state.closed.get()) {
                state.closing.set(true);
                if (state.socket == null || !state.socket.close(1000, "")) cancelSocket(state, 1000, "实时连接已关闭。");
                else cleanup.schedule(() -> cancelSocket(state, 1000, "本机已关闭实时连接。"), 3, TimeUnit.SECONDS);
            }
            call.resolve();
        });
    }

    private void cancelSocket(SocketState state, int code, String message) {
        finishSocket(state, code, message);
        WebSocket socket = state.socket;
        if (socket != null) socket.cancel();
    }

    private void finishSocket(SocketState state, int code, String message) {
        if (!state.closed.compareAndSet(false, true)) return;
        sockets.remove(state.id, state);
        event(state, "close", null, message, code);
    }

    private void event(SocketState state, String type, String data, String message, Integer code) {
        if (destroyed.get()) return;
        JSObject payload = new JSObject().put("id", state.id).put("type", type);
        if (data != null) payload.put("data", data);
        if (message != null) payload.put("message", message);
        if (code != null) payload.put("code", code);
        emitSocketEvent(payload);
    }

    private void socketFailure(SocketState state, Throwable error, Integer httpStatus) {
        HpbSocketFailure failure = new HpbSocketFailure(error, httpStatus, state.open.get());
        JSObject payload = new JSObject().put("id", state.id).put("type", "error")
            .put("message", failure.message).put("failureKind", failure.failureKind)
            .put("stage", failure.stage).put("errorType", failure.errorType)
            .put("elapsedMs", Math.max(0, SystemClock.elapsedRealtime() - state.startedAtMs))
            .put("pingIntervalMs", PING_INTERVAL_MS);
        if (failure.httpStatus != null) payload.put("httpStatus", failure.httpStatus);
        if (failure.timeoutKind != null) payload.put("timeoutKind", failure.timeoutKind);
        emitSocketEvent(payload);
    }

    private void emitSocketEvent(JSObject payload) {
        if (destroyed.get()) return;
        execute(() -> { if (!destroyed.get()) notifyListeners("socketEvent", payload); });
    }

    private static final class SocketState {
        final String id;
        final String profileId;
        final HpbCredentialStore.Credential credential;
        final long startedAtMs = SystemClock.elapsedRealtime();
        final AtomicBoolean open = new AtomicBoolean(false);
        final AtomicBoolean closing = new AtomicBoolean(false);
        final AtomicBoolean closed = new AtomicBoolean(false);
        volatile WebSocket socket;
        SocketState(String id, String profileId, HpbCredentialStore.Credential credential) { this.id = id; this.profileId = profileId; this.credential = credential; }
    }

    @PluginMethod public void readData(PluginCall call) { async(call, storage, () -> call.resolve(files.readData(call.getString("path")))); }
    @PluginMethod public void writeData(PluginCall call) { async(call, storage, () -> { files.writeData(call.getString("path"), call.getString("data")); call.resolve(); }); }
    @PluginMethod public void listData(PluginCall call) { async(call, storage, () -> call.resolve(files.listData(call.getString("path")))); }
    @PluginMethod public void deleteData(PluginCall call) { async(call, storage, () -> { files.deleteData(call.getString("path")); call.resolve(); }); }
    @PluginMethod public void appendAudio(PluginCall call) { async(call, storage, () -> { files.appendAudio(call.getString("sessionId"), call.getString("role"), call.getString("audio"), call.getInt("sampleRate")); call.resolve(); }); }
    @PluginMethod public void readAudio(PluginCall call) { async(call, storage, () -> call.resolve(files.readAudio(call.getString("sessionId"), call.getString("role")))); }
    @PluginMethod public void deleteAudio(PluginCall call) { async(call, storage, () -> { files.deleteAudio(call.getString("sessionId")); call.resolve(); }); }
    @PluginMethod public void exportPackage(PluginCall call) { async(call, storage, () -> call.resolve(files.exportPackage(call.getString("fileName"), call.getArray("textFiles"), call.getArray("recordingSessionIds"), call.getBoolean("includeAudio", false)))); }

    @PluginMethod public void sharePackage(PluginCall call) {
        async(call, storage, () -> {
            String fileName = call.getString("fileName");
            Uri uri = files.shareUri(call.getString("uri"), fileName);
            String mime = call.getString("mimeType", "application/zip");
            if (!mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) throw HpbNativeException.invalid();
            Intent intent = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_TITLE, fileName).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newUri(getContext().getContentResolver(), fileName, uri));
            getActivity().runOnUiThread(() -> {
                try { getActivity().startActivity(Intent.createChooser(intent, "导出科研记录")); call.resolve(); }
                catch (Exception error) { call.reject("设备未能打开文件分享，请检查可用的接收应用。", "SHARE_FAILED"); }
            });
        });
    }

    @Override protected void handleOnDestroy() {
        destroyed.set(true);
        for (Call request : requests.keySet()) request.cancel();
        requests.clear();
        for (SocketState state : sockets.values()) cancelSocket(state, 1000, "");
        sockets.clear();
        if (client != null) { client.dispatcher().cancelAll(); client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
        workers.shutdownNow();
        socketCommands.shutdownNow();
        storage.shutdown(); // Let already-started AtomicFile writes finish.
        cleanup.shutdownNow();
    }
}
