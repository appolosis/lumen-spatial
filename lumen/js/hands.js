// Hand tracking on the passthrough camera. While a hand is in view it becomes the pointer:
// the cursor sits where your hand is, and pinching clicks.
import * as THREE from 'three';

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const PINCH_ON = 0.30, PINCH_OFF = 0.45;

export function createHands({ video, onPinchStart, onPinchEnd, onStatus }) {
  let worker = null, ready = false, busy = false, enabled = false, lastSend = 0;
  let pinching = false, lastResultT = 0;
  let hands = [];
  let pendingCamT = 0;
  // Pointer: a smoothed point between the thumb tip and index fingertip. Those tips move as you
  // pinch, so while the fingers are closing the pointer is nearly frozen; the click lands where
  // you were pointing before you started to pinch.
  let pointer = null;           // { x, y, camT, side, t }
  const overlay = document.createElement('canvas');
  overlay.width = 512; overlay.height = 288;
  const octx = overlay.getContext('2d');
  const texture = new THREE.CanvasTexture(overlay);
  texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;

  function start() {
    enabled = true;
    if (worker) return;
    worker = new Worker('js/hands-worker.js?v=13');
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'ready') { ready = true; onStatus?.(`Hand tracking on (${m.delegate})`); }
      else if (m.type === 'error') { onStatus?.('Hand tracking failed to load'); console.warn('hands', m.error); }
      else if (m.type === 'result') { busy = false; handleResult(m.hands); }
    };
    worker.onerror = e => { console.warn('hands worker', e.message); onStatus?.('Hand tracking failed to load'); };
    worker.postMessage({ type: 'init', base: new URL('./', location.href).href });
  }
  function stop() {
    enabled = false;
    worker?.terminate(); worker = null; ready = false; busy = false;
    if (pinching) { pinching = false; onPinchEnd?.(); }
    hands = []; pointer = null; draw();
  }

  // camT: when the camera frame being sent was captured, so the pointer can use the head pose of
  // that moment and stay put while you turn your head.
  async function pump(now, camT) {
    if (!enabled || !ready || busy || !video.videoWidth || video.readyState < 2) return;
    if (now - lastSend < 30) return;          // ~30 Hz is plenty for pinch
    busy = true; lastSend = now; pendingCamT = camT || now;
    try {
      const w = 640, h = Math.round(640 * video.videoHeight / video.videoWidth);
      const bitmap = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
      if (!worker) { bitmap.close(); return; }
      worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]);
    } catch { busy = false; }
  }

  function pinchRatio(pts, aspect) {
    const d = (a, b) => Math.hypot((pts[a][0] - pts[b][0]) * aspect, pts[a][1] - pts[b][1]);
    const size = d(0, 9) || 1e-3;
    return d(4, 8) / size;
  }

  function handSize(pts, aspect) { return Math.hypot((pts[0][0] - pts[9][0]) * aspect, pts[0][1] - pts[9][1]); }

  function handleResult(list) {
    const now = performance.now();
    lastResultT = now;
    const aspect = video.videoWidth / video.videoHeight || 16 / 9;
    hands = list.map(h => ({ ...h, ratio: pinchRatio(h.pts, aspect), size: handSize(h.pts, aspect) }));

    // Keep following the same hand; otherwise take the biggest (closest) one.
    let main = pointer && hands.find(h => h.side === pointer.side);
    if (!main) main = hands.reduce((a, b) => (!a || b.size > a.size ? b : a), null);
    if (main) {
      const rx = (main.pts[4][0] + main.pts[8][0]) / 2, ry = (main.pts[4][1] + main.pts[8][1]) / 2;
      if (pointer && pointer.side === main.side && now - pointer.t < 300) {
        // simple adaptive smoothing: steady when still, responsive when moving
        const speed = Math.hypot(rx - pointer.x, ry - pointer.y);
        let a = Math.min(0.85, 0.2 + speed * 12);
        // fingers closing in on a pinch: hold the pointer (nearly) still
        const closing = !pinching && main.ratio < 0.8 && main.ratio < (pointer.ratio ?? 9) - 0.02;
        if (closing) a = 0.04;
        pointer = { x: pointer.x + (rx - pointer.x) * a, y: pointer.y + (ry - pointer.y) * a, camT: pendingCamT, side: main.side, t: now, ratio: main.ratio };
      } else {
        pointer = { x: rx, y: ry, camT: pendingCamT, side: main.side, t: now, ratio: main.ratio };
      }
    } else {
      pointer = null;
    }

    const closed = !!main && main.ratio < (pinching ? PINCH_OFF : PINCH_ON);
    if (closed && !pinching) { pinching = true; onPinchStart?.(); }
    else if (!closed && pinching) { pinching = false; onPinchEnd?.(); }
    draw();
  }

  function draw() {
    const W = overlay.width, H = overlay.height;
    octx.clearRect(0, 0, W, H);
    for (const h of hands) {
      const p = h.pts.map(([x, y]) => [x * W, y * H]);
      const closed = h.ratio < PINCH_OFF && pinching;
      octx.lineWidth = 2.5; octx.lineCap = 'round';
      octx.strokeStyle = 'rgba(255,255,255,0.55)';
      octx.beginPath();
      for (const [a, b] of BONES) { octx.moveTo(p[a][0], p[a][1]); octx.lineTo(p[b][0], p[b][1]); }
      octx.stroke();
      octx.fillStyle = 'rgba(255,255,255,0.9)';
      for (const [x, y] of p) { octx.beginPath(); octx.arc(x, y, 2.6, 0, Math.PI * 2); octx.fill(); }
      // pinch indicator between thumb and index tips
      const mx = (p[4][0] + p[8][0]) / 2, my = (p[4][1] + p[8][1]) / 2;
      octx.beginPath(); octx.arc(mx, my, closed ? 9 : 6, 0, Math.PI * 2);
      octx.fillStyle = closed ? 'rgba(140,175,255,0.95)' : 'rgba(140,175,255,0.35)';
      octx.fill();
    }
    texture.needsUpdate = true;
  }

  return {
    start, stop, pump, texture,
    get active() { return enabled && ready; },
    get visible() { return hands.length > 0 && performance.now() - lastResultT < 400; },
    get pinching() { return pinching; },
    get pointer() { return pointer && performance.now() - pointer.t < 350 ? pointer : null; },
    // drop stale hands if results stop arriving (e.g. camera paused)
    tick(now) { if (hands.length && now - lastResultT > 500) { hands = []; pointer = null; if (pinching) { pinching = false; onPinchEnd?.(); } draw(); } },
  };
}
