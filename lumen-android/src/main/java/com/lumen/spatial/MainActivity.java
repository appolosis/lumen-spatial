package com.lumen.spatial;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Surface;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import rikka.shizuku.Shizuku;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;

/**
 * Native shell for the Lumen web app.
 * - Serves the bundled web app from a secure https origin (camera + ES modules work).
 * - Grants the camera to the page.
 * - Feeds head tracking from the phone's game rotation vector sensor at full rate.
 * - Fullscreen, landscape, screen kept on, photos saved to Pictures/Lumen.
 */
public class MainActivity extends Activity implements SensorEventListener {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/www/index.html";
    private static final int REQ_CAMERA = 1, REQ_FILE = 2;

    private WebView web;
    private SensorManager sensors;
    private Sensor rotationSensor;
    private HandlerThread sensorThread;
    private volatile boolean poseWanted = false;
    private volatile String pose = "";
    private volatile int displayRotation = Surface.ROTATION_90;
    private final float[] rot = new float[9], remapped = new float[9];
    private PermissionRequest pendingCameraRequest;
    private PhoneStream phone;
    private WebMessagePortCompat nativePort;
    private boolean arrayBuffers;
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Shizuku.OnRequestPermissionResultListener shizukuPermissionListener = (code, result) -> sendShizukuState();
    private final Shizuku.OnBinderReceivedListener shizukuUp = this::sendShizukuState;
    private final Shizuku.OnBinderDeadListener shizukuDown = this::sendShizukuState;
    private ValueCallback<Uri[]> fileCallback;

    // Runs before the web app's own scripts.
    private static final String BRIDGE_JS =
        "(function(){\n" +
        "  if (!window.LumenNative) return;\n" +
        "  window.__lumenNative = true;\n" +
        "  class RelativeOrientationSensor extends EventTarget {\n" +
        "    constructor(){ super(); this._on = false; this.onreading = null; this.onerror = null; }\n" +
        "    get quaternion(){ const s = LumenNative.pose(); return s ? s.split(',').map(Number) : null; }\n" +
        "    start(){ if (this._on) return; this._on = true; LumenNative.startPose();\n" +
        "      const tick = () => { if (!this._on) return; const e = new Event('reading');\n" +
        "        this.dispatchEvent(e); if (this.onreading) this.onreading(e); requestAnimationFrame(tick); };\n" +
        "      requestAnimationFrame(tick); }\n" +
        "    stop(){ this._on = false; LumenNative.stopPose(); }\n" +
        "  }\n" +
        "  window.RelativeOrientationSensor = RelativeOrientationSensor;\n" +
        "  // The activity is already fullscreen + landscape; make these calls succeed quietly.\n" +
        "  Element.prototype.requestFullscreen = function(){ return Promise.resolve(); };\n" +
        "  Document.prototype.exitFullscreen = function(){ return Promise.resolve(); };\n" +
        "  try { if (screen.orientation) { screen.orientation.lock = () => Promise.resolve(); screen.orientation.unlock = () => {}; } } catch (e) {}\n" +
        "  // WebView can't download blob: links, so hand downloaded images to the app instead.\n" +
        "  const click = HTMLAnchorElement.prototype.click;\n" +
        "  HTMLAnchorElement.prototype.click = function(){\n" +
        "    if (this.download && /^(blob|data):/.test(this.href)) {\n" +
        "      const name = this.download;\n" +
        "      fetch(this.href).then(r => r.blob()).then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }))\n" +
        "        .then(d => LumenNative.saveImage(name, String(d).split(',')[1])).catch(e => console.warn('save failed', e));\n" +
        "      return;\n" +
        "    }\n" +
        "    return click.call(this);\n" +
        "  };\n" +
        "})();";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // chrome://inspect from the PC
        }

        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        setContentView(web);
        web.post(this::hideSystemUi);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", this::serveAsset)
            .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                setupPort();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handlePermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "LumenNative");
        phone = new PhoneStream(this, new PhoneStream.Sink() {
            @Override public void sendJson(JSONObject msg) { postToPage(msg.toString()); }
            @Override public void sendPacket(byte[] packet) { postToPage(packet); }
        });
        arrayBuffers = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
        try {
            Shizuku.addRequestPermissionResultListener(shizukuPermissionListener);
            Shizuku.addBinderReceivedListener(shizukuUp);
            Shizuku.addBinderDeadListener(shizukuDown);
        } catch (Throwable ignored) { }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, BRIDGE_JS, Collections.singleton(ORIGIN));
        }

        sensors = (SensorManager) getSystemService(SENSOR_SERVICE);
        rotationSensor = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR);
        if (rotationSensor == null) rotationSensor = sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        sensorThread = new HandlerThread("lumen-sensors");
        sensorThread.start();

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    // ---------- assets with correct MIME types (JS modules and WASM are strict about this) ----------
    private WebResourceResponse serveAsset(String path) {
        try {
            InputStream in = getAssets().open(path);
            return new WebResourceResponse(mimeFor(path), null, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
                new java.io.ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mimeFor(String p) {
        String n = p.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js") || n.endsWith(".mjs")) return "text/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json") || n.endsWith(".webmanifest")) return "application/json";
        if (n.endsWith(".wasm")) return "application/wasm";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        return "application/octet-stream";
    }

    // ---------- camera permission for the page ----------
    private void handlePermission(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
        }
        if (!wantsCamera) { request.deny(); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingCameraRequest = request;
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code != REQ_CAMERA || pendingCameraRequest == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingCameraRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        else pendingCameraRequest.deny();
        pendingCameraRequest = null;
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        }
    }

    // ---------- head tracking ----------
    private void updateDisplayRotation() {
        if (Build.VERSION.SDK_INT >= 30 && getDisplay() != null) displayRotation = getDisplay().getRotation();
        else displayRotation = getWindowManager().getDefaultDisplay().getRotation();
    }

    @Override
    public void onSensorChanged(SensorEvent e) {
        SensorManager.getRotationMatrixFromVector(rot, e.values);
        switch (displayRotation) {
            case Surface.ROTATION_90:
                SensorManager.remapCoordinateSystem(rot, SensorManager.AXIS_Y, SensorManager.AXIS_MINUS_X, remapped); break;
            case Surface.ROTATION_180:
                SensorManager.remapCoordinateSystem(rot, SensorManager.AXIS_MINUS_X, SensorManager.AXIS_MINUS_Y, remapped); break;
            case Surface.ROTATION_270:
                SensorManager.remapCoordinateSystem(rot, SensorManager.AXIS_MINUS_Y, SensorManager.AXIS_X, remapped); break;
            default:
                System.arraycopy(rot, 0, remapped, 0, 9);
        }
        // Rotation matrix (screen -> world, row-major) to quaternion [x, y, z, w].
        float m00 = remapped[0], m01 = remapped[1], m02 = remapped[2];
        float m10 = remapped[3], m11 = remapped[4], m12 = remapped[5];
        float m20 = remapped[6], m21 = remapped[7], m22 = remapped[8];
        float tr = m00 + m11 + m22, qx, qy, qz, qw, sc;
        if (tr > 0) {
            sc = (float) Math.sqrt(tr + 1.0) * 2f;
            qw = 0.25f * sc; qx = (m21 - m12) / sc; qy = (m02 - m20) / sc; qz = (m10 - m01) / sc;
        } else if (m00 > m11 && m00 > m22) {
            sc = (float) Math.sqrt(1.0 + m00 - m11 - m22) * 2f;
            qw = (m21 - m12) / sc; qx = 0.25f * sc; qy = (m01 + m10) / sc; qz = (m02 + m20) / sc;
        } else if (m11 > m22) {
            sc = (float) Math.sqrt(1.0 + m11 - m00 - m22) * 2f;
            qw = (m02 - m20) / sc; qx = (m01 + m10) / sc; qy = 0.25f * sc; qz = (m12 + m21) / sc;
        } else {
            sc = (float) Math.sqrt(1.0 + m22 - m00 - m11) * 2f;
            qw = (m10 - m01) / sc; qx = (m02 + m20) / sc; qy = (m12 + m21) / sc; qz = 0.25f * sc;
        }
        pose = qx + "," + qy + "," + qz + "," + qw;
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    private void startPose() {
        if (rotationSensor == null) return;
        poseWanted = true;
        updateDisplayRotation();
        sensors.registerListener(this, rotationSensor, SensorManager.SENSOR_DELAY_FASTEST, new Handler(sensorThread.getLooper()));
    }

    private void stopPose() {
        poseWanted = false;
        sensors.unregisterListener(this);
        pose = "";
    }

    // ---------- page <-> native channel (phone apps stream) ----------
    private void setupPort() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL)
                || !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)) return;
        if (nativePort != null) { try { nativePort.close(); } catch (Exception ignored) { } }
        WebMessagePortCompat[] ports = WebViewCompat.createWebMessageChannel(web);
        nativePort = ports[0];
        WebViewCompat.postWebMessage(web, new WebMessageCompat("lumen-native-port", new WebMessagePortCompat[]{ports[1]}), Uri.parse(ORIGIN));
        sendShizukuState();
    }

    private void postToPage(String text) {
        mainHandler.post(() -> { if (nativePort != null) nativePort.postMessage(new WebMessageCompat(text)); });
    }

    private void postToPage(byte[] data) {
        mainHandler.post(() -> {
            if (nativePort == null) return;
            if (arrayBuffers) nativePort.postMessage(new WebMessageCompat(data));
            else nativePort.postMessage(new WebMessageCompat("b:" + Base64.encodeToString(data, Base64.NO_WRAP)));
        });
    }

    private void sendShizukuState() {
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", "shizuku");
            msg.put("state", phone != null ? phone.shizukuState() : "missing");
            postToPage(msg.toString());
        } catch (Exception ignored) { }
    }

    private class Bridge {
        @JavascriptInterface public void requestPort() { runOnUiThread(MainActivity.this::setupPort); }
        @JavascriptInterface public String shizukuState() { return phone.shizukuState(); }
        @JavascriptInterface public void requestShizuku() { runOnUiThread(phone::requestShizukuPermission); }
        @JavascriptInterface public void openShizuku() { runOnUiThread(phone::openShizuku); }
        @JavascriptInterface public void listApps() { phone.listApps(); }
        @JavascriptInterface public void phoneStart(String pkg, int w, int h, int dpi) { phone.start(pkg, w, h, dpi); }
        @JavascriptInterface public void phoneLaunch(String pkg) { if (phone.running()) phone.launch(pkg); }
        @JavascriptInterface public void phoneSend(String base64) {
            try { phone.send(Base64.decode(base64, Base64.NO_WRAP)); } catch (IllegalArgumentException ignored) { }
        }
        @JavascriptInterface public void phoneStop() { phone.stop(); }
        @JavascriptInterface public boolean phoneRunning() { return phone.running(); }
        // Launching an app on the hidden display moves input focus there. Pull it back so the
        // controller keeps reaching Lumen (which forwards it to the game as a virtual gamepad).
        @JavascriptInterface public void focusLumen() {
            runOnUiThread(() -> {
                try {
                    android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
                    am.moveTaskToFront(getTaskId(), 0);
                } catch (Exception e) { android.util.Log.w("LumenPhone", "focus", e); }
            });
        }
        @JavascriptInterface public void phoneAttach(int port, String secret, String pkg) {
            if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) phone.attach(port, secret, pkg);
        }

        @JavascriptInterface public String pose() { return pose; }
        @JavascriptInterface public void startPose() { runOnUiThread(MainActivity.this::startPose); }
        @JavascriptInterface public void stopPose() { runOnUiThread(MainActivity.this::stopPose); }
        @JavascriptInterface public void saveImage(String name, String base64) {
            byte[] bytes;
            try { bytes = Base64.decode(base64, Base64.DEFAULT); } catch (IllegalArgumentException e) { return; }
            String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
            boolean ok = writeImage(safe, bytes);
            runOnUiThread(() -> Toast.makeText(MainActivity.this,
                ok ? "Saved to Pictures/Lumen" : "Couldn't save photo", Toast.LENGTH_SHORT).show());
        }
    }

    private boolean writeImage(String name, byte[] bytes) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Lumen");
                Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return false;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) return false;
                    out.write(bytes);
                }
            } else {
                File dir = new File(getExternalFilesDir(Environment.DIRECTORY_PICTURES), "Lumen");
                if (!dir.exists() && !dir.mkdirs()) return false;
                try (FileOutputStream out = new FileOutputStream(new File(dir, name))) { out.write(bytes); }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ---------- lifecycle ----------
    private void goBack() {
        if (web != null && web.canGoBack()) web.goBack();
        else finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { goBack(); } // Android 12 and older

    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getDecorView().getWindowInsetsController();
            if (c == null) c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUi();
            web.postDelayed(this::hideSystemUi, 300); // some ROMs re-show bars right after focus returns
        }
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        updateDisplayRotation();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        updateDisplayRotation();
        if (poseWanted) startPose();
    }

    @Override
    protected void onPause() {
        if (rotationSensor != null) sensors.unregisterListener(this);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onStop() {
        // Leaving Lumen ends the app stream (the hidden display and its app go away).
        if (phone != null) phone.stop();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        try {
            Shizuku.removeRequestPermissionResultListener(shizukuPermissionListener);
            Shizuku.removeBinderReceivedListener(shizukuUp);
            Shizuku.removeBinderDeadListener(shizukuDown);
        } catch (Throwable ignored) { }
        if (phone != null) phone.stop();
        sensors.unregisterListener(this);
        sensorThread.quitSafely();
        web.destroy();
        super.onDestroy();
    }
}
