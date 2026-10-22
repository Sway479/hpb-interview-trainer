package edu.hpb.interview;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;
import java.util.Collections;
import org.junit.Test;

/** Network authorization checks run without a credential, Android device, or network request. */
public class HpbOriginPolicyTest {
    @FunctionalInterface private interface Checked { void run() throws Exception; }
    private static void denied(Checked operation) throws Exception {
        try { operation.run(); fail("Unauthorized origin was accepted"); }
        catch (HpbNativeException expected) { /* A fixed public rejection is required. */ }
    }

    @Test public void secureOriginNormalizesHostAndDefaultPort() throws Exception {
        assertEquals("https://api.example.com", HpbCredentialStore.origin("https://API.Example.Com:443/", true));
        assertEquals("https://api.example.com", HpbCredentialStore.origin("wss://api.example.com", true));
        assertEquals("https://api.example.com:8443", HpbCredentialStore.origin("https://api.example.com:8443", true));
    }

    @Test public void onlyAnOriginCanBeStoredAsAnAllowlistEntry() throws Exception {
        denied(() -> HpbCredentialStore.origin("https://api.example.com/v1", true));
        denied(() -> HpbCredentialStore.origin("https://api.example.com?model=test", true));
        denied(() -> HpbCredentialStore.origin("https://api.example.com#token", true));
        denied(() -> HpbCredentialStore.origin("https://user:pass@api.example.com", true));
    }

    @Test public void credentialAcceptsPathsOnItsOwnExactSecureOrigin() throws Exception {
        HpbCredentialStore.Credential credential = new HpbCredentialStore.Credential("synthetic-unit-token", Collections.singletonList("https://api.example.com"));
        credential.authorize("https://api.example.com/v1/chat/completions", false);
        credential.authorize("wss://api.example.com/realtime?model=synthetic", true);
    }

    @Test public void credentialCannotBeSentToSubdomainsLookalikesOrOtherPorts() throws Exception {
        HpbCredentialStore.Credential credential = new HpbCredentialStore.Credential("synthetic-unit-token", Collections.singletonList("https://api.example.com"));
        denied(() -> credential.authorize("https://api.example.com.evil.invalid/v1", false));
        denied(() -> credential.authorize("https://evil.api.example.com/v1", false));
        denied(() -> credential.authorize("https://api.example.com:8443/v1", false));
        denied(() -> credential.authorize("https://api.example.com@evil.invalid/v1", false));
        denied(() -> credential.authorize("https://api.example.com./v1", false));
    }

    @Test public void socketAndHttpEntryPointsRejectTheOtherTransport() throws Exception {
        HpbCredentialStore.Credential credential = new HpbCredentialStore.Credential("synthetic-unit-token", Collections.singletonList("https://api.example.com"));
        denied(() -> credential.authorize("https://api.example.com/realtime", true));
        denied(() -> credential.authorize("wss://api.example.com/realtime", false));
        denied(() -> credential.authorize("file:///data/private", false));
    }

    @Test public void plaintextLanAndNonLiteralLoopbackAreDeniedInDebug() throws Exception {
        for (String host : new String[] { "10.0.2.2", "192.168.1.1", "0.0.0.0", "127.0.0.2", "127.1", "localhost.evil.invalid" }) {
            denied(() -> HpbCredentialStore.origin("http://" + host + ":8787", true));
        }
    }

    @Test public void explicitDebugLoopbackSupportsAdbReverseFixtures() throws Exception {
        assertEquals("http://localhost:8787", HpbCredentialStore.origin("http://LOCALHOST:8787", true));
        assertEquals("http://127.0.0.1:8787", HpbCredentialStore.origin("ws://127.0.0.1:8787", true));
        assertEquals("http://[::1]:8787", HpbCredentialStore.origin("http://[::1]:8787", true));
    }

    @Test public void invalidPortAndEncodedAuthorityAreDenied() throws Exception {
        for (String url : new String[] { "https://api.example.com:0", "https://api.example.com:65536", "https://api.example.com:-5", "https://%61pi.example.com", "https://api.example.com\\@evil.invalid" }) {
            denied(() -> HpbCredentialStore.origin(url, true));
        }
    }
}
