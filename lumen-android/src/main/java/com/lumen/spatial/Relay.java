package com.lumen.spatial;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Runs in a shell-privileged process (started through Shizuku with app_process), next to the
 * scrcpy server. It bridges scrcpy's local sockets to Lumen over a loopback TCP connection,
 * because a normal app may not be allowed to connect to a shell process's unix sockets.
 *
 * Usage: app_process / com.lumen.spatial.Relay <scid-hex> <port>
 * The first line on stdin is a one-time secret; the TCP client must send the same line first.
 * Any app on the phone can reach 127.0.0.1, so without the secret nothing is relayed.
 *
 * Stream to the client: scrcpy's video socket, byte for byte (dummy byte stripped).
 * Stream from the client: scrcpy control messages, forwarded to the control socket.
 */
public final class Relay {
    private Relay() { }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) { System.err.println("usage: Relay <scid> <port>"); System.exit(2); }
        String socketName = "scrcpy_" + args[0];
        int port = Integer.parseInt(args[1]);

        BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String secret = stdin.readLine();
        if (secret == null || secret.length() < 16) { System.err.println("no secret"); System.exit(2); }

        // Give up if nobody shows up, so a failed start never leaves this running.
        Thread watchdog = new Thread(() -> {
            try { Thread.sleep(30000); } catch (InterruptedException e) { return; }
            System.err.println("relay: no client, exiting");
            System.exit(3);
        });
        watchdog.setDaemon(true);
        watchdog.start();

        Socket client;
        try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
            while (true) {
                Socket s = server.accept();
                s.setTcpNoDelay(true);
                String line = readLine(s.getInputStream());
                if (secret.equals(line)) { client = s; break; }
                s.close(); // wrong secret: ignore and keep waiting
            }
        }
        watchdog.interrupt();

        LocalSocket video = connectWithRetry(socketName);
        LocalSocket control = connectWithRetry(socketName);

        InputStream videoIn = video.getInputStream();
        if (videoIn.read() < 0) throw new IOException("scrcpy closed"); // dummy byte

        OutputStream clientOut = client.getOutputStream();
        InputStream clientIn = client.getInputStream();
        OutputStream controlOut = control.getOutputStream();
        InputStream controlIn = control.getInputStream();

        clientOut.write('K'); // tell the client the session is up
        clientOut.flush();

        Thread up = new Thread(() -> pump(clientIn, controlOut), "relay-control");
        Thread drain = new Thread(() -> pump(controlIn, null), "relay-device-msgs");
        up.setDaemon(true); drain.setDaemon(true);
        up.start(); drain.start();
        pump(videoIn, clientOut);
        System.exit(0);
    }

    private static LocalSocket connectWithRetry(String name) throws IOException, InterruptedException {
        IOException last = null;
        for (int i = 0; i < 100; i++) {
            LocalSocket s = new LocalSocket();
            try {
                s.connect(new LocalSocketAddress(name));
                return s;
            } catch (IOException e) {
                last = e;
                s.close();
                Thread.sleep(100);
            }
        }
        throw last;
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 256; i++) {
            int c = in.read();
            if (c < 0 || c == '\n') break;
            sb.append((char) c);
        }
        return sb.toString().trim();
    }

    // Copy until either side closes, then end the whole process so scrcpy shuts down too.
    private static void pump(InputStream in, OutputStream out) {
        byte[] buf = new byte[1 << 16];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                if (out != null) { out.write(buf, 0, n); out.flush(); }
            }
        } catch (IOException ignored) {
        }
        System.exit(0);
    }
}
