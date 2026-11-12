package app.reel7.fieldplayer;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            // Play and scratch are started from a tap, but the decoded reader and the
            // silent keepalive should not each wait on their own gesture.
            webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Capacitor keeps JS running in the background (KeepRunning). Resume timers
        // anyway so a WebView that paused them does not freeze the transport.
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) webView.resumeTimers();
    }

    @Override
    public void onResume() {
        super.onResume();
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
    }
}
