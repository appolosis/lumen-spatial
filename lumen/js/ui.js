// Spatial UI: canvas-drawn glass surfaces mapped onto planes in 3D.
import * as THREE from 'three';

export const PX_PER_M = 600;          // design pixels per metre
const RES = 1.8;                      // texture pixels per design pixel
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function font(size, weight = 500) { return `${weight} ${size}px ${FONT}`; }

export function text(ctx, str, x, y, { size = 26, weight = 500, color = '#f5f5f8', align = 'left', baseline = 'middle', maxWidth } = {}) {
  ctx.font = font(size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (maxWidth) ctx.fillText(str, x, y, maxWidth); else ctx.fillText(str, x, y);
}

export function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

// Frosted glass: windows show a blurred copy of what's behind them (main.js renders and
// blurs the backdrop each frame). The canvas tint is lighter when frost is on, so the blur
// shows through; with frost off the glass stays darker for readability.
export const frost = {
  enabled: { value: 0 },
  backdrop: { value: null },
  viewRect: { value: new THREE.Vector4(0, 0, 1, 1) },   // current view, in framebuffer pixels
};
let glassTint = 0.70;
export function setGlassTint(a) { glassTint = a; }

export function drawGlass(ctx, w, h, r = 40) {
  rr(ctx, 1, 1, w - 2, h - 2, r);
  ctx.fillStyle = `rgba(30, 32, 42, ${glassTint})`;
  ctx.fill();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0.13)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  g.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.20)';
  ctx.stroke();
}

// Helpers handed to an app's draw(): they draw a control and register its hit area.
export class UI {
  constructor(surface) { this.s = surface; }
  get hover() { return this.s.hover; }

  hit(id, x, y, w, h, onSelect, opts = {}) {
    this.s.elements.push({ id, x, y, w, h, onSelect, ...opts });
    return this.s.hover === id;
  }

  button(id, x, y, w, h, label, onSelect, { primary = false, danger = false, size = 26, r = h / 2, disabled = false } = {}) {
    const ctx = this.s.ctx;
    const hv = disabled ? false : this.hit(id, x, y, w, h, onSelect);
    rr(ctx, x, y, w, h, r);
    if (primary) ctx.fillStyle = hv ? '#a9c2ff' : '#7f9fff';
    else if (danger) ctx.fillStyle = hv ? 'rgba(255,110,110,0.55)' : 'rgba(255,90,90,0.30)';
    else ctx.fillStyle = hv ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.13)';
    ctx.fill();
    if (hv) { ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke(); }
    text(ctx, label, x + w / 2, y + h / 2 + 1, { size, weight: 600, align: 'center', color: primary ? '#0b1430' : (disabled ? 'rgba(255,255,255,0.35)' : '#fff') });
    return hv;
  }

  // Round app icon with a label underneath.
  tile(id, cx, cy, d, icon, label, colors, onSelect) {
    const ctx = this.s.ctx;
    const hv = this.hit(id, cx - d / 2 - 10, cy - d / 2 - 10, d + 20, d + 56, onSelect);
    const s = hv ? 1.08 : 1;
    const r = (d / 2) * s;
    if (hv) {
      const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 1.45);
      glow.addColorStop(0, 'rgba(255,255,255,0.35)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 1.45, 0, Math.PI * 2); ctx.fill();
    }
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    // specular highlight
    const hl = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 0, cx - r * 0.35, cy - r * 0.45, r * 0.9);
    hl.addColorStop(0, 'rgba(255,255,255,0.45)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.fill();
    text(ctx, icon, cx, cy + 3, { size: Math.round(d * 0.46), align: 'center' });
    text(ctx, label, cx, cy + d / 2 + 30, { size: 22, weight: hv ? 650 : 500, align: 'center', color: hv ? '#fff' : 'rgba(255,255,255,0.85)' });
    return hv;
  }

  // "Label        [-]  value  [+]"
  stepper(id, x, y, w, label, value, onMinus, onPlus) {
    const ctx = this.s.ctx;
    text(ctx, label, x, y + 26, { size: 25, color: 'rgba(255,255,255,0.9)' });
    const bx = x + w - 260;
    this.button(id + '-', bx, y, 64, 52, '−', onMinus, { size: 32 });
    text(ctx, value, bx + 130, y + 27, { size: 25, weight: 650, align: 'center' });
    this.button(id + '+', bx + 196, y, 64, 52, '+', onPlus, { size: 32 });
  }

  toggle(id, x, y, w, label, on, onToggle) {
    const ctx = this.s.ctx;
    text(ctx, label, x, y + 26, { size: 25, color: 'rgba(255,255,255,0.9)' });
    const tx = x + w - 104;
    const hv = this.hit(id, tx - 10, y - 4, 124, 60, onToggle);
    rr(ctx, tx, y + 4, 92, 44, 22);
    ctx.fillStyle = on ? (hv ? '#8fe0a0' : '#5fd07a') : (hv ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.18)');
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(on ? tx + 70 : tx + 22, y + 26, 18, 0, Math.PI * 2); ctx.fill();
  }
}

// One canvas texture on one plane. Hit-tested by gaze ray UVs.
export class Surface {
  constructor(w, h, drawFn, owner, { frosted = false } = {}) {
    this.w = w; this.h = h; this.drawFn = drawFn; this.owner = owner;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(w * RES);
    this.canvas.height = Math.round(h * RES);
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.anisotropy = 8;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mat = frosted ? frostedMaterial(this.tex)
      : new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, side: THREE.FrontSide });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w / PX_PER_M, h / PX_PER_M), this.mat);
    this.mesh.userData.surface = this;
    this.elements = [];
    this.hover = null;
    this.dirty = true;
  }
  redraw() {
    const ctx = this.ctx;
    ctx.setTransform(RES, 0, 0, RES, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.elements = [];
    this.drawFn(ctx, new UI(this), this);
    this.tex.needsUpdate = true;
    this.dirty = false;
  }
  hitTest(uv) {
    const x = uv.x * this.w, y = (1 - uv.y) * this.h;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const e = this.elements[i];
      if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) return e;
    }
    return null;
  }
  dispose() { this.tex.dispose(); this.mat.dispose(); this.mesh.geometry.dispose(); }
}

// Canvas UI composited over the blurred backdrop: inside the glass shape the backdrop shows
// through (slightly milky), and buttons / text from the canvas sit on top.
function frostedMaterial(tex) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, opacity: { value: 1 }, enabled: frost.enabled, backdrop: frost.backdrop, viewRect: frost.viewRect },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D map, backdrop; uniform vec4 viewRect; uniform float opacity, enabled; varying vec2 vUv;
      void main(){
        vec4 t = texture2D(map, vUv);
        if (t.a < 0.003) discard;
        vec3 col = t.rgb; float a = t.a;
        if (enabled > 0.5) {
          vec2 suv = clamp((gl_FragCoord.xy - viewRect.xy) / viewRect.zw, 0.0, 1.0);
          vec3 b = texture2D(backdrop, suv).rgb;
          vec3 frosted = mix(b * 0.9, vec3(0.94, 0.95, 1.0), 0.10);
          col = mix(frosted, t.rgb, t.a);
          a = smoothstep(0.0, 0.06, t.a);
        }
        gl_FragColor = vec4(col, a * opacity);
      }`,
    transparent: true, depthWrite: false,
  });
}

let nextPanelId = 1;

// A window: glass body + the close button / grab bar below it.
export class Panel {
  constructor(app, sys) {
    this.id = nextPanelId++;
    this.app = app;
    this.sys = sys;
    this.group = new THREE.Group();
    this.body = new Surface(app.w, app.h, (ctx, ui) => app.draw(ctx, ui, this), this, { frosted: true });
    this.group.add(this.body.mesh);
    this.surfaces = [this.body];
    this.bar = new Surface(300, 64, (ctx, ui) => this.drawBar(ctx, ui), this);
    this.group.add(this.bar.mesh);
    this.surfaces.push(this.bar);
    this.opacity = 0;
    this.grabbed = false;
    this.layout();
  }
  layout() {
    const b = this.body.mesh, s = b.scale.y;
    this.bar.mesh.scale.setScalar(s);
    this.bar.mesh.position.set(0, b.position.y - (this.app.h / PX_PER_M / 2 + 0.055) * s, 0.001);
  }
  drawBar(ctx, ui) {
    const hvClose = ui.hit('close', 0, 0, 64, 64, () => this.sys.close(this));
    ctx.beginPath(); ctx.arc(32, 32, 24, 0, Math.PI * 2);
    ctx.fillStyle = hvClose ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.22)'; ctx.fill();
    ctx.strokeStyle = hvClose ? '#222' : 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(24, 24); ctx.lineTo(40, 40); ctx.moveTo(40, 24); ctx.lineTo(24, 40); ctx.stroke();
    const hvGrab = ui.hit('grab', 76, 0, 224, 64, () => this.sys.grab(this));
    rr(ctx, 100, 24, 176, 16, 8);
    ctx.fillStyle = (hvGrab || this.grabbed) ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
    ctx.fill();
  }
  setOpacity(o) {
    this.opacity = o;
    for (const s of this.surfaces) {
      if (s.mat.uniforms) s.mat.uniforms.opacity.value = o; else s.mat.opacity = o;
    }
    if (this.extraMats) for (const m of this.extraMats) m.opacity = o;
  }
  dispose() { for (const s of this.surfaces) s.dispose(); }
}
