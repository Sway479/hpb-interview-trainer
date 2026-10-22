package edu.hpb.interview;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override protected void onCreate(Bundle savedInstanceState) {
        // Enforced before bridge initialization so native call arguments (including saved keys)
        // cannot be emitted by Capacitor's debug logger, even after a later cap sync.
        config = new CapConfig.Builder(this)
            .setAndroidScheme("https")
            .setAllowMixedContent(false)
            .setLoggingEnabled(false)
            .setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            .create();
        registerPlugin(HpbNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
