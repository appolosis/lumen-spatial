// Phone apps inside Lumen (Android app only).
// The native side runs apps on a hidden virtual display (scrcpy through Shizuku) and streams it
// here as H.264. This module decodes it with WebCodecs into a texture and sends touches/keys back
// as scrcpy control messages.
import * as THREE from 'three';

const KEY_HOME = 3, KEY_BACK = 4, KEY_APP_SWITCH = 187;

// Virtual gamepad (same HID descriptor and Xbox 360 identity as scrcpy's own, so Android maps it
// like a real Xbox pad). scrcpy attaches it to the hidden display, so it always reaches the game.
const PAD_ID = 3;
const PAD_DESC = new Uint8Array([
  0x05, 0x01, 0x09, 0x05, 0xA1, 0x01, 0xA1, 0x00,
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x33, 0x09, 0x34,
  0x15, 0x00, 0x27, 0xFF, 0xFF, 0x00, 0x00, 0x75, 0x10, 0x95, 0x04, 0x81, 0x02,
  0x05, 0x01, 0x09, 0x32, 0x09, 0x35, 0x15, 0x00, 0x26, 0xFF, 0x7F, 0x75, 0x10, 0x95, 0x02, 0x81, 0x02,
  0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00, 0x25, 0x01, 0x95, 0x10, 0x75, 0x01, 0x81, 0x02,
  0x05, 0x01, 0x09, 0x39, 0x15, 0x01, 0x25, 0x08, 0x75, 0x04, 0x95, 0x01, 0x81, 0x42,
  0xC0, 0xC0,
]);
// Gamepad API "standard" button index -> HID button bit
const PAD_BUTTONS = { 0: 0x0001, 1: 0x0002, 2: 0x0008, 3: 0x0010, 4: 0x0040, 5: 0x0080, 8: 0x0400, 9: 0x0800, 16: 0x1000, 10: 0x2000, 11: 0x4000 };
const LANDSCAPE = [1920, 1080], PORTRAIT = [1080, 1920], DPI = 320;

export function createPhone() {
  // Checked on use: the Android shell's bridge is injected before the page runs.
  const isAvailable = () => !!(window.__lumenNative && window.LumenNative && typeof window.LumenNative.phoneStart === 'function' && 'VideoDecoder' in window);
  const N = new Proxy({}, { get: (_, k) => (...a) => window.LumenNative[k](...a) });
  const listeners = new Set();
  const state = { shizuku: isAvailable() ? 'unknown' : 'unsupported', phone: 'idle', detail: '', apps: null, width: 0, height: 0, frames: 0 };
  const emit = () => { for (const f of listeners) f(state); };

  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 9;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 16, 9);     // a black screen until the first frame
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;

  // ---------- native channel ----------
  let port = null;
  addEventListener('message', e => {
    if (e.data === 'lumen-native-port' && e.ports && e.ports[0]) {
      port = e.ports[0];
      port.onmessage = onNative;
    }
  });
  setTimeout(() => { if (!port && isAvailable()) N.requestPort(); }, 1500);

  function onNative(e) {
    const d = e.data;
    if (d instanceof ArrayBuffer) { onPacket(new Uint8Array(d)); return; }
    if (typeof d !== 'string') return;
    if (d.startsWith('b:')) { onPacket(Uint8Array.from(atob(d.slice(2)), c => c.charCodeAt(0))); return; }
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.type === 'shizuku') state.shizuku = m.state;
    else if (m.type === 'apps') state.apps = m.apps;
    else if (m.type === 'phone-state') {
      state.phone = m.state; state.detail = m.detail || '';
      if (m.state === 'running') padCreated = false;          // new session: create the gamepad again
      if (m.state !== 'running') resetDecoder();
    } else if (m.type === 'phone-size') { state.width = m.width; state.height = m.height; needKey = true; }
    emit();
  }

  // ---------- H.264 decoding ----------
  let decoder = null, config = null, needKey = true, ts = 0, codecString = '', decoderGen = 0;

  function resetDecoder() {
    try { decoder?.close(); } catch { /* already closed */ }
    decoder = null; config = null; needKey = true; codecString = ''; decoderGen++;
  }

  function avcCodec(bytes) {
    for (let i = 0; i + 7 < bytes.length; i++) {
      const sc4 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
      const sc3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
      const o = sc4 ? i + 4 : sc3 ? i + 3 : -1;
      if (o >= 0 && (bytes[o] & 0x1f) === 7) {
        const h = n => n.toString(16).padStart(2, '0');
        return `avc1.${h(bytes[o + 1])}${h(bytes[o + 2])}${h(bytes[o + 3])}`;
      }
    }
    return 'avc1.640028';
  }

  // Hardware decoding when the device has it, otherwise software.
  async function pickConfig(codec) {
    const hw = { codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
    try { if ((await VideoDecoder.isConfigSupported(hw)).supported) return hw; } catch { /* fall through */ }
    return { codec, optimizeForLatency: true };
  }

  function makeDecoder(cfg) {
    const dec = new VideoDecoder({
      output: frame => {
        const w = frame.displayWidth, h = frame.displayHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w; canvas.height = h;
          texture.dispose();
        }
        ctx.drawImage(frame, 0, 0, w, h);
        frame.close();
        texture.needsUpdate = true;
        state.frames++;
      },
      error: err => {
        console.warn('phone decoder', err);
        resetDecoder();
        send(new Uint8Array([17]));          // ask scrcpy for a fresh config + key frame
      },
    });
    dec.configure(cfg);
    return dec;
  }

  function onPacket(u8) {
    const kind = u8[0], data = u8.subarray(1);
    if (kind === 1) {                          // codec config (SPS/PPS)
      config = data.slice();
      const c = avcCodec(config);
      needKey = true;
      if (!decoder || decoder.state === 'closed' || c !== codecString) {
        codecString = c;
        try { decoder?.close(); } catch { /* ignore */ }
        decoder = null;
        const gen = ++decoderGen;
        pickConfig(c).then(cfg => {
          if (gen !== decoderGen) return;
          try { decoder = makeDecoder(cfg); needKey = true; send(new Uint8Array([17])); } // fresh key frame now
          catch (err) { console.warn('phone decoder config', err); state.detail = 'This phone cannot decode the stream'; emit(); }
        });
      }
      return;
    }
    if (!decoder || decoder.state !== 'configured') return;
    const key = kind === 2;
    if (!key && needKey) return;
    if (!key && decoder.decodeQueueSize > 8) { needKey = true; send(new Uint8Array([17])); return; } // fell behind
    let chunk = data;
    if (key && config) { chunk = new Uint8Array(config.length + data.length); chunk.set(config); chunk.set(data, config.length); }
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (ts += 16667), data: chunk }));
      if (key) needKey = false;
    } catch (err) { console.warn('phone decode', err); needKey = true; }
  }

  // ---------- control messages ----------
  function send(bytes) {
    if (!isAvailable()) return;
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    N.phoneSend(btoa(s));
  }

  // action: 0 down, 1 up, 2 move. x, y in 0..1 of the phone screen.
  function touch(action, x, y) {
    const w = state.width, h = state.height;
    if (!w || !h) return;
    const b = new DataView(new ArrayBuffer(32));
    b.setUint8(0, 2);
    b.setUint8(1, action);
    b.setBigInt64(2, -2n);                     // generic finger
    b.setInt32(10, Math.round(Math.min(1, Math.max(0, x)) * (w - 1)));
    b.setInt32(14, Math.round(Math.min(1, Math.max(0, y)) * (h - 1)));
    b.setUint16(18, w); b.setUint16(20, h);
    b.setUint16(22, action === 1 ? 0 : 0xffff);
    b.setInt32(24, 0); b.setInt32(28, 0);
    send(new Uint8Array(b.buffer));
  }

  function key(code) {
    for (const action of [0, 1]) {
      const b = new DataView(new ArrayBuffer(14));
      b.setUint8(0, 0); b.setUint8(1, action); b.setInt32(2, code); b.setInt32(6, 0); b.setInt32(10, 0);
      send(new Uint8Array(b.buffer));
    }
  }

  // ---------- gamepad ----------
  let padCreated = false, lastPad = '';
  function padCreate() {
    const name = new TextEncoder().encode('Microsoft X-Box 360 Pad');
    const b = new Uint8Array(1 + 2 + 2 + 2 + 1 + name.length + 2 + PAD_DESC.length);
    const v = new DataView(b.buffer);
    let o = 0;
    v.setUint8(o, 12); o += 1;                       // UHID_CREATE
    v.setUint16(o, PAD_ID); o += 2;
    v.setUint16(o, 0x045e); o += 2;
    v.setUint16(o, 0x028e); o += 2;
    v.setUint8(o, name.length); o += 1; b.set(name, o); o += name.length;
    v.setUint16(o, PAD_DESC.length); o += 2; b.set(PAD_DESC, o);
    send(b);
    padCreated = true; lastPad = '';
  }
  function padReport(r) {
    const key = r.join(',');
    if (key === lastPad) return;
    lastPad = key;
    const b = new Uint8Array(1 + 2 + 2 + 15);
    const v = new DataView(b.buffer);
    v.setUint8(0, 13); v.setUint16(1, PAD_ID); v.setUint16(3, 15);   // UHID_INPUT
    b.set(r, 5);
    send(b);
  }
  // Turn a Gamepad API pad (standard mapping) into scrcpy's 15-byte report.
  function padFrom(gp) {
    const r = new Uint8Array(15), v = new DataView(r.buffer);
    const axis = i => { const a = gp.axes[i] || 0; return Math.abs(a) < 0.08 ? 0 : a; };   // small dead zone
    const stick = a => Math.max(0, Math.min(65535, Math.round(a * 32767) + 0x8000));
    v.setUint16(0, stick(axis(0)), true); v.setUint16(2, stick(axis(1)), true);
    v.setUint16(4, stick(axis(2)), true); v.setUint16(6, stick(axis(3)), true);
    const trig = i => Math.round(Math.max(0, Math.min(1, gp.buttons[i]?.value || 0)) * 32767);
    v.setUint16(8, trig(6), true); v.setUint16(10, trig(7), true);
    let bits = 0;
    for (const [i, bit] of Object.entries(PAD_BUTTONS)) if (gp.buttons[i]?.pressed) bits |= bit;
    v.setUint16(12, bits, true);
    const up = gp.buttons[12]?.pressed, down = gp.buttons[13]?.pressed, left = gp.buttons[14]?.pressed, right = gp.buttons[15]?.pressed;
    r[14] = up ? (left ? 8 : right ? 2 : 1) : down ? (left ? 6 : right ? 4 : 5) : left ? 7 : right ? 3 : 0;
    return r;
  }

  return {
    // Forward this pad to the game (call every frame while in game mode).
    gamepad(gp) {
      if (state.phone !== 'running' || !state.width) return;
      if (!padCreated) padCreate();
      padReport(padFrom(gp));
    },
    // Let go of everything (leaving game mode), so no button stays held in the game.
    gamepadRelease() {
      if (!padCreated) return;
      const r = new Uint8Array(15), v = new DataView(r.buffer);
      for (const o of [0, 2, 4, 6]) v.setUint16(o, 0x8000, true);
      padReport(r);
    },
    focusLumen() { if (isAvailable() && typeof window.LumenNative.focusLumen === 'function') N.focusLumen(); },
    get available() { return isAvailable(); }, state, texture,
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    refreshShizuku() { if (isAvailable()) { state.shizuku = N.shizukuState(); emit(); } },
    requestShizuku() { if (isAvailable()) N.requestShizuku(); },
    openShizuku() { if (isAvailable()) N.openShizuku(); },
    loadApps() { if (isAvailable()) N.listApps(); },
    get running() { return state.phone === 'running'; },
    launch(pkg) {
      if (!isAvailable()) return;
      if (state.phone === 'running' && N.phoneRunning()) N.phoneLaunch(pkg);
      else { const [w, h] = LANDSCAPE; N.phoneStart(pkg, w, h, DPI); }
    },
    stop() { if (isAvailable()) N.phoneStop(); },
    touch, back: () => key(KEY_BACK), home: () => key(KEY_HOME), recents: () => key(KEY_APP_SWITCH),
    rotate() {
      const portrait = state.width > state.height;
      const [w, h] = portrait ? PORTRAIT : LANDSCAPE;
      const b = new DataView(new ArrayBuffer(5));
      b.setUint8(0, 21); b.setUint16(1, w); b.setUint16(3, h);
      send(new Uint8Array(b.buffer));
    },
  };
}
