package edu.hpb.interview;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

final class HpbCredentialStore {
    private static final String ALIAS = "hpb.credentials.aes.v1";
    private final SharedPreferences preferences;

    HpbCredentialStore(Context context) {
        preferences = context.getSharedPreferences("hpb.credentials.v1", Context.MODE_PRIVATE);
    }

    static String identifier(String value) throws HpbNativeException {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")) throw HpbNativeException.invalid();
        return value;
    }

    private SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).setKeySize(256).build());
        return generator.generateKey();
    }

    synchronized void save(String id, String key, JSONArray requestedOrigins) throws HpbNativeException {
        identifier(id);
        if (key == null || key.isEmpty() || key.length() > 8192 || !key.matches("[\\x21-\\x7E]+")) throw HpbNativeException.invalid();
        if (requestedOrigins == null || requestedOrigins.length() == 0 || requestedOrigins.length() > 32) throw HpbNativeException.invalid();
        try {
            LinkedHashSet<String> origins = new LinkedHashSet<>();
            for (int i = 0; i < requestedOrigins.length(); i++) {
                Object item = requestedOrigins.get(i);
                if (!(item instanceof String)) throw HpbNativeException.invalid();
                origins.add(origin((String) item, true));
            }
            JSONObject plaintext = new JSONObject().put("key", key).put("origins", new JSONArray(origins));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
            cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
            JSONObject encrypted = new JSONObject().put("v", 1)
                .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .put("ciphertext", Base64.encodeToString(cipher.doFinal(plaintext.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
            if (!preferences.edit().putString(id, encrypted.toString()).commit()) throw new Exception();
        } catch (HpbNativeException error) { throw error; }
        catch (Exception error) { throw new HpbNativeException("CREDENTIAL_SAVE_FAILED", "设备安全存储无法保存密钥，请检查设备锁定与存储状态。"); }
    }

    synchronized Credential read(String id) throws HpbNativeException {
        identifier(id);
        String value = preferences.getString(id, null);
        if (value == null) throw new HpbNativeException("CREDENTIAL_MISSING", "该 API 配置尚未保存密钥。");
        try {
            JSONObject encrypted = new JSONObject(value);
            if (encrypted.getInt("v") != 1) throw new Exception();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, encryptionKey(), new GCMParameterSpec(128, Base64.decode(encrypted.getString("iv"), Base64.NO_WRAP)));
            cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
            JSONObject plaintext = new JSONObject(new String(cipher.doFinal(Base64.decode(encrypted.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
            List<String> origins = new ArrayList<>();
            JSONArray list = plaintext.getJSONArray("origins");
            for (int i = 0; i < list.length(); i++) origins.add(origin(list.getString(i), true));
            return new Credential(plaintext.getString("key"), origins);
        } catch (Exception error) { throw new HpbNativeException("CREDENTIAL_UNAVAILABLE", "设备安全存储中的密钥不可用，请重新保存该配置密钥。"); }
    }

    synchronized boolean has(String id) throws HpbNativeException {
        identifier(id);
        try { return !read(id).key.isEmpty(); }
        catch (HpbNativeException error) { return false; }
    }

    synchronized void delete(String id) throws HpbNativeException {
        identifier(id);
        if (!preferences.edit().remove(id).commit()) throw new HpbNativeException("CREDENTIAL_DELETE_FAILED", "密钥删除未完成，请重试。");
    }

    static String origin(String value, boolean originOnly) throws HpbNativeException {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("wss")) scheme = "https";
            else if (scheme.equals("ws")) scheme = "http";
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            if (host.isEmpty() || uri.getRawUserInfo() != null || uri.getRawFragment() != null || value.length() > 8192) throw new Exception();
            if (!(scheme.equals("https") || (BuildConfig.DEBUG && scheme.equals("http") &&
                (host.equals("localhost") || host.equals("127.0.0.1") || host.equals("::1"))))) throw new Exception();
            if (originOnly && ((uri.getRawPath() != null && !uri.getRawPath().isEmpty() && !uri.getRawPath().equals("/")) || uri.getRawQuery() != null)) throw new Exception();
            int port = uri.getPort();
            if (port < -1 || port == 0 || port > 65535) throw new Exception();
            if ((scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80)) port = -1;
            return scheme + "://" + (host.contains(":") ? "[" + host + "]" : host) + (port == -1 ? "" : ":" + port);
        } catch (Exception error) { throw new HpbNativeException("ORIGIN_INVALID", "API 地址必须使用 HTTPS，且不含用户凭据或片段；调试版仅允许本机明文测试。"); }
    }

    static final class Credential {
        final String key;
        final List<String> origins;
        Credential(String key, List<String> origins) { this.key = key; this.origins = origins; }
        void authorize(String url, boolean socket) throws HpbNativeException {
            String lower = url == null ? "" : url.toLowerCase(Locale.ROOT);
            if (socket ? !(lower.startsWith("wss://") || lower.startsWith("ws://")) : !(lower.startsWith("https://") || lower.startsWith("http://"))) throw HpbNativeException.invalid();
            if (!origins.contains(origin(url, false))) throw new HpbNativeException("ORIGIN_NOT_AUTHORIZED", "该 API 地址不在此密钥授权的域名中，请重新保存配置。");
        }
        String redact(String value) {
            if (value == null) return "";
            String result = value.replace(key, "[redacted]");
            try {
                result = result.replace(JSONObject.quote(key).substring(1, JSONObject.quote(key).length() - 1), "[redacted]");
                result = result.replace(URLEncoder.encode(key, "UTF-8"), "[redacted]");
            } catch (Exception ignored) {}
            return result;
        }
    }
}
