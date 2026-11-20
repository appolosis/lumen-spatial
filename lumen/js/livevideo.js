// Video -> WebGL texture that keeps updating everywhere, including Android WebView.
//
// three's VideoTexture only refreshes from requestVideoFrameCallback. WebView (and some Chrome
// builds) never fire that for a <video> that isn't on screen, so the texture stays black even
// though the video is playing (a 2D canvas can still draw it, which is why photo capture works).
// Some WebViews also upload video frames to WebGL as all black. So:
//  - videos are parked in a tiny on-page box so the browser keeps presenting frames,
//  - the texture is refreshed manually whenever the callback isn't firing,
//  - "canvas" mode copies each frame through a 2D canvas, which works wherever capture works.
import * as THREE from 'three';

let mode = 'direct';            // 'direct' | 'canvas'
const all = new Set();

let parking = null;
export function parkVideo(video) {
  if (!parking) {
    parking = document.createElement('div');
    parking.setAttribute('aria-hidden', 'true');
    parking.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(parking);
  }
  video.style.cssText = 'width:4px;height:4px';
  if (video.parentNode !== parking) parking.appendChild(video);
}

export function setVideoMode(m) {
  if (m === mode) return;
  mode = m;
  for (const lv of all) lv.dirty = true;
}
export const videoMode = () => mode;

export class LiveVideo {
  constructor(video, maxWidth = 1920) {
    this.video = video;
    this.maxWidth = maxWidth;
    this.direct = new THREE.VideoTexture(video);
    this.direct.generateMipmaps = false;
    this.direct.minFilter = THREE.LinearFilter;
    this.canvas = null; this.ctx = null; this.canvasTex = null;
    this.lastCallback = 0; this.newFrame = false; this.lastTime = -1; this.lastUpload = 0;
    this.watching = false;
    parkVideo(video);
    this.watch();
    all.add(this);
  }
  // Re-arm after the source changes (camera restart, new movie).
  watch() {
    const v = this.video;
    if (this.watching || !v.requestVideoFrameCallback) return;
    this.watching = true;
    const cb = () => {
      this.lastCallback = performance.now(); this.newFrame = true;
      if (all.has(this)) v.requestVideoFrameCallback(cb); else this.watching = false;
    };
    v.requestVideoFrameCallback(cb);
  }
  get texture() { return mode === 'canvas' ? this._canvasTexture() : this.direct; }
  _canvasTexture() {
    const v = this.video;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.canvasTex = new THREE.CanvasTexture(this.canvas);
      this.canvasTex.generateMipmaps = false; this.canvasTex.minFilter = THREE.LinearFilter;
    }
    if (v.videoWidth) {
      const s = Math.min(1, this.maxWidth / v.videoWidth);
      const w = Math.round(v.videoWidth * s), h = Math.round(v.videoHeight * s);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
        this.canvasTex.dispose();   // size changed: let three reallocate the GPU texture
      }
    }
    return this.canvasTex;
  }
  update(now) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    const callbacksWork = now - this.lastCallback < 200;
    let fresh;
    if (callbacksWork) fresh = this.newFrame;
    else fresh = (v.currentTime !== this.lastTime || !!v.srcObject) && now - this.lastUpload > 15;
    if (!fresh && !this.dirty) return;
    this.newFrame = false; this.dirty = false;
    this.lastTime = v.currentTime; this.lastUpload = now;
    if (mode === 'canvas') {
      const tex = this._canvasTexture();
      this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
      tex.needsUpdate = true;
    } else if (!callbacksWork) {
      this.direct.needsUpdate = true;
    }
  }
  dispose() {
    all.delete(this);
    this.direct.dispose(); this.canvasTex?.dispose();
  }
}

export function updateAllVideos(now) { for (const lv of all) lv.update(now); }

// Checks whether WebGL actually receives the camera picture. Renders the direct texture into a
// tiny target and reads it back; if it's black while a 2D canvas sees a real image, the browser
// can't upload video to WebGL, so switch to canvas mode.
export function createProbe(renderer) {
  const rt = new THREE.WebGLRenderTarget(8, 8);
  const uniforms = { map: { value: null } };
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }',
  }));
  quad.frustumCulled = false;
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const px = new Uint8Array(8 * 8 * 4);
  const c2 = document.createElement('canvas'); c2.width = 8; c2.height = 8;
  const ctx2 = c2.getContext('2d', { willReadFrequently: true });

  // returns 'ok' | 'black' | 'unknown'
  return function probe(lv) {
    const v = lv.video;
    if (v.readyState < 2 || !v.videoWidth) return 'unknown';
    let cpu = 0;
    try {
      ctx2.drawImage(v, 0, 0, 8, 8);
      const d = ctx2.getImageData(0, 0, 8, 8).data;
      for (let i = 0; i < d.length; i += 4) cpu += d[i] + d[i + 1] + d[i + 2];
    } catch { return 'unknown'; }
    if (cpu < 64 * 3 * 6) return 'unknown';      // the camera itself sees darkness: can't judge
    lv.direct.needsUpdate = true;
    uniforms.map.value = lv.direct;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, px);
    renderer.setRenderTarget(prev);
    let gl = 0;
    for (let i = 0; i < px.length; i += 4) gl += px[i] + px[i + 1] + px[i + 2];
    return gl < cpu * 0.05 ? 'black' : 'ok';
  };
}
