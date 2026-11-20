package com.lumen.spatial;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import rikka.shizuku.Shizuku;

/**
 * Runs other Android apps on a hidden virtual display and streams it into Lumen.
 *
 * Shizuku (shell privileges) starts two processes: the scrcpy server, which creates the virtual
 * display, launches apps on it, encodes it to H.264 and injects input; and our Relay, which hands
 * that stream to this app over loopback TCP (with a one-time secret). Packets go to the web page
 * through a WebMessagePort; the page decodes them with WebCodecs and sends back scrcpy control
 * messages (touches, keys) which are written straight to the relay.
 */
final class PhoneStream {
    interface Sink {
        void sendJson(JSONObject msg);
        void sendPacket(byte[] packet);
    }

    static final String SCRCPY_VERSION = "5.0.1";
    private static final String TAG = "LumenPhone";
    private static final String JAR = "/data/local/tmp/lumen-scrcpy.jar";
    private static final String SHIZUKU_PKG = "moe.shizuku.privileged.api";
    static final int SHIZUKU_REQUEST = 7301;

    private final Context ctx;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SecureRandom rng = new SecureRandom();

    private volatile Process process;
    private volatile Socket socket;
    private volatile OutputStream controlOut;
    private volatile int session = 0;
    private boolean jarReady = false;

    PhoneStream(Context ctx, Sink sink) {
        this.ctx = ctx;
        this.sink = sink;
    }

    // ---------- Shizuku ----------

    String shizukuState() {
        try {
            ctx.getPackageManager().getPackageInfo(SHIZUKU_PKG, 0);
        } catch (PackageManager.NameNotFoundException e) {
            return "missing";
        }
        try {
            if (!Shizuku.pingBinder()) return "not_running";
            if (Shizuku.isPreV11()) return "outdated";
            if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) return "no_permission";
            return "ready";
        } catch (Throwable t) {
            return "not_running";
        }
    }

    void requestShizukuPermission() {
        try {
            if (Shizuku.pingBinder() && Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) {
                Shizuku.requestPermission(SHIZUKU_REQUEST);
            }
        } catch (Throwable t) {
            Log.w(TAG, "permission request failed", t);
        }
    }

    void openShizuku() {
        Intent i = ctx.getPackageManager().getLaunchIntentForPackage(SHIZUKU_PKG);
        if (i == null) {
            i = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=" + SHIZUKU_PKG));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { ctx.startActivity(i); } catch (Exception e) { Log.w(TAG, "open shizuku", e); }
    }

    // Shizuku.newProcess is hidden in the current API but still served; it runs a command as shell.
    private static Process shellProcess(String command) throws Exception {
        Method m = Shizuku.class.getDeclaredMethod("newProcess", String[].class, String[].class, String.class);
        m.setAccessible(true);
        return (Process) m.invoke(null, new String[]{"sh", "-c", command}, null, null);
    }

    private void ensureJar() throws Exception {
        if (jarReady) return;
        Process p = shellProcess("cat > " + JAR + ".tmp && mv " + JAR + ".tmp " + JAR);
        try (InputStream in = ctx.getAssets().open("scrcpy-server"); OutputStream out = p.getOutputStream()) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        if (p.waitFor() != 0) throw new IOException("could not copy scrcpy server");
        jarReady = true;
    }

    // ---------- installed apps ----------

    void listApps() {
        new Thread(() -> {
            try {
                PackageManager pm = ctx.getPackageManager();
                Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
                List<ResolveInfo> list = pm.queryIntentActivities(launcher, 0);
                Collections.sort(list, (a, b) -> String.valueOf(a.loadLabel(pm)).compareToIgnoreCase(String.valueOf(b.loadLabel(pm))));
                JSONArray apps = new JSONArray();
                for (ResolveInfo ri : list) {
                    String pkg = ri.activityInfo.packageName;
                    if (pkg.equals(ctx.getPackageName())) continue;
                    JSONObject o = new JSONObject();
                    o.put("pkg", pkg);
                    o.put("label", String.valueOf(ri.loadLabel(pm)));
                    o.put("icon", iconDataUrl(ri.loadIcon(pm)));
                    apps.put(o);
                }
                JSONObject msg = new JSONObject();
                msg.put("type", "apps");
                msg.put("apps", apps);
                sink.sendJson(msg);
            } catch (Exception e) {
                Log.w(TAG, "listApps", e);
            }
        }, "lumen-apps").start();
    }

    private static String iconDataUrl(Drawable d) {
        int size = 96;
        Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        d.setBounds(0, 0, size, size);
        d.draw(c);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        b.recycle();
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    // ---------- session ----------

    void start(String pkg, int width, int height, int dpi) {
        stop();
        final int mySession = ++session;
        status("starting", null);
        new Thread(() -> {
            try {
                String state = shizukuState();
                if (!"ready".equals(state)) { status("error", "shizuku:" + state); return; }
                ensureJar();

                String scid = String.format(Locale.ROOT, "%08x", rng.nextInt(0x7fffffff));
                int port = 20000 + rng.nextInt(40000);
                byte[] raw = new byte[16];
                rng.nextBytes(raw);
                StringBuilder secret = new StringBuilder();
                for (byte x : raw) secret.append(String.format(Locale.ROOT, "%02x", x));

                String apk = ctx.getApplicationInfo().sourceDir;
                String server = "CLASSPATH=" + JAR + " app_process / com.genymobile.scrcpy.Server " + SCRCPY_VERSION
                    + " scid=" + scid + " log_level=info"
                    + " video=true audio=false control=true tunnel_forward=true"
                    + " video_codec=h264 max_fps=60 video_bit_rate=12000000"
                    + " new_display=" + width + "x" + height + "/" + dpi
                    + " vd_system_decorations=true display_ime_policy=local"
                    + " clipboard_autosync=false cleanup=false power_off_on_close=false"
                    + " send_device_meta=false send_frame_meta=true send_dummy_byte=true send_stream_meta=true";
                String cmd = server + " >/data/local/tmp/lumen-scrcpy.log 2>&1 &\n"
                    + "exec env CLASSPATH=" + apk + " app_process / com.lumen.spatial.Relay " + scid + " " + port;
                Process p = shellProcess(cmd);
                if (mySession != session) { p.destroy(); return; }
                process = p;
                OutputStream pin = p.getOutputStream();
                pin.write((secret + "\n").getBytes());
                pin.flush();
                drainLog(p.getErrorStream());
                drainLog(p.getInputStream());

                connect(mySession, port, secret.toString(), pkg);
            } catch (Exception e) {
                Log.w(TAG, "start failed", e);
                if (mySession == session) { status("error", String.valueOf(e.getMessage())); cleanup(); }
            }
        }, "lumen-phone").start();
    }

    /** Debug builds only: attach to a relay started by hand over adb. */
    void attach(int port, String secret, String pkg) {
        stop();
        final int mySession = ++session;
        status("starting", null);
        new Thread(() -> {
            try { connect(mySession, port, secret, pkg); }
            catch (Exception e) { if (mySession == session) { status("error", String.valueOf(e.getMessage())); cleanup(); } }
        }, "lumen-phone").start();
    }

    private void connect(int mySession, int port, String secret, String pkg) throws Exception {
        Socket s = null;
        for (int i = 0; i < 60 && s == null; i++) {
            try {
                Socket t = new Socket();
                t.connect(new InetSocketAddress("127.0.0.1", port), 500);
                s = t;
            } catch (IOException e) {
                Thread.sleep(150);
            }
            if (mySession != session) return;
        }
        if (s == null) throw new IOException("relay did not start");
        s.setTcpNoDelay(true);
        socket = s;
        OutputStream out = s.getOutputStream();
        out.write((secret + "\n").getBytes());
        out.flush();
        controlOut = out;

        DataInputStream in = new DataInputStream(new java.io.BufferedInputStream(s.getInputStream(), 1 << 17));
        if (in.read() != 'K') throw new IOException("relay refused the session");
        int codec = in.readInt();
        if (codec == 0 || codec == 1) throw new IOException("scrcpy could not start the video stream");
        status("running", null);
        if (pkg != null && !pkg.isEmpty()) launch(pkg);

        byte[] header = new byte[12];
        while (mySession == session) {
            in.readFully(header);
            if ((header[0] & 0x80) != 0) {
                // session meta: flags(4) width(4) height(4)
                int w = readInt(header, 4), h = readInt(header, 8);
                JSONObject msg = new JSONObject();
                msg.put("type", "phone-size");
                msg.put("width", w);
                msg.put("height", h);
                sink.sendJson(msg);
                continue;
            }
            boolean config = (header[0] & 0x40) != 0;
            boolean key = (header[0] & 0x20) != 0;
            int size = readInt(header, 8);
            if (size < 0 || size > (16 << 20)) throw new IOException("bad packet size " + size);
            byte[] packet = new byte[size + 1];
            packet[0] = (byte) (config ? 1 : key ? 2 : 3);
            in.readFully(packet, 1, size);
            sink.sendPacket(packet);
        }
    }

    private static int readInt(byte[] b, int off) {
        return ((b[off] & 0xff) << 24) | ((b[off + 1] & 0xff) << 16) | ((b[off + 2] & 0xff) << 8) | (b[off + 3] & 0xff);
    }

    /** Raw scrcpy control message from the page. */
    void send(byte[] msg) {
        OutputStream out = controlOut;
        if (out == null) return;
        try {
            synchronized (this) { out.write(msg); out.flush(); }
        } catch (IOException e) {
            Log.w(TAG, "control write failed", e);
        }
    }

    void launch(String pkg) {
        byte[] name = pkg.getBytes();
        if (name.length > 255) return;
        byte[] msg = new byte[2 + name.length];
        msg[0] = 16; // TYPE_START_APP
        msg[1] = (byte) name.length;
        System.arraycopy(name, 0, msg, 2, name.length);
        send(msg);
    }

    boolean running() { return controlOut != null; }

    void stop() {
        session++;
        boolean had = process != null || socket != null;
        cleanup();
        if (had) status("stopped", null);
    }

    private void cleanup() {
        controlOut = null;
        Socket s = socket; socket = null;
        if (s != null) try { s.close(); } catch (IOException ignored) { }
        Process p = process; process = null;
        if (p != null) p.destroy();
    }

    private void status(String state, String detail) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", "phone-state");
            msg.put("state", state);
            if (detail != null) msg.put("detail", detail);
            sink.sendJson(msg);
        } catch (Exception ignored) { }
    }

    private static void drainLog(InputStream in) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[4096];
            try {
                int n;
                while ((n = in.read(buf)) > 0) Log.i(TAG, new String(buf, 0, n).trim());
            } catch (IOException ignored) { }
        }, "lumen-phone-log");
        t.setDaemon(true);
        t.start();
    }
}
