package edu.hpb.interview;

import static org.junit.Assert.*;
import java.io.EOFException;
import java.net.ProtocolException;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLHandshakeException;
import org.junit.Test;

public class HpbSocketFailureTest {
    @Test public void missedPongGetsSpecificTimeoutWithoutRawMessage() {
        HpbSocketFailure failure = new HpbSocketFailure(new SocketTimeoutException("sent ping but didn't receive pong within 25000ms (after 0 successful ping/pongs)"), null, true);
        assertEquals("timeout", failure.failureKind);
        assertEquals("pong", failure.timeoutKind);
        assertEquals("connected", failure.stage);
        assertEquals("SocketTimeoutException", failure.errorType);
        assertFalse(failure.message.contains("25000ms"));
    }
    @Test public void ordinaryTimeoutDoesNotClaimMissingPong() {
        HpbSocketFailure failure = new HpbSocketFailure(new SocketTimeoutException("synthetic-private-token"), null, true);
        assertEquals("io", failure.timeoutKind);
        assertFalse(failure.message.contains("synthetic-private-token"));
    }
    @Test public void authenticationCarriesOnlyHttpStatusAndClass() {
        HpbSocketFailure failure = new HpbSocketFailure(new ProtocolException("synthetic-private-token"), 401, false);
        assertEquals("authentication", failure.failureKind);
        assertEquals(Integer.valueOf(401), failure.httpStatus);
        assertEquals("handshake", failure.stage);
        assertFalse(failure.message.contains("synthetic-private-token"));
    }
    @Test public void tlsAndConnectedNetworkFailuresAreDistinct() {
        assertEquals("tls", new HpbSocketFailure(new SSLHandshakeException("synthetic-private-token"), null, false).failureKind);
        HpbSocketFailure network = new HpbSocketFailure(new EOFException("synthetic-private-token"), null, true);
        assertEquals("network", network.failureKind);
        assertEquals("connected", network.stage);
        assertFalse(network.message.contains("synthetic-private-token"));
    }
    @Test public void handshakeFailureAndInvalidStatusAreBounded() {
        assertEquals("handshake", new HpbSocketFailure(new ProtocolException("private"), 400, false).failureKind);
        HpbSocketFailure bounded = new HpbSocketFailure(new Exception("private"), 9999, false);
        assertNull(bounded.httpStatus);
        assertEquals("network", bounded.failureKind);
    }
}
