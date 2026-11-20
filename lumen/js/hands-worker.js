// Classic worker: runs MediaPipe hand landmarks off the render thread.
self.exports = {};
self.module = { exports: self.exports };
importScripts('../vendor/mediapipe/vision_bundle.js?v=18');
const { FilesetResolver, HandLandmarker } = self.exports;

let landmarker = null;
let fileset = null;
let base = '';
let delegate = 'GPU';

function options(d) {
  return {
    baseOptions: { modelAssetPath: base + 'vendor/mediapipe/hand_landmarker.task', delegate: d },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

async function create(d) {
  landmarker?.close?.();
  landmarker = await HandLandmarker.createFromOptions(fileset, options(d));
  delegate = d;
}

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') {
    base = m.base;
    try {
      fileset = await FilesetResolver.forVisionTasks(base + 'vendor/mediapipe/wasm');
      try { await create('GPU'); } catch { await create('CPU'); }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', error: String(err && err.message || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    let hands = [];
    try {
      if (landmarker) {
        const res = landmarker.detectForVideo(m.bitmap, m.ts);
        hands = res.landmarks.map((l, i) => ({
          pts: l.map(p => [p.x, p.y]),
          side: res.handedness?.[i]?.[0]?.categoryName || '',
        }));
      }
    } catch (err) {
      // GPU path can fail on some drivers mid-run: fall back to CPU once.
      if (delegate === 'GPU') { try { await create('CPU'); self.postMessage({ type: 'ready', delegate }); } catch { /* keep going */ } }
    }
    m.bitmap.close();
    self.postMessage({ type: 'result', hands, ts: m.ts });
  }
};
