// Lumen Spatial: phone-in-headset spatial computer.
import * as THREE from 'three';
import { Panel, Surface, PX_PER_M, text, rr } from './ui.js?v=14';
import { createApps } from './apps.js?v=14';
import { createSky } from './env.js?v=14';
import { createHands } from './hands.js?v=14';
import { createJellyfin } from './jellyfin.js?v=14';
import { LiveVideo, updateAllVideos, createProbe, setVideoMode, videoMode } from './livevideo.js?v=14';
import { createPhone } from './phone.js?v=14';

THREE.ColorManagement.enabled = false;
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

// ---------- settings ----------
const DEFAULTS = { ipd: 63, fov: 90, distortion: 0.22, lensOffset: 0, ptZoom: 1.0, ptSync: 0, panelDist: 1.6, dwellOn: true, dwell: 1.0, tracking: 'sensor', hands: true };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const settings = Object.assign({}, DEFAULTS, store.get('lumen.settings') || {});

// ---------- renderer ----------
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.autoClear = false;
renderer.setClearColor(0x000000, 1);
const PR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PR);

const scene = new THREE.Scene();
const head = new THREE.Object3D();
scene.add(head);
const eyes = [new THREE.PerspectiveCamera(90, 1, 0.05, 200), new THREE.PerspectiveCamera(90, 1, 0.05, 200)];
const monoCam = new THREE.PerspectiveCamera(70, 1, 0.05, 200);
head.add(eyes[0], eyes[1], monoCam);

const sky = createSky();
scene.add(sky.mesh);

// ---------- camera passthrough ----------
const camVideo = document.createElement('video');
camVideo.playsInline = true; camVideo.muted = true; camVideo.setAttribute('playsinline', '');
let camStream = null;
const liveCam = new LiveVideo(camVideo, 1920);
// The Android app's WebView can't upload video straight to WebGL, so copy through a canvas there.
if (window.__lumenNative) setVideoMode('canvas');
let probe = null, probeState = null;

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
    });
    camVideo.srcObject = camStream;
    await camVideo.play();
    liveCam.watch();
    watchCameraFrames();
    probeState = { next: performance.now() + 1200, tries: 0, ok: 0 };
    return true;
  } catch (e) { console.warn('camera', e); return false; }
}
function stopCamera() { camStream?.getTracks().forEach(t => t.stop()); camStream = null; camVideo.srcObject = null; }
const hasCamera = () => camVideo.videoWidth > 0 && !!camStream;

// Pose of the head when the current camera frame was captured. The camera lags the gyro,
// so the passthrough image is rotated back to where it was taken ("timewarp"). That keeps the
// room locked in place under the floating windows while you move your head.
const poseHist = [];
let camFrameT = 0;
function recordPose(t) {
  const last = poseHist[poseHist.length - 1];
  const e = poseHist.length >= 300 ? poseHist.shift() : { t: 0, q: new THREE.Quaternion() };
  e.t = t; e.q.copy(head.quaternion);
  if (last && last.t === t) poseHist.pop();
  poseHist.push(e);
}
function poseAt(t, out) {
  const n = poseHist.length;
  if (!n) return out.copy(head.quaternion);
  if (t <= poseHist[0].t) return out.copy(poseHist[0].q);
  if (t >= poseHist[n - 1].t) return out.copy(poseHist[n - 1].q);
  let i = n - 1;
  while (i > 0 && poseHist[i - 1].t > t) i--;
  const a = poseHist[i - 1], b = poseHist[i];
  return out.copy(a.q).slerp(b.q, (t - a.t) / Math.max(1e-3, b.t - a.t));
}
function watchCameraFrames() {
  if (!camVideo.requestVideoFrameCallback) return;
  const cb = (now, meta) => {
    let t = meta.captureTime;
    if (!(t > 0) || Math.abs(t - now) > 1000) t = (meta.presentationTime || now) - 45;
    camFrameT = t - settings.ptSync;
    if (camStream) camVideo.requestVideoFrameCallback(cb);
  };
  camVideo.requestVideoFrameCallback(cb);
}

const quadVert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const bgU = {
  map: { value: liveCam.direct }, overlay: { value: null }, has: { value: 0 }, hasOverlay: { value: 0 },
  uvScale: { value: new THREE.Vector2(1, 1) }, zoom: { value: 1 }, flash: { value: 0 },
  tanHalf: { value: new THREE.Vector2(1, 1) }, delta: { value: new THREE.Matrix3() },
};
const bgMat = new THREE.ShaderMaterial({
  uniforms: bgU, vertexShader: quadVert, depthTest: false, depthWrite: false,
  fragmentShader: `
    uniform sampler2D map, overlay; uniform float has, hasOverlay, zoom, flash;
    uniform vec2 uvScale, tanHalf; uniform mat3 delta; varying vec2 vUv;
    void main(){
      vec3 c = vec3(0.0);
      if (has < 0.5) {
        c = mix(vec3(0.05,0.05,0.06), vec3(0.13,0.13,0.15), vUv.y);
      } else {
        // view ray now -> view ray at capture time -> camera image coords
        vec3 d = delta * vec3((vUv * 2.0 - 1.0) * tanHalf, -1.0);
        if (d.z < -0.05) {
          vec2 n = (d.xy / -d.z) / tanHalf;
          vec2 uv = n * 0.5 * uvScale / zoom + 0.5;
          vec2 e = smoothstep(vec2(-0.02), vec2(0.0), uv) * smoothstep(vec2(-0.02), vec2(0.0), 1.0 - uv);
          vec2 uc = clamp(uv, 0.0, 1.0);
          c = texture2D(map, uc).rgb;
          if (hasOverlay > 0.5) { vec4 o = texture2D(overlay, uc); c = mix(c, o.rgb, o.a); }
          c *= e.x * e.y;
        }
      }
      gl_FragColor = vec4(mix(c, vec3(1.0), flash), 1.0);
    }`,
});
const bgScene = new THREE.Scene();
const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
bgQuad.frustumCulled = false;
bgScene.add(bgQuad);
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const _qCap = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
// The camera is only "on your head" when real head tracking moves the view (phone in a
// headset). Looking around with the mouse / arrow keys moves the view but not the webcam, so
// rotating the camera image to match would just make it drag and lag behind.
let cameraOnHead = false;
// Never reach further back than this, so a slow or stalling camera can't make the image trail.
const MAX_CAMERA_LAG_MS = 150;
function cameraTime(t) { const now = performance.now(); return Math.max(t, now - MAX_CAMERA_LAG_MS); }

function updateBgPose() {
  // delta = (head at capture)^-1 * (head now): turns a view ray today into one in the old frame
  if (cameraOnHead && camFrameT > 0 && hasCamera()) {
    poseAt(cameraTime(camFrameT), _qCap).invert().multiply(head.quaternion);
    bgU.delta.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_qCap));
  } else bgU.delta.value.identity();
}
function updateBg(viewAspect, fovDeg) {
  const tv = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  bgU.tanHalf.value.set(tv * viewAspect, tv);
  bgU.has.value = hasCamera() ? 1 : 0;
  bgU.zoom.value = settings.ptZoom;
  if (camVideo.videoWidth) {
    const va = camVideo.videoWidth / camVideo.videoHeight;
    if (viewAspect > va) bgU.uvScale.value.set(1, va / viewAspect);
    else bgU.uvScale.value.set(viewAspect / va, 1);
  }
}

// ---------- lens distortion ----------
const distU = { tDiffuse: { value: null }, k1: { value: 0 }, k2: { value: 0 }, aspect: { value: 1 }, center: { value: new THREE.Vector2(0.5, 0.5) }, fit: { value: 1 } };
const distScene = new THREE.Scene();
const distQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: distU, vertexShader: quadVert, depthTest: false, depthWrite: false,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float k1, k2, aspect, fit; uniform vec2 center; varying vec2 vUv;
    void main(){
      vec2 p = (vUv - center) * 2.0; p.x *= aspect;
      float r2 = dot(p, p);
      vec2 q = p * (1.0 + k1*r2 + k2*r2*r2) * fit;
      q.x /= aspect;
      vec2 uv = q * 0.5 + 0.5;
      vec2 e = smoothstep(vec2(0.0), vec2(0.01), uv) * smoothstep(vec2(0.0), vec2(0.01), 1.0 - uv);
      gl_FragColor = vec4(texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb * e.x * e.y, 1.0);
    }`,
}));
distQuad.frustumCulled = false;
distScene.add(distQuad);
let eyeRT = [];

// ---------- head tracking ----------
const qRaw = new THREE.Quaternion();
const qTmp = new THREE.Quaternion();
let orientSensor = null;
// The display runs at up to 144 Hz but sensors report at ~60-120 Hz. Holding the last reading
// makes the view step and judder, so each frame extrapolates from the last two readings.
function makeTrack() { return { prev: new THREE.Quaternion(), last: new THREE.Quaternion(), tPrev: 0, tLast: 0 }; }
const trackSensor = makeTrack(), trackDOE = makeTrack();
function pushReading(tr, q, t) {
  if (t <= tr.tLast) t = tr.tLast + 0.5;
  tr.prev.copy(tr.last); tr.tPrev = tr.tLast;
  tr.last.copy(q); tr.tLast = t;
}
function predict(tr, now, out) {
  out.copy(tr.last);
  const span = tr.tLast - tr.tPrev;
  if (!tr.tPrev || span < 2 || span > 60) return out;
  const ahead = Math.min(now - tr.tLast, 34);
  if (ahead <= 0) return out;
  // only extrapolate real motion, so the view stays rock steady when you hold still
  if (tr.prev.angleTo(tr.last) / span < 0.00012) return out;
  return out.copy(tr.prev).slerp(tr.last, 1 + ahead / span);
}
const sensorTime = () => trackSensor.tLast, doeTime = () => trackDOE.tLast;
let manualYaw = 0, manualPitch = 0, yawOffset = 0;
const WORLD_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _euler = new THREE.Euler(), _q0 = new THREE.Quaternion(), _zee = new THREE.Vector3(0, 0, 1);

function onDeviceOrientation(e) {
  if (e.alpha == null) return;
  const d = THREE.MathUtils.DEG2RAD;
  const orient = ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * d;
  _euler.set(e.beta * d, e.alpha * d, -e.gamma * d, 'YXZ');
  qTmp.setFromEuler(_euler).multiply(WORLD_FIX).multiply(_q0.setFromAxisAngle(_zee, -orient));
  const t = e.timeStamp > 0 && Math.abs(e.timeStamp - performance.now()) < 1000 ? e.timeStamp : performance.now();
  pushReading(trackDOE, qTmp, t);
}

function startSensors() {
  addEventListener('deviceorientation', onDeviceOrientation);
  if ('RelativeOrientationSensor' in window && !orientSensor) {
    try {
      const s = new window.RelativeOrientationSensor({ frequency: 120, referenceFrame: 'screen' });
      s.addEventListener('reading', () => {
        const q = s.quaternion;
        if (!q) return;
        qTmp.set(q[0], q[1], q[2], q[3]).premultiply(WORLD_FIX);
        const ts = s.timestamp > 0 && Math.abs(s.timestamp - performance.now()) < 1000 ? s.timestamp : performance.now();
        pushReading(trackSensor, qTmp, ts);
      });
      s.addEventListener('error', e => console.warn('orientation sensor', e.error && e.error.name));
      s.start();
      orientSensor = s;
    } catch (e) { console.warn('orientation sensor unavailable', e); }
  }
}
function stopSensors() {
  removeEventListener('deviceorientation', onDeviceOrientation);
  try { orientSensor?.stop(); } catch { /* ignore */ }
  orientSensor = null;
}
function trackingSource(now) {
  if (settings.tracking !== 'legacy' && now - sensorTime() < 300) return 'sensor';
  if (now - doeTime() < 500) return 'doe';
  return 'manual';
}
function updateHead(now) {
  const src = trackingSource(now);
  if (src === 'sensor') predict(trackSensor, now, qRaw);
  else if (src === 'doe') predict(trackDOE, now, qRaw);
  else qRaw.setFromEuler(_euler.set(manualPitch, manualYaw, 0, 'YXZ'));
  head.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yawOffset).multiply(qRaw);
  head.updateMatrixWorld(true);
  recordPose(now);
  return src;
}
function recenter() {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(qRaw);
  yawOffset = -Math.atan2(-f.x, -f.z);
  orbYaw = 0;
}

// Recenter = bring your windows to where you're looking. The window you used last (or the
// game / movie screen) lands straight ahead; the others swing around with it.
let lastUsedPanel = null;
function recenterContent() {
  const live = panels.filter(p => !p.closing);
  if (!live.length) { recenter(); return; }
  const yawOf = p => Math.atan2(-p.group.position.x, -p.group.position.z);
  const gy = gazeYaw();
  const main = (lastUsedPanel && live.includes(lastUsedPanel) && lastUsedPanel)
    || live.find(p => p.app.id === 'phone') || live.find(p => p.app.id === 'cinema')
    || live.reduce((a, b) => (Math.abs(wrapAngle(yawOf(a) - gy)) <= Math.abs(wrapAngle(yawOf(b) - gy)) ? a : b));
  const rot = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, wrapAngle(gy - yawOf(main)));
  for (const p of live) { p.group.position.applyQuaternion(rot); p.group.lookAt(ORIGIN); }
  orbYaw = gy;
}

// ---------- gaze helpers ----------
const ORIGIN = new THREE.Vector3();
const gazeDir = new THREE.Vector3(0, 0, -1);
const gazeYaw = () => Math.atan2(-gazeDir.x, -gazeDir.z);
const gazePitch = () => Math.asin(clamp(gazeDir.y, -1, 1));
const sph = (yaw, pitch, dist) => new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist);

// ---------- cursor ----------
const cursorU = { progress: { value: 0 }, hovering: { value: 0 } };
const cursor = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: cursorU, transparent: true, depthTest: false, depthWrite: false,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform float progress, hovering; varying vec2 vUv;
    void main(){
      vec2 p = vUv * 2.0 - 1.0; float r = length(p);
      float dotR = mix(0.28, 0.36, hovering);
      float a = 0.0; vec3 c = vec3(1.0);
      float dotA = smoothstep(dotR + 0.06, dotR, r);
      float edge = smoothstep(dotR + 0.16, dotR + 0.06, r) * (1.0 - dotA);
      a = max(dotA * 0.95, edge * 0.45); c = mix(vec3(0.0), vec3(1.0), dotA);
      if (progress > 0.0) {
        float ang = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
        float ring = smoothstep(0.66, 0.72, r) * smoothstep(0.98, 0.92, r);
        float on = step(ang, progress);
        a = max(a, ring * mix(0.35, 1.0, on));
        c = mix(c, mix(vec3(0.2), vec3(0.62, 0.75, 1.0), on), ring);
      }
      if (a < 0.01) discard;
      gl_FragColor = vec4(c, a);
    }`,
}));
cursor.renderOrder = 1000;
cursor.frustumCulled = false;
scene.add(cursor);

// ---------- home orb ----------
let orbYaw = 0;
const orb = new Surface(120, 120, (ctx, ui) => {
  const hv = ui.hit('home', 0, 0, 120, 120, () => sys.toggleHome());
  const r = hv ? 54 : 44;
  const glow = ctx.createRadialGradient(60, 60, r * 0.5, 60, 60, 60);
  glow.addColorStop(0, 'rgba(140,170,255,0.55)'); glow.addColorStop(1, 'rgba(140,170,255,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(60, 60, 60, 0, Math.PI * 2); ctx.fill();
  const g = ctx.createRadialGradient(48, 44, 2, 60, 60, r);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, '#c3d4ff'); g.addColorStop(0.6, '#6f8dff'); g.addColorStop(1, '#5b38c9');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(60, 60, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { ctx.beginPath(); ctx.arc(46 + i * 14, 46 + j * 14, 3.6, 0, Math.PI * 2); ctx.fill(); }
}, null);
orb.mesh.renderOrder = 10;
scene.add(orb.mesh);

// ---------- toast (head-locked) ----------
let toastMsg = '', toastUntil = 0;
const toastSurf = new Surface(640, 84, ctx => {
  ctx.font = `600 28px system-ui, sans-serif`;
  const w = Math.min(620, ctx.measureText(toastMsg).width + 64);
  rr(ctx, (640 - w) / 2, 6, w, 72, 36);
  ctx.fillStyle = 'rgba(20,22,30,0.85)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 2; ctx.stroke();
  text(ctx, toastMsg, 320, 43, { size: 28, weight: 600, align: 'center' });
}, null);
toastSurf.mesh.position.set(0, -0.32, -1.3);
toastSurf.mesh.renderOrder = 900;
toastSurf.mat.depthTest = false;
head.add(toastSurf.mesh);
function toast(msg, ms = 2200) { toastMsg = msg; toastUntil = performance.now() + ms; toastSurf.dirty = true; showHtmlToast(msg, ms); }
function showHtmlToast(msg, ms) {
  if (stereo && running) return;
  const el = $('#toast'); el.textContent = msg; el.style.display = 'block';
  clearTimeout(showHtmlToast.t); showHtmlToast.t = setTimeout(() => { el.style.display = 'none'; }, ms);
}

// ---------- system API used by apps ----------
const panels = [];
const photos = [];
let movie = null, localMovie = null;
let pendingCapture = null;
let grab = null;
let running = false, stereo = true;
const envState = { index: 0, immersion: 0 };
let savedEnv = null;

const jellyfin = createJellyfin(store);
const phone = createPhone();
let lastPinchT = -1e9;
const hands = createHands({
  video: camVideo,
  onPinchStart: () => pinchStart(),
  onPinchEnd: () => pinchEnd(),
  onStatus: msg => toast(msg),
});
bgU.overlay.value = hands.texture;
function syncHands() {
  if (running && settings.hands && camStream) hands.start(); else hands.stop();
}

const sys = {
  settings, photos, envState, jellyfin, phone,
  openPhone(app) {
    sys.open('phone', { app });
    phone.launch(app.pkg);
    // the launch moves input focus to the hidden display: take it back so the controller works
    for (const t of [1500, 3500, 6000]) setTimeout(() => phone.focusLumen(), t);
  },
  get gameMode() { return gameMode; },
  liveVideo: (v, maxW) => new LiveVideo(v, maxW),
  get movie() { return movie; },
  get stereo() { return stereo; },
  battery: null,
  saveSettings(key) { store.set('lumen.settings', settings); refreshAll(); if (key === 'hands') syncHands(); },
  // Swap what the Cinema plays. Closing the old Cinema window stops the old video.
  playMovie(m) {
    const old = panels.find(p => p.app.id === 'cinema' && !p.closing);
    if (old) sys.close(old);
    movie = m;
    sys.open('cinema');
  },
  clearMovie() { movie = localMovie; },
  async playJellyfin(item) {
    toast('Loading…', 8000);
    try {
      const m = await jellyfin.play(item);
      await m.waitForMeta;
      if (!running) { m.stop(); return; }
      for (const p of panels) if (p.app.id === 'jellyfin' && !p.closing) sys.close(p);
      toastUntil = 0;
      sys.playMovie(m);
    } catch (e) { toast(e.message || 'Could not play that', 4000); }
  },
  resetSettings() { Object.assign(settings, DEFAULTS); store.set('lumen.settings', settings); refreshAll(); toast('Settings reset'); },
  setStereo(v) { stereo = v; document.body.classList.toggle('stereo', v); document.body.classList.toggle('mono', !v); resize(); refreshAll(); },
  recenter() { recenterContent(); toast('Recentered'); },
  markWelcomed() { store.set('lumen.welcomed', true); },
  toast,
  exit: () => exitSpatial(),
  open(id, params = {}) {
    let p = panels.find(q => q.app.id === id && !q.closing);
    if (p) {
      p.app.params = params; p.body.dirty = true;
      placePanel(p, p.app.dist ?? settings.panelDist, false);
      return p;
    }
    const app = apps[id]();
    app.id = id; app.params = params;
    p = new Panel(app, sys);
    app.onOpen?.(p);
    placePanel(p, app.dist ?? settings.panelDist, true);
    p.spawnAt = performance.now();
    p.setOpacity(0);
    scene.add(p.group);
    panels.push(p);
    return p;
  },
  close(p) {
    if (p.closing) return;
    if (grab?.panel === p) releaseGrab();
    p.closing = performance.now();
    p.app.onClose?.(p);
  },
  toggleHome() {
    const h = panels.find(p => p.app.id === 'home' && !p.closing);
    if (h) sys.close(h); else sys.open('home');
  },
  grab(p) {
    grab = { panel: p, dist: p.group.position.length(), lastDir: pointDir.clone(), stillSince: performance.now(), startedAt: performance.now() };
    p.grabbed = true; p.bar.dirty = true;
    clearHover();
  },
  refresh(id) { for (const p of panels) if (p.app.id === id) p.body.dirty = true; },
  capture(cb) { pendingCapture = cb || (() => {}); },
  savePhoto(ph) {
    ph.canvas.toBlob(b => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `lumen-${ph.time.toISOString().replace(/[:.]/g, '-')}.jpg`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Saved to Downloads');
    }, 'image/jpeg', 0.92);
  },
  setEnv(index, immersion) {
    envState.index = index; envState.immersion = index === 0 ? 0 : immersion;
    const front = new THREE.Vector3().copy(gazeDir);
    sky.set(index, envState.immersion, front);
    sys.refresh('environments');
  },
  dimForCinema() { savedEnv = { ...envState }; sys.setEnv(4, 1); },
  restoreEnv() { if (savedEnv) sys.setEnv(savedEnv.index, savedEnv.immersion); savedEnv = null; },
};
const apps = createApps(sys);
navigator.getBattery?.().then(b => { sys.battery = b; }).catch(() => {});

function refreshAll() { for (const p of panels) p.body.dirty = true; }

function placePanel(p, dist, avoid) {
  const yaw = gazeYaw();
  const pitch = clamp(gazePitch(), -0.35, 0.35);
  const offsets = avoid ? [0, 0.6, -0.6, 1.2, -1.2] : [0];
  let pos = sph(yaw, pitch, dist);
  for (const o of offsets) {
    const cand = sph(yaw + o, pitch, dist);
    if (!panels.some(q => q !== p && !q.closing && q.group.position.distanceTo(cand) < 0.7)) { pos = cand; break; }
  }
  p.group.position.copy(pos);
  p.group.lookAt(ORIGIN);
}

// ---------- gaze interaction ----------
const raycaster = new THREE.Raycaster();
let hoverSurf = null, hoverId = null, dwellStart = 0, cooldownUntil = 0, hitPoint = null;

function clearHover() {
  if (hoverSurf) { hoverSurf.hover = null; hoverSurf.dirty = true; }
  hoverSurf = null; hoverId = null;
}
function interactiveMeshes() {
  const list = [orb.mesh];
  for (const p of panels) {
    if (p.closing || p.opacity <= 0.5) continue;
    for (const s of p.surfaces) list.push(s.mesh);
    if (p.touchMeshes) for (const m of p.touchMeshes) list.push(m);
  }
  return list;
}

// ---------- touch surfaces (the phone screen) ----------
// A press while pointing at one puts a finger down there, moving drags it, releasing lifts it.
let hoverTouch = null;           // { mesh, uv }
let touching = null;             // { mesh, source, uv }
const _plane = new THREE.Plane(), _hitP = new THREE.Vector3(), _ray = new THREE.Ray(), _inv = new THREE.Matrix4();
function touchUV(mesh, out) {
  // where the pointer ray crosses the surface's plane (also outside its edges, for drags)
  mesh.updateMatrixWorld();
  _plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld), new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld));
  _ray.set(ORIGIN, pointDir);
  if (!_ray.intersectPlane(_plane, _hitP)) return null;
  _inv.copy(mesh.matrixWorld).invert();
  _hitP.applyMatrix4(_inv);
  const g = mesh.geometry.parameters;
  out.set(clamp(_hitP.x / g.width + 0.5, 0, 1), clamp(_hitP.y / g.height + 0.5, 0, 1));
  return out;
}
function touchBegin(source) {
  if (!hoverTouch || touching) return false;
  touching = { mesh: hoverTouch.mesh, source, uv: hoverTouch.uv.clone() };
  lastUsedPanel = panels.find(p => p.touchMeshes && p.touchMeshes.includes(touching.mesh)) || lastUsedPanel;
  touching.mesh.userData.touch.down(touching.uv);
  navigator.vibrate?.(8);
  return true;
}
function touchUpdate() {
  if (!touching) return;
  if (!touching.mesh.parent) { touching = null; return; }
  const uv = touchUV(touching.mesh, new THREE.Vector2());
  if (uv && uv.distanceToSquared(touching.uv) > 1e-7) { touching.uv.copy(uv); touching.mesh.userData.touch.move(uv); }
}
function touchEnd(source) {
  if (!touching || (source && touching.source !== source)) return false;
  if (touching.mesh.parent) touching.mesh.userData.touch.up(touching.uv);
  touching = null;
  return true;
}
function activate() {
  if (!hoverSurf || hoverId == null) return;
  const e = hoverSurf.elements.find(x => x.id === hoverId);
  const now = performance.now();
  if (hoverSurf.owner && panels.includes(hoverSurf.owner)) lastUsedPanel = hoverSurf.owner;
  cooldownUntil = now + 450; dwellStart = now;
  hoverSurf.dirty = true;
  navigator.vibrate?.(12);
  e?.onSelect?.();
}
function releaseGrab() {
  if (!grab) return;
  grab.panel.grabbed = false; grab.panel.bar.dirty = true;
  grab = null;
  cooldownUntil = performance.now() + 600;
}

// When a hand is in view it aims instead of your gaze: the ray goes from your eye through the
// hand as you see it in the passthrough, so the cursor sits right on your hand.
const pointDir = new THREE.Vector3(0, 0, -1);
const _qHand = new THREE.Quaternion();
let handAiming = false, lastHandT = -1e9;
function handDirection(ptr, out) {
  const aspect = stereo ? (W / 2) / H : W / H;
  const tv = Math.tan(THREE.MathUtils.degToRad(stereo ? settings.fov : 70) / 2), th = tv * aspect;
  let sx = 1, sy = 1;
  if (camVideo.videoWidth) {
    const va = camVideo.videoWidth / camVideo.videoHeight;
    if (aspect > va) sy = va / aspect; else sx = aspect / va;
  }
  // inverse of the passthrough shader's mapping (image coords -> view ray at capture time)
  const nx = (ptr.x - 0.5) * 2 * settings.ptZoom / sx;
  const ny = (0.5 - ptr.y) * 2 * settings.ptZoom / sy;
  out.set(nx * th, ny * tv, -1).normalize();
  return out.applyQuaternion(cameraOnHead && poseHist.length ? poseAt(cameraTime(ptr.camT), _qHand) : head.quaternion);
}

function updateGaze(now, dt) {
  gazeDir.set(0, 0, -1).applyQuaternion(head.quaternion);
  const ptr = hands.pointer;
  handAiming = !!ptr;
  if (ptr) lastHandT = now;
  if (ptr) handDirection(ptr, pointDir); else pointDir.copy(gazeDir);
  let progress = 0;
  hitPoint = null;

  if (grab) {
    const p = grab.panel;
    const dir = pointDir.clone();
    dir.y = clamp(dir.y, -0.6, 0.75); dir.normalize();
    p.group.position.lerp(dir.multiplyScalar(grab.dist), Math.min(1, dt * 14));
    p.group.lookAt(ORIGIN);
    if (pointDir.angleTo(grab.lastDir) > 0.035) { grab.lastDir.copy(pointDir); grab.stillSince = now; }
    const hold = Math.max(700, settings.dwell * 1000);
    if (!grab.byPinch && now - grab.startedAt > 900) {
      progress = clamp((now - grab.stillSince) / hold, 0, 1);
      if (progress >= 1) { releaseGrab(); progress = 0; }
    }
    placeCursor(p.group.position.length() - 0.02, progress, 1);
    return;
  }

  if (touching) {
    // finger is down on a touch surface: keep dragging it, ignore everything else
    touchUpdate();
    const m = touching.mesh;
    const d = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld).length();
    placeCursor(d - 0.01, 0, 1);
    return;
  }
  raycaster.set(ORIGIN, pointDir);
  const hits = raycaster.intersectObjects(interactiveMeshes(), false);
  let surf = null, el = null;
  hoverTouch = null;
  if (hits.length) {
    const h = hits[0];
    hitPoint = h.point;
    if (h.object.userData.touch) hoverTouch = { mesh: h.object, uv: h.uv.clone() };
    else {
      surf = h.object.userData.surface;
      el = h.uv ? surf.hitTest(h.uv) : null;
    }
  }
  const newSurf = el ? surf : null, newId = el ? el.id : null;
  if (newSurf !== hoverSurf || newId !== hoverId) {
    clearHover();
    if (newSurf) { hoverSurf = newSurf; hoverId = newId; newSurf.hover = newId; newSurf.dirty = true; }
    dwellStart = now;
  }
  // While a hand is aiming (and briefly after a pinch), gaze-hold is off so looking around never clicks things.
  const handsMode = handAiming || hands.visible || now - lastPinchT < 3000 || now - lastHandT < 1500;
  // The gaze-hold timer only starts counting once hands are out of the picture, so gaze never
  // "catches up" and clicks the instant your hand drops.
  if (handsMode) dwellStart = now;
  // A button that was already under your gaze when its window appeared doesn't count:
  // you have to look onto it on purpose before holding.
  const armed = hoverSurf && !(hoverSurf.owner?.spawnAt && dwellStart < hoverSurf.owner.spawnAt + 350);
  if (hoverSurf && armed && settings.dwellOn && !handsMode) {
    const t0 = Math.max(dwellStart, cooldownUntil);
    progress = clamp((now - t0) / (settings.dwell * 1000), 0, 1);
    if (progress >= 1) { activate(); progress = 0; }
  }
  placeCursor(hitPoint ? hitPoint.distanceTo(ORIGIN) - 0.01 : 2.5, progress, hoverSurf || hoverTouch ? 1 : 0);
}
// Pinch = select whatever you're looking at (like Vision Pro). Pinch-and-hold the bar under a
// window to carry it; let go to drop it.
function pinchStart() {
  const now = performance.now();
  lastPinchT = now;
  cursorPulse = now;
  if (grab) { releaseGrab(); return; }
  if (touchBegin('hand')) return;
  if (hoverSurf) {
    activate();
    if (grab) grab.byPinch = true;
  }
}
function pinchEnd() {
  lastPinchT = performance.now();
  touchEnd('hand');
  if (grab && grab.byPinch && performance.now() - grab.startedAt > 150) releaseGrab();
}
let cursorPulse = 0;
function placeCursor(dist, progress, active) {
  cursor.position.copy(pointDir).multiplyScalar(dist);
  cursor.quaternion.copy(head.quaternion);
  const pulse = Math.max(0, 1 - (performance.now() - cursorPulse) / 250);
  const base = handAiming ? 0.03 : 0.022;   // a bit bigger when your hand is the pointer
  cursor.scale.setScalar(dist * base * (hands.pinching ? 0.8 : 1 + pulse * 0.4));
  cursorU.progress.value = progress;
  cursorU.hovering.value = active;
}

// ---------- input ----------
let down = null, lastTapT = 0;
// source: 'screen' (headset button / touchscreen), 'key' (keyboard) or 'pad' (controller).
// Only a double tap on the screen recenters; mashing controller buttons never does.
function handleTap(source = 'screen') {
  const now = performance.now();
  if (grab) { releaseGrab(); return; }
  if (hoverSurf) { activate(); lastTapT = 0; return; }
  if (hoverTouch && touchBegin(source)) { setTimeout(() => touchEnd(source), 60); lastTapT = 0; return; }
  if (source !== 'screen') return;
  if (now - lastTapT < 380) { sys.recenter(); lastTapT = 0; }
  else lastTapT = now;
}
canvas.addEventListener('pointerdown', e => {
  down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
  // headset button / screen tap on the phone screen: finger down now, up on release
  if (running && !grab && touchBegin('screen')) down.touch = true;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
canvas.addEventListener('pointermove', e => {
  if (!down || down.touch) return;
  if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) down.moved = true;
  if (down.moved && trackingSource(performance.now()) === 'manual') {
    manualYaw += (e.clientX - down.lx) * 0.005;
    manualPitch = clamp(manualPitch + (e.clientY - down.ly) * 0.005, -1.4, 1.4);
  }
  down.lx = e.clientX; down.ly = e.clientY;
});
canvas.addEventListener('pointerup', () => {
  if (down?.touch) touchEnd('screen');
  else if (down && !down.moved) handleTap();
  down = null;
});
canvas.addEventListener('pointercancel', () => { if (down?.touch) touchEnd('screen'); down = null; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

addEventListener('keydown', e => {
  if (!running) return;
  const k = e.key.toLowerCase();
  if (k === 'enter' || k === ' ') { e.preventDefault(); if (!gameMode) handleTap('key'); }
  else if (k === 'h') sys.toggleHome();
  else if (k === 'r') sys.recenter();
  else if (k === 'escape') exitSpatial();
  else if (k === 'arrowleft') manualYaw += 0.08;
  else if (k === 'arrowright') manualYaw -= 0.08;
  else if (k === 'arrowup') manualPitch = clamp(manualPitch + 0.08, -1.4, 1.4);
  else if (k === 'arrowdown') manualPitch = clamp(manualPitch - 0.08, -1.4, 1.4);
});

// Game mode: while you look or point at a running phone app (and for a moment after), the
// controller is handed to that app as a virtual gamepad and Lumen ignores it.
let gameMode = false, lastPhoneHoverT = -1e9, startHeldSince = 0, lastFocusPull = 0;
const padPrev = {};
function pollGamepads(now) {
  const phoneOpen = phone.running && panels.some(p => p.app.id === 'phone' && !p.closing);
  // Lumen's own virtual pad (the one it creates for the game) shows up here too: skip it.
  const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : [])
    .filter(gp => gp && !(phoneOpen && /X-Box 360 Pad.*045e.*028e/i.test(gp.id)));
  const wasGame = gameMode;
  if (hoverTouch || touching) lastPhoneHoverT = now;
  // Looking at a Lumen button (e.g. the window's ✕) hands the controller back right away.
  if (hoverSurf) lastPhoneHoverT = -1e9;
  gameMode = phoneOpen && now - lastPhoneHoverT < 1500;
  if (gameMode !== wasGame) {
    if (!gameMode) phone.gamepadRelease();
    for (const p of panels) if (p.app.id === 'phone') p.body.dirty = true;
  }
  // Keep Lumen holding input focus while a phone app runs; otherwise the controller stops
  // reaching Lumen (and so the game) after the app starts or gets touched.
  if (phoneOpen && !document.hasFocus() && now - lastFocusPull > 1500) { lastFocusPull = now; phone.focusLumen(); }

  for (const gp of pads) {
    const prev = padPrev[gp.index] || [];
    const b = gp.buttons.map(x => x.pressed);
    padPrev[gp.index] = b;
    if (gameMode) { if (gp === pads[0]) phone.gamepad(gp); continue; }
    if (b[0] && !prev[0] && !touchBegin('pad')) handleTap('pad');
    if (!b[0] && prev[0]) touchEnd('pad');
    if (b[1] && !prev[1]) sys.toggleHome();
    // hold Start for a second to recenter (a tap does nothing, so games can't trigger it)
    if (b[9]) { if (!startHeldSince) startHeldSince = now; else if (startHeldSince > 0 && now - startHeldSince > 900) { sys.recenter(); startHeldSince = -1; } }
    else startHeldSince = 0;
  }
}

// ---------- layout ----------
let W = 1, H = 1;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  renderer.setSize(W, H, false);
  const ew = Math.max(1, Math.round((W / 2) * PR)), eh = Math.max(1, Math.round(H * PR));
  if (!eyeRT.length || eyeRT[0].width !== ew || eyeRT[0].height !== eh) {
    eyeRT.forEach(t => t.dispose());
    eyeRT = [0, 1].map(() => new THREE.WebGLRenderTarget(ew, eh, { samples: 4 }));
  }
}
addEventListener('resize', resize);

// ---------- frame ----------
let lastT = performance.now(), enterT = 0, initialDone = false;

function drawView(cam, aspect) {
  updateBg(aspect, cam.fov);
  renderer.render(bgScene, quadCam);
  renderer.render(scene, cam);
}

function frame() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  const src = updateHead(now);
  cameraOnHead = src !== 'manual';
  if (!initialDone && (src !== 'manual' || now - enterT > 900)) {
    initialDone = true;
    recenter();
    updateHead(now);
    gazeDir.set(0, 0, -1).applyQuaternion(head.quaternion);
    sys.open(store.get('lumen.welcomed') ? 'home' : 'welcome');
  }

  pollGamepads(now);
  updateGaze(now, dt);

  // home orb lazily follows your heading, low in front of you
  const hy = gazeYaw();
  const diff = wrapAngle(hy - orbYaw);
  if (Math.abs(diff) > 0.3) orbYaw += diff * Math.min(1, dt * 2.5);
  orb.mesh.position.copy(sph(orbYaw, -0.78, 0.9));
  orb.mesh.lookAt(ORIGIN);

  // panel open / close animations
  for (let i = panels.length - 1; i >= 0; i--) {
    const p = panels[i];
    if (p.closing) {
      const t = 1 - (now - p.closing) / 180;
      if (t <= 0) { scene.remove(p.group); p.dispose(); panels.splice(i, 1); continue; }
      p.setOpacity(t); p.group.scale.setScalar(0.94 + 0.06 * t);
    } else if (p.opacity < 1) {
      const t = clamp((now - p.spawnAt) / 260, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);
      p.setOpacity(e); p.group.scale.setScalar(0.9 + 0.1 * e);
    }
    if (!p.closing && p.app.tick?.(now)) p.body.dirty = true;
  }

  toastSurf.mesh.visible = now < toastUntil;
  for (const p of panels) for (const s of p.surfaces) if (s.dirty) s.redraw();
  if (orb.dirty) orb.redraw();
  if (toastSurf.dirty) toastSurf.redraw();

  hands.pump(now, camFrameT);
  hands.tick(now);
  updateAllVideos(now);
  bgU.map.value = liveCam.texture;
  // No frame callbacks (WebView): estimate when the camera frame was taken instead.
  if (hasCamera() && now - liveCam.lastCallback > 300) camFrameT = now - 60 - settings.ptSync;
  if (probeState && hasCamera()) checkVideoUpload(now);
  bgU.hasOverlay.value = hands.visible ? 1 : 0;
  updateBgPose();
  sky.update(now / 1000, dt);
  bgU.flash.value = Math.max(0, bgU.flash.value - dt * 3);

  // eyes
  const ipd = settings.ipd / 1000;
  eyes[0].position.set(-ipd / 2, 0, 0);
  eyes[1].position.set(ipd / 2, 0, 0);
  const eyeAspect = (W / 2) / H;
  for (const e of eyes) { e.fov = settings.fov; e.aspect = eyeAspect; e.updateProjectionMatrix(); }
  monoCam.aspect = W / H; monoCam.fov = 70; monoCam.updateProjectionMatrix();

  renderer.setRenderTarget(null);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();

  if (!stereo) {
    drawView(monoCam, W / H);
  } else if (settings.distortion > 0.001) {
    for (let i = 0; i < 2; i++) {
      renderer.setRenderTarget(eyeRT[i]);
      renderer.clear();
      drawView(eyes[i], eyeAspect);
    }
    renderer.setRenderTarget(null);
    const k1 = settings.distortion, k2 = settings.distortion * 0.35;
    distU.k1.value = k1; distU.k2.value = k2; distU.fit.value = 1 / (1 + k1 + k2); distU.aspect.value = eyeAspect;
    for (let i = 0; i < 2; i++) {
      renderer.setViewport(i * W / 2, 0, W / 2, H);
      distU.tDiffuse.value = eyeRT[i].texture;
      distU.center.value.set(i === 0 ? 0.5 + settings.lensOffset : 0.5 - settings.lensOffset, 0.5);
      renderer.render(distScene, quadCam);
    }
  } else {
    renderer.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      renderer.setViewport(i * W / 2, 0, W / 2, H);
      renderer.setScissor(i * W / 2, 0, W / 2, H);
      drawView(eyes[i], eyeAspect);
    }
    renderer.setScissorTest(false);
  }

  if (pendingCapture) doCapture();
  if (window.__lumen.afterFrame) { const f = window.__lumen.afterFrame; window.__lumen.afterFrame = null; f(canvas); }
}

function checkVideoUpload(now) {
  if (videoMode() !== 'direct') { probeState = null; return; }
  if (now < probeState.next) return;
  probe ||= createProbe(renderer);
  const r = probe(liveCam);
  probeState.next = now + 700;
  if (r === 'black') {
    setVideoMode('canvas');
    console.info('Lumen: WebGL video upload is black here, using canvas copy');
    probeState = null;
  } else if (r === 'ok' && ++probeState.ok >= 2) probeState = null;
  else if (++probeState.tries > 15) probeState = null;
}

function doCapture() {
  const cb = pendingCapture; pendingCapture = null;
  let c;
  if (hasCamera()) {
    const vw = camVideo.videoWidth, vh = camVideo.videoHeight, s = Math.min(1, 1600 / vw);
    c = document.createElement('canvas'); c.width = Math.round(vw * s); c.height = Math.round(vh * s);
    c.getContext('2d').drawImage(camVideo, 0, 0, c.width, c.height);
  } else {
    // no camera: grab what you see (left eye in headset view), straight after rendering this frame
    const sw = stereo ? canvas.width / 2 : canvas.width, sh = canvas.height;
    const s = Math.min(1, 1600 / sw);
    c = document.createElement('canvas'); c.width = Math.round(sw * s); c.height = Math.round(sh * s);
    c.getContext('2d').drawImage(canvas, 0, 0, sw, sh, 0, 0, c.width, c.height);
  }
  photos.unshift({ canvas: c, time: new Date() });
  bgU.flash.value = 0.7;
  navigator.vibrate?.(30);
  toast('Photo captured');
  sys.refresh('photos');
  cb();
}

// ---------- enter / exit ----------
let wakeLock = null;
const statusEl = $('#status');
const setStatus = (msg, warn) => { statusEl.textContent = msg; statusEl.className = warn ? 'warn' : ''; };

async function enterSpatial(useStereo) {
  // Calls that need the tap's user activation go first, before any await.
  const fs = document.documentElement.requestFullscreen
    ? document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}) : Promise.resolve();
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().catch(() => {});
  }
  if (movie) movie.video.play().then(() => movie.video.pause()).catch(() => {});

  const camPromise = startCamera();   // permission prompt may sit open; don't block on it
  startSensors();
  navigator.wakeLock?.request('screen').then(l => { wakeLock = l; }).catch(() => {});

  running = true;
  sys.setStereo(useStereo);
  document.body.classList.add('running');
  history.pushState({ lumen: true }, '');
  resize();
  enterT = performance.now(); lastT = enterT; initialDone = false;
  if (envState.index) sky.set(envState.index, envState.immersion);
  setStatus('');
  renderer.setAnimationLoop(frame);

  Promise.race([fs, new Promise(r => setTimeout(r, 1500))]).then(() => {
    if (useStereo && running) screen.orientation?.lock?.('landscape').catch(() => {});
  });
  const camOk = await camPromise;
  if (!running) { stopCamera(); return; }
  if (camOk) syncHands();
  if (!camOk && envState.index === 0) {
    sys.setEnv(1, 1);
    toast(window.isSecureContext ? 'Camera unavailable: showing an environment' : 'Camera needs HTTPS: showing an environment', 3500);
  }
}

function exitSpatial(fromPop) {
  if (!running) return;
  running = false;
  renderer.setAnimationLoop(null);
  releaseGrab(); clearHover();
  for (const p of panels.splice(0)) { p.app.onClose?.(p); scene.remove(p.group); p.dispose(); }
  touchEnd(); phone.stop();
  hands.stop(); stopCamera(); stopSensors();
  poseHist.length = 0; camFrameT = 0;
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
  try { screen.orientation.unlock(); } catch { /* ignore */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.body.classList.remove('running', 'stereo', 'mono');
  if (!fromPop && history.state && history.state.lumen) history.back();
}
addEventListener('popstate', () => exitSpatial(true));
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running) {
    if (!camStream || camStream.getVideoTracks().every(t => t.readyState === 'ended')) { await startCamera(); syncHands(); }
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
  }
});

// ---------- start screen ----------
$('#enterHeadset').addEventListener('click', () => enterSpatial(true));
$('#enterPreview').addEventListener('click', () => enterSpatial(false));
$('#exitbtn').addEventListener('click', () => exitSpatial());
$('#videoFile').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (localMovie) { localMovie.video.pause(); URL.revokeObjectURL(localMovie.video.src); }
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.src = URL.createObjectURL(f);
  localMovie = { video: v, name: f.name.replace(/\.[^.]+$/, '') };
  if (!movie || !movie.stop) movie = localMovie;
  $('#videoName').textContent = f.name;
});
// Jellyfin sign-in (start screen)
function showJellyfinState(msg) {
  $('#jfSignedIn').style.display = jellyfin.connected ? '' : 'none';
  $('#jfForm').style.display = jellyfin.connected ? 'none' : '';
  if (jellyfin.connected) $('#jfWho').textContent = `Signed in as ${jellyfin.userName} on ${jellyfin.serverUrl}`;
  $('#jfStatus').textContent = msg || '';
}
$('#jfForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#jfGo').disabled = true;
  showJellyfinState('Signing in…');
  try {
    await jellyfin.login($('#jfUrl').value, $('#jfUser').value, $('#jfPass').value);
    $('#jfPass').value = '';
    showJellyfinState('Ready. Open the Jellyfin app in the headset.');
  } catch (err) { showJellyfinState(err.message || 'Sign-in failed'); }
  $('#jfGo').disabled = false;
});
$('#jfLogout').addEventListener('click', () => { jellyfin.logout(); showJellyfinState(''); });
// Jellyfin is proxied on the same site at ./jf/, which avoids https and cross-site problems.
// (Not in the Android app: that's published, so it shouldn't point strangers at this server.)
if (!window.__lumenNative) $('#jfUrl').value = new URL('jf', location.href).href;

// Android app download card (website only). Version, size and checksum come from the server so
// they always match the uploaded file.
(async () => {
  const card = $('#apkCard');
  if (!card || window.__lumenNative) return;
  try {
    const info = await (await fetch('/downloads/lumen.json', { cache: 'no-store' })).json();
    const link = $('#apkLink');
    link.href = '/downloads/' + info.file;
    link.setAttribute('download', info.file);
    link.textContent = `Download Lumen ${info.version} for Android (${Math.round(info.size / 1048576)} MB)`;
    $('#apkHash').textContent = info.sha256;
    card.hidden = false;
  } catch { /* no published build: keep the card hidden */ }
})();
showJellyfinState();

if (!window.isSecureContext) setStatus('This page is not on HTTPS, so the camera will be blocked. Open it from an https:// address for passthrough.', true);
resize();

if ('serviceWorker' in navigator && window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  navigator.serviceWorker.register('sw.js?v=14').catch(() => {});
}

// debug hook for testing
window.__lumen = { sys, panels, settings, envState, hands, jellyfin, phone, frame, liveCam, videoMode, setVideoMode, get tracking() { return { poseHist: poseHist.length, camFrameT }; } };
