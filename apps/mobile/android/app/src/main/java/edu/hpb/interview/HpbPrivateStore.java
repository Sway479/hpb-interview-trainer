package edu.hpb.interview;

import android.content.Context;
import android.net.Uri;
import android.util.AtomicFile;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Invoked exclusively on the plugin's single storage executor to preserve append order. */
final class HpbPrivateStore {
    private static final int MAX_TEXT_BYTES = 16 * 1024 * 1024;
    private static final int MAX_AUDIO_BRIDGE_BYTES = 32 * 1024 * 1024;
    private static final String[] ROLES = { "learner", "patient" };
    private final Context context;
    private final File dataRoot;
    private final File audioRoot;
    private final File exportRoot;

    HpbPrivateStore(Context context) {
        this.context = context;
        dataRoot = new File(context.getFilesDir(), "hpb/data");
        audioRoot = new File(context.getFilesDir(), "hpb/audio");
        exportRoot = new File(context.getCacheDir(), "hpb-exports");
    }

    private static String relative(String path, boolean allowRoot) throws HpbNativeException {
        if (allowRoot && "".equals(path)) return path;
        if (path == null || path.isEmpty() || path.length() > 1024 || path.startsWith("/") || path.contains("\\") || path.contains(":")) throw HpbNativeException.invalid();
        for (String part : path.split("/", -1)) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.length() > 180 || part.endsWith(".bak") || part.endsWith(".new")) throw HpbNativeException.invalid();
            for (int i = 0; i < part.length(); i++) if (Character.isISOControl(part.charAt(i))) throw HpbNativeException.invalid();
        }
        return path;
    }

    private static File safeFile(File root, String path, boolean allowRoot) throws Exception {
        relative(path, allowRoot);
        File canonicalRoot = root.getCanonicalFile();
        File file = path.isEmpty() ? canonicalRoot : new File(canonicalRoot, path).getCanonicalFile();
        if (!(file.equals(canonicalRoot) && allowRoot) && !file.getPath().startsWith(canonicalRoot.getPath() + File.separator)) throw HpbNativeException.invalid();
        return file;
    }

    private static void parent(File file) throws IOException {
        File dir = file.getParentFile();
        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) throw new IOException();
    }

    private static void atomicText(File file, String value) throws Exception {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_TEXT_BYTES) throw new HpbNativeException("TEXT_TOO_LARGE", "单个文档超过本机桥接大小上限。");
        parent(file);
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            output.write(bytes);
            atomic.finishWrite(output);
        } catch (Exception error) { atomic.failWrite(output); throw error; }
    }

    private static byte[] read(InputStream input, int maximum) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[32 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if ((long) output.size() + count > maximum) throw new HpbNativeException("BRIDGE_TOO_LARGE", "文件超过桥接读取大小上限，请使用文件导出。");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    JSObject readData(String path) throws Exception {
        File file = safeFile(dataRoot, path, false);
        AtomicFile atomic = new AtomicFile(file);
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return new JSObject().put("exists", false).put("data", "");
        if (file.isDirectory()) throw HpbNativeException.invalid();
        try (InputStream input = atomic.openRead()) {
            return new JSObject().put("exists", true).put("data", new String(read(input, MAX_TEXT_BYTES), StandardCharsets.UTF_8));
        }
    }

    void writeData(String path, String data) throws Exception {
        if (data == null) throw HpbNativeException.invalid();
        File file = safeFile(dataRoot, path, false);
        if (file.isDirectory()) throw HpbNativeException.invalid();
        atomicText(file, data);
    }

    JSObject listData(String path) throws Exception {
        File directory = safeFile(dataRoot, path, true);
        List<String> paths = new ArrayList<>();
        if (directory.exists()) {
            if (!directory.isDirectory()) throw HpbNativeException.invalid();
            collect(directory, paths, 0);
        }
        Collections.sort(paths);
        return new JSObject().put("paths", new JSArray(paths));
    }

    private void collect(File directory, List<String> paths, int depth) throws Exception {
        if (depth > 32 || paths.size() > 100000) throw new HpbNativeException("DIRECTORY_TOO_LARGE", "本机目录过大，请缩小读取范围。");
        File[] children = directory.listFiles();
        if (children == null) throw new IOException();
        String root = dataRoot.getCanonicalPath() + File.separator;
        for (File child : children) {
            if (!child.getCanonicalPath().startsWith(root) || !child.getCanonicalFile().equals(child.getAbsoluteFile())) throw HpbNativeException.invalid();
            if (child.isDirectory()) collect(child, paths, depth + 1);
            else if (child.isFile() && !child.getName().endsWith(".bak") && !child.getName().endsWith(".new")) paths.add(child.getCanonicalPath().substring(root.length()).replace(File.separatorChar, '/'));
        }
    }

    void deleteData(String path) throws Exception {
        File file = safeFile(dataRoot, path, false);
        if (file.isDirectory()) throw new HpbNativeException("LEAF_FILE_REQUIRED", "只能删除指定文档，不能删除目录。");
        new AtomicFile(file).delete();
        if (file.exists() || new File(file.getPath() + ".bak").exists() || new File(file.getPath() + ".new").exists()) throw new IOException();
    }

    private static String role(String value) throws HpbNativeException {
        if (!"learner".equals(value) && !"patient".equals(value)) throw HpbNativeException.invalid();
        return value;
    }

    private File audioFile(String sessionId, String role, String suffix) throws Exception {
        return safeFile(audioRoot, HpbCredentialStore.identifier(sessionId) + "/" + role(role) + suffix, false);
    }

    void appendAudio(String sessionId, String role, String audio, Integer requestedRate) throws Exception {
        File pcm = audioFile(sessionId, role, ".pcm");
        File meta = audioFile(sessionId, role, ".json");
        int rate = requestedRate == null ? ("learner".equals(role) ? 16000 : 24000) : requestedRate;
        if (rate < 8000 || rate > 96000 || audio == null || audio.length() > 3 * 1024 * 1024 || !audio.matches("[A-Za-z0-9+/]*={0,2}")) throw HpbNativeException.invalid();
        byte[] chunk;
        try { chunk = Base64.decode(audio, Base64.NO_WRAP); } catch (IllegalArgumentException error) { throw HpbNativeException.invalid(); }
        if (chunk.length % 2 != 0) throw new HpbNativeException("PCM_FORMAT_INVALID", "录音数据必须为单声道 PCM16。");
        if (meta.exists()) {
            if (sampleRate(meta) != rate) throw new HpbNativeException("SAMPLE_RATE_CHANGED", "同一路录音不能中途改变采样率，请开启新会话。");
        } else {
            if (pcm.exists() && pcm.length() > 0) throw new HpbNativeException("AUDIO_METADATA_MISSING", "录音采样率记录缺失，不能继续追加。");
            atomicText(meta, new JSONObject().put("format", "pcm_s16le").put("channels", 1).put("sampleRate", rate).toString());
        }
        parent(pcm);
        try (FileOutputStream output = new FileOutputStream(pcm, true)) { output.write(chunk); }
    }

    private static int sampleRate(File meta) throws Exception {
        try (InputStream input = new AtomicFile(meta).openRead()) {
            JSONObject data = new JSONObject(new String(read(input, 4096), StandardCharsets.UTF_8));
            int rate = data.getInt("sampleRate");
            if (!"pcm_s16le".equals(data.getString("format")) || data.getInt("channels") != 1 || rate < 8000 || rate > 96000) throw new IOException();
            return rate;
        }
    }

    private static byte[] wavHeader(long length, int sampleRate) throws HpbNativeException {
        if (length > 0xffffffffL - 36 || length % 2 != 0) throw new HpbNativeException("WAV_SIZE_INVALID", "录音超出 WAV 格式上限或数据不完整。");
        ByteBuffer header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt((int) (length + 36));
        header.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1);
        header.putInt(sampleRate).putInt(sampleRate * 2).putShort((short) 2).putShort((short) 16);
        header.put("data".getBytes(StandardCharsets.US_ASCII)).putInt((int) length);
        return header.array();
    }

    JSObject readAudio(String sessionId, String role) throws Exception {
        File pcm = audioFile(sessionId, role, ".pcm");
        if (!pcm.isFile() || pcm.length() == 0) return new JSObject().put("exists", false).put("audio", "");
        if (pcm.length() > MAX_AUDIO_BRIDGE_BYTES - 44) throw new HpbNativeException("AUDIO_TOO_LARGE", "录音较长，请通过原生 ZIP 导出收听。");
        int rate = sampleRate(audioFile(sessionId, role, ".json"));
        ByteArrayOutputStream output = new ByteArrayOutputStream((int) pcm.length() + 44);
        output.write(wavHeader(pcm.length(), rate));
        try (InputStream input = new FileInputStream(pcm)) { copy(input, output, pcm.length()); }
        return new JSObject().put("exists", true).put("sampleRate", rate).put("audio", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
    }

    void deleteAudio(String sessionId) throws Exception {
        HpbCredentialStore.identifier(sessionId);
        for (String role : ROLES) {
            File pcm = audioFile(sessionId, role, ".pcm");
            if (pcm.exists() && !pcm.delete()) throw new IOException();
            File meta = audioFile(sessionId, role, ".json");
            new AtomicFile(meta).delete();
            if (meta.exists() || new File(meta.getPath() + ".bak").exists() || new File(meta.getPath() + ".new").exists()) throw new IOException();
        }
        File directory = safeFile(audioRoot, sessionId, false);
        if (directory.isDirectory()) directory.delete(); // Only the now-empty, exact session directory.
    }

    private static void copy(InputStream input, OutputStream output, long length) throws Exception {
        byte[] buffer = new byte[32 * 1024];
        long remaining = length;
        while (remaining > 0) {
            int count = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (count < 0) throw new IOException();
            output.write(buffer, 0, count);
            remaining -= count;
        }
    }

    private static String exportName(String value) throws HpbNativeException {
        relative(value, false);
        if (value.contains("/") || !value.toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) throw HpbNativeException.invalid();
        return value;
    }

    JSObject exportPackage(String fileName, JSONArray textFiles, JSONArray sessionIds, boolean includeAudio) throws Exception {
        exportName(fileName);
        if (textFiles == null || sessionIds == null || textFiles.length() > 10000 || sessionIds.length() > 10000) throw HpbNativeException.invalid();
        Set<String> names = new HashSet<>();
        names.add("recordings-manifest.json");
        // Validate every path before creating any export. The data tree is never read implicitly.
        for (int i = 0; i < textFiles.length(); i++) {
            JSONObject text = textFiles.getJSONObject(i);
            String path = relative(text.getString("path"), false);
            if (path.startsWith("audio/") || !names.add(path)) throw HpbNativeException.invalid();
            if (text.getString("content").getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) throw HpbNativeException.invalid();
        }
        Set<String> sessions = new java.util.LinkedHashSet<>();
        for (int i = 0; i < sessionIds.length(); i++) sessions.add(HpbCredentialStore.identifier(sessionIds.getString(i)));
        File file = safeFile(exportRoot, UUID.randomUUID() + "-" + fileName, false);
        parent(file);
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = null;
        JSONArray recordings = new JSONArray();
        int recordingFiles = 0;
        int missingAudio = 0;
        try {
            output = atomic.startWrite();
            // Zip close must finish its central directory without closing AtomicFile's descriptor.
            final FileOutputStream atomicOutput = output;
            try (ZipOutputStream zip = new ZipOutputStream(new FilterOutputStream(atomicOutput) {
                @Override public void close() throws IOException { flush(); }
            }, StandardCharsets.UTF_8)) {
                for (int i = 0; i < textFiles.length(); i++) {
                    JSONObject text = textFiles.getJSONObject(i);
                    zip.putNextEntry(new ZipEntry(text.getString("path")));
                    zip.write(text.getString("content").getBytes(StandardCharsets.UTF_8));
                    zip.closeEntry();
                }
                for (String session : sessions) for (String role : ROLES) {
                    String path = "audio/" + session + "/" + role + ".wav";
                    JSONObject record = new JSONObject().put("sessionId", session).put("role", role).put("path", path);
                    File pcm = audioFile(session, role, ".pcm");
                    if (!includeAudio) { record.put("status", "not_requested"); }
                    else if (!pcm.isFile() || pcm.length() == 0) { record.put("status", "missing"); missingAudio++; }
                    else {
                        int rate = sampleRate(audioFile(session, role, ".json"));
                        long size = pcm.length();
                        zip.putNextEntry(new ZipEntry(path));
                        zip.write(wavHeader(size, rate));
                        try (InputStream input = new FileInputStream(pcm)) { copy(input, zip, size); }
                        zip.closeEntry();
                        record.put("status", "included").put("sampleRate", rate).put("bytes", size + 44);
                        recordingFiles++;
                    }
                    recordings.put(record);
                }
                zip.putNextEntry(new ZipEntry("recordings-manifest.json"));
                zip.write(new JSONObject().put("schemaVersion", "1").put("includeAudio", includeAudio)
                    .put("recordingFiles", recordingFiles).put("missingAudio", missingAudio).put("recordings", recordings).toString(2).getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
            atomic.finishWrite(output);
        } catch (Exception error) { atomic.failWrite(output); throw error; }
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file, fileName);
        return new JSObject().put("uri", uri.toString()).put("fileName", fileName).put("bytes", file.length())
            .put("recordingFiles", recordingFiles).put("missingAudio", missingAudio);
    }

    Uri shareUri(String value, String fileName) throws Exception {
        exportName(fileName);
        Uri uri = Uri.parse(value == null ? "" : value);
        if (!"content".equals(uri.getScheme()) || !(context.getPackageName() + ".fileprovider").equals(uri.getAuthority()) || uri.getFragment() != null) throw HpbNativeException.invalid();
        List<String> segments = uri.getPathSegments();
        if (segments.size() != 2 || !"hpb_exports".equals(segments.get(0))) throw HpbNativeException.invalid();
        String leaf = segments.get(1);
        if (!leaf.matches("(?i)[0-9a-f-]{36}-.+\\.zip")) throw HpbNativeException.invalid();
        File file = safeFile(exportRoot, leaf, false);
        if (!file.isFile()) throw new HpbNativeException("EXPORT_MISSING", "导出文件已不存在，请重新导出。");
        Uri expected = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file, fileName);
        if (!expected.equals(uri)) throw HpbNativeException.invalid();
        return uri;
    }
}
