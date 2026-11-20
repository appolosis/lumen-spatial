// Built-in spatial apps. Each factory returns { w, h, draw(ctx, ui, panel), tick?, onOpen?, onClose?, dist? }.
import * as THREE from 'three';
import { drawGlass, text, rr, PX_PER_M } from './ui.js?v=14';
import { ENVIRONMENTS } from './env.js?v=14';

const MUTED = 'rgba(255,255,255,0.62)';
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = s => !isFinite(s) ? '--:--' : `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, step) => Math.round(v / step) * step;

export const HOME_TILES = [
  { id: 'clock', icon: '🕒', label: 'Clock', colors: ['#5b6cff', '#2a2f8f'] },
  { id: 'photos', icon: '🖼️', label: 'Photos', colors: ['#ff9f6b', '#e0457b'] },
  { id: 'capture', icon: '📸', label: 'Capture', colors: ['#6be3ff', '#2d7fd6'], action: s => s.capture(() => s.open('photos')) },
  { id: 'environments', icon: '🏔️', label: 'Environments', colors: ['#7be0a4', '#2a8f6c'] },
  { id: 'cinema', icon: '🎬', label: 'Cinema', colors: ['#ff6b6b', '#8f2a4f'] },
  { id: 'jellyfin', icon: '🍿', label: 'Jellyfin', colors: ['#aa5cc3', '#00a4dc'] },
  { id: 'phoneapps', icon: '📱', label: 'Phone', colors: ['#5fd0a0', '#2a6fb0'] },
  { id: 'settings', icon: '⚙️', label: 'Settings', colors: ['#9aa0b0', '#4a4f5e'] },
  { id: 'recenter', icon: '🎯', label: 'Recenter', colors: ['#ffd36b', '#d68a2d'], action: s => s.recenter() },
  { id: 'exit', icon: '🚪', label: 'Exit', colors: ['#c08bff', '#5a2d9f'], action: s => s.exit() },
];

function wrapText(ctx, str, x, y, maxW, lineH, opts) {
  ctx.font = `${opts.weight || 500} ${opts.size || 26}px system-ui, sans-serif`;
  let line = '';
  for (const word of str.split(' ')) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) { text(ctx, line, x, y, opts); y += lineH; line = word; }
    else line = test;
  }
  if (line) text(ctx, line, x, y, opts);
}

function header(ctx, title, sub) {
  text(ctx, title, 48, 62, { size: 38, weight: 700 });
  if (sub) text(ctx, sub, 48, 102, { size: 22, color: MUTED });
}

export function createApps(sys) {
  return {
    welcome: () => ({
      w: 860, h: 620,
      draw(ctx, ui, p) {
        drawGlass(ctx, this.w, this.h);
        header(ctx, 'Welcome to Lumen');
        const lines = [
          ['👀', 'Look at a button to highlight it.'],
          ['⏳', 'Hold your gaze on it, or tap the screen, to select it.'],
          ['⬇️', 'Look down to find the Home orb.'],
          ['🤏', 'Or raise a hand: it becomes the pointer, pinch to click.'],
          ['✋', 'Pinch the bar under a window and hold to move it.'],
          ['🎯', 'Double-tap anywhere to recenter.'],
        ];
        lines.forEach(([ic, l], i) => {
          text(ctx, ic, 64, 150 + i * 64, { size: 32 });
          text(ctx, l, 120, 150 + i * 64, { size: 26, maxWidth: 700 });
        });
        ui.button('go', 280, 528, 300, 66, 'Get started', () => { sys.markWelcomed(); sys.close(p); sys.open('home'); }, { primary: true, size: 28 });
      },
    }),

    home: () => ({
      w: 980, h: 580,
      draw(ctx, ui, p) {
        drawGlass(ctx, this.w, this.h, 56);
        const d = new Date();
        text(ctx, 'Lumen', 52, 64, { size: 36, weight: 700 });
        text(ctx, `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, this.w - 52, 64, { size: 30, weight: 600, align: 'right', color: MUTED });
        HOME_TILES.forEach((t, i) => {
          const cx = 105 + (i % 6) * 154, cy = 210 + Math.floor(i / 6) * 210;
          ui.tile(t.id, cx, cy, 108, t.icon, t.label, t.colors, () => {
            sys.close(p);
            if (t.action) t.action(sys); else sys.open(t.id);
          });
        });
      },
      tick(now) { const m = new Date().getMinutes(); if (m !== this._m) { this._m = m; return true; } },
    }),

    clock: () => ({
      w: 640, h: 400,
      draw(ctx) {
        drawGlass(ctx, this.w, this.h, 48);
        const d = new Date();
        const cx = this.w / 2;
        // seconds ring
        ctx.lineWidth = 6; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath(); ctx.arc(cx, 160, 118, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#8fb0ff';
        ctx.beginPath(); ctx.arc(cx, 160, 118, -Math.PI / 2, -Math.PI / 2 + (d.getSeconds() / 60) * Math.PI * 2); ctx.stroke();
        text(ctx, `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, cx, 162, { size: 92, weight: 300, align: 'center' });
        const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        text(ctx, date, cx, 320, { size: 28, align: 'center', color: MUTED });
        const b = sys.battery;
        if (b) text(ctx, `${b.charging ? '⚡' : '🔋'} ${Math.round(b.level * 100)}%`, cx, 362, { size: 24, align: 'center', color: MUTED });
      },
      tick() { const s = new Date().getSeconds(); if (s !== this._s) { this._s = s; return true; } },
    }),

    photos: () => ({
      w: 920, h: 620,
      draw(ctx, ui) {
        drawGlass(ctx, this.w, this.h);
        header(ctx, 'Photos', `${sys.photos.length} this session`);
        ui.button('cap', this.w - 250, 36, 200, 62, '📸 Capture', () => sys.capture(), { primary: true });
        if (!sys.photos.length) {
          text(ctx, 'No photos yet', this.w / 2, 330, { size: 32, weight: 600, align: 'center' });
          text(ctx, 'Look at something and select Capture.', this.w / 2, 376, { size: 24, align: 'center', color: MUTED });
          return;
        }
        sys.photos.slice(0, 6).forEach((ph, i) => {
          const x = 44 + (i % 3) * 284, y = 140 + Math.floor(i / 3) * 228, w = 264, h = 200;
          const hv = ui.hit('ph' + i, x, y, w, h, () => sys.open('viewer', { photo: ph }));
          ctx.save(); rr(ctx, x, y, w, h, 22); ctx.clip();
          const c = ph.canvas, s = Math.max(w / c.width, h / c.height);
          ctx.drawImage(c, x + (w - c.width * s) / 2, y + (h - c.height * s) / 2, c.width * s, c.height * s);
          ctx.restore();
          if (hv) { rr(ctx, x, y, w, h, 22); ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        });
      },
    }),

    viewer: () => ({
      w: 1100, h: 720,
      draw(ctx, ui, p) {
        drawGlass(ctx, this.w, this.h);
        const ph = this.params.photo;
        if (!ph) return;
        const c = ph.canvas, bw = 1040, bh = 560, s = Math.min(bw / c.width, bh / c.height);
        const w = c.width * s, h = c.height * s, x = (this.w - w) / 2, y = 30 + (bh - h) / 2;
        ctx.save(); rr(ctx, x, y, w, h, 24); ctx.clip(); ctx.drawImage(c, x, y, w, h); ctx.restore();
        text(ctx, ph.time.toLocaleTimeString(), 40, 650, { size: 24, color: MUTED });
        ui.button('save', this.w - 470, 618, 200, 64, 'Save', () => sys.savePhoto(ph));
        ui.button('del', this.w - 250, 618, 200, 64, 'Delete', () => {
          sys.photos.splice(sys.photos.indexOf(ph), 1); sys.refresh('photos'); sys.close(p);
        }, { danger: true });
      },
    }),

    environments: () => ({
      w: 1000, h: 580,
      draw(ctx, ui) {
        drawGlass(ctx, this.w, this.h);
        header(ctx, 'Environments');
        const st = sys.envState;
        ENVIRONMENTS.forEach((e, i) => {
          const x = 44 + i * 184, y = 120, w = 168, h = 210;
          const hv = ui.hit('env' + i, x, y, w, h, () => sys.setEnv(i, i === 0 ? 0 : Math.max(st.immersion, 0.6)));
          rr(ctx, x, y, w, h, 26);
          const g = ctx.createLinearGradient(x, y, x, y + h);
          g.addColorStop(0, e.colors[0]); g.addColorStop(1, e.colors[1]);
          ctx.fillStyle = g; ctx.fill();
          if (st.index === i || hv) { ctx.lineWidth = st.index === i ? 5 : 3; ctx.strokeStyle = st.index === i ? '#fff' : 'rgba(255,255,255,0.6)'; ctx.stroke(); }
          text(ctx, e.icon, x + w / 2, y + 86, { size: 56, align: 'center' });
          text(ctx, e.name, x + w / 2, y + h - 30, { size: 21, weight: 600, align: 'center', maxWidth: w - 16 });
        });
        const on = st.index > 0;
        text(ctx, 'Immersion', 48, 390, { size: 26, weight: 600, color: on ? '#fff' : MUTED });
        text(ctx, on ? `${Math.round(st.immersion * 100)}%` : 'Pick an environment', this.w - 48, 390, { size: 24, align: 'right', color: MUTED });
        const step = v => sys.setEnv(st.index, clamp(round(st.immersion + v, 0.1), 0.1, 1));
        ui.button('imm-', 44, 424, 72, 60, '−', () => step(-0.1), { size: 34, disabled: !on });
        ui.button('imm+', this.w - 116, 424, 72, 60, '+', () => step(0.1), { size: 34, disabled: !on });
        rr(ctx, 140, 446, this.w - 280, 16, 8); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill();
        if (on) { rr(ctx, 140, 446, (this.w - 280) * st.immersion, 16, 8); ctx.fillStyle = '#8fb0ff'; ctx.fill(); }
        text(ctx, 'Lower immersion to keep your room visible around the edges.', this.w / 2, 532, { size: 21, align: 'center', color: MUTED });
      },
    }),

    cinema: () => {
      const m = sys.movie;
      if (!m) {
        return {
          w: 780, h: 380,
          draw(ctx, ui) {
            drawGlass(ctx, this.w, this.h);
            header(ctx, 'Cinema');
            text(ctx, 'Nothing playing.', 48, 150, { size: 28, weight: 600 });
            text(ctx, 'Open Jellyfin, or pick a video file on the start screen.', 48, 196, { size: 23, color: MUTED });
            ui.button('jf', 48, 260, 260, 64, '🍿 Jellyfin', () => sys.open('jellyfin'), { primary: true });
            ui.button('back', 326, 260, 320, 64, 'Go to start screen', () => sys.exit());
          },
        };
      }
      const v = m.video;
      return {
        w: 1000, h: 150, dist: 2.8,
        onOpen(p) {
          const aspect = (v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9;
          const sw = 2.8, sh = sw / aspect;
          const live = sys.liveVideo(v, 1920);
          const mat = new THREE.MeshBasicMaterial({ map: live.texture, transparent: true, depthWrite: false });
          const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), mat);
          p.group.add(screen);
          p.extraMats = [mat];
          const cs = 1.6;   // controls are scaled up so they stay readable at cinema distance
          p.body.mesh.scale.setScalar(cs);
          p.body.mesh.position.y = -(sh / 2 + 0.08 + (this.h / PX_PER_M / 2) * cs);
          p.layout();
          this._live = live; this._mat = mat; this._screen = screen;
          v.play().catch(() => sys.toast('Select ▶ to start'));
        },
        onClose() {
          if (m.stop) { m.stop(); v.remove(); } else v.pause();
          if (sys.movie === m && m.stop) sys.clearMovie();
          this._live?.dispose(); this._screen?.geometry.dispose();
          if (this._dimmed) sys.restoreEnv();
        },
        draw(ctx, ui) {
          drawGlass(ctx, this.w, this.h, 50);
          const playing = !v.paused && !v.ended;
          ui.button('pp', 28, 30, 90, 90, playing ? '❚❚' : '▶', () => (v.paused ? v.play() : v.pause()), { primary: true, size: 32 });
          ui.button('rw', 134, 40, 96, 70, '−10', () => { v.currentTime = Math.max(0, v.currentTime - 10); });
          ui.button('ff', 244, 40, 96, 70, '+30', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 30); });
          text(ctx, m.name, 370, 58, { size: 24, weight: 600, maxWidth: 250 });
          const bx = 370, bw = 380;
          rr(ctx, bx, 88, bw, 12, 6); ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
          const f = v.duration ? v.currentTime / v.duration : 0;
          rr(ctx, bx, 88, Math.max(12, bw * f), 12, 6); ctx.fillStyle = '#fff'; ctx.fill();
          if (v.readyState < 3 && !v.paused) text(ctx, 'Buffering…', bx + bw, 58, { size: 20, align: 'right', color: MUTED });
          else text(ctx, `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`, bx + bw, 58, { size: 20, align: 'right', color: MUTED });
          ui.button('dim', 784, 40, 190, 70, this._dimmed ? '☀ Room' : '🌙 Dim', () => {
            if (this._dimmed) { sys.restoreEnv(); this._dimmed = false; }
            else { sys.dimForCinema(); this._dimmed = true; }
          });
        },
        tick(now) {
          if (this._mat && this._live) this._mat.map = this._live.texture;   // follows canvas/direct mode
          if (now - (this._t || 0) > 500) { this._t = now; return true; }
        },
      };
    },

    jellyfin: () => {
      const jf = sys.jellyfin;
      const PAGE = 12;
      const imgs = new Map();
      const FOLDER_TYPES = new Set(['Series', 'Season', 'BoxSet', 'Folder', 'CollectionFolder', 'UserView', 'Playlist', '__resume']);
      const st = { stack: [{ title: 'Jellyfin', node: null }], page: 0, items: [], total: 0, loading: false, error: '' };
      const refresh = () => sys.refresh('jellyfin');
      function image(item) {
        const url = jf.imageUrl(item, 360);
        if (!url) return null;
        let im = imgs.get(url);
        if (!im) {
          im = new Image(); im.crossOrigin = 'anonymous';
          im.onload = refresh; im.src = url; imgs.set(url, im);
        }
        return im.complete && im.naturalWidth ? im : null;
      }
      async function load() {
        const top = st.stack[st.stack.length - 1];
        st.loading = true; st.error = ''; st.items = []; refresh();
        try {
          if (!top.node) {
            const views = await jf.views();
            const all = [{ Id: '__resume', Name: 'Continue Watching', Type: '__resume', IsFolder: true }, ...views];
            st.total = all.length; st.items = all.slice(st.page * PAGE, st.page * PAGE + PAGE);
          } else {
            const r = top.node.Type === '__resume' ? await jf.resume(st.page * PAGE, PAGE) : await jf.children(top.node, st.page * PAGE, PAGE);
            st.items = r.Items || []; st.total = r.TotalRecordCount ?? st.items.length;
          }
        } catch (e) { st.error = e.message || String(e); }
        st.loading = false; refresh();
      }
      function open(item) {
        if (item.IsFolder || FOLDER_TYPES.has(item.Type)) {
          st.stack.push({ title: item.Name, node: item }); st.page = 0; load();
        } else {
          sys.playJellyfin(item);
        }
      }
      return {
        w: 1180, h: 740,
        onOpen() { if (jf.connected) load(); },
        draw(ctx, ui) {
          drawGlass(ctx, this.w, this.h);
          if (!jf.connected) {
            header(ctx, 'Jellyfin');
            text(ctx, 'Not signed in.', 48, 170, { size: 30, weight: 600 });
            text(ctx, 'Leave headset mode and sign in to your Jellyfin server on the start screen.', 48, 220, { size: 23, color: MUTED });
            ui.button('go', 48, 280, 320, 64, 'Go to start screen', () => sys.exit(), { primary: true });
            return;
          }
          const depth = st.stack.length - 1, top = st.stack[depth];
          let tx = 48;
          if (depth > 0) {
            ui.button('back', 36, 32, 120, 60, '‹ Back', () => { st.stack.pop(); st.page = 0; load(); });
            tx = 176;
          }
          text(ctx, top.title, tx, 62, { size: 34, weight: 700, maxWidth: 620 });
          const pages = Math.max(1, Math.ceil(st.total / PAGE));
          if (pages > 1) {
            ui.button('prev', this.w - 290, 32, 70, 60, '‹', () => { st.page--; load(); }, { size: 34, disabled: st.page === 0 });
            text(ctx, `${st.page + 1} / ${pages}`, this.w - 165, 62, { size: 22, align: 'center', color: MUTED });
            ui.button('next', this.w - 106, 32, 70, 60, '›', () => { st.page++; load(); }, { size: 34, disabled: st.page >= pages - 1 });
          }
          if (st.error) { text(ctx, st.error, this.w / 2, 360, { size: 24, align: 'center', color: '#ffb0a0', maxWidth: 1000 }); return; }
          if (st.loading) { text(ctx, 'Loading…', this.w / 2, 360, { size: 26, align: 'center', color: MUTED }); return; }
          if (!st.items.length) { text(ctx, 'Nothing here yet', this.w / 2, 360, { size: 26, align: 'center', color: MUTED }); return; }

          const first = st.items[0];
          const landscape = !top.node || top.node.Type === '__resume' || top.node.Type === 'Season' || (first.PrimaryImageAspectRatio || 0.67) > 1.1;
          const cols = landscape ? 4 : 6, cw = landscape ? 262 : 164, ch = landscape ? 147 : 246, gap = landscape ? 20 : 24;
          const x0 = (this.w - (cols * cw + (cols - 1) * gap)) / 2, y0 = 116, rowH = ch + 52;
          st.items.forEach((item, i) => {
            const x = x0 + (i % cols) * (cw + gap), y = y0 + Math.floor(i / cols) * rowH;
            const hv = ui.hit('it' + i, x, y, cw, ch + 40, () => open(item));
            ctx.save(); rr(ctx, x, y, cw, ch, 18); ctx.clip();
            const im = item.Type === '__resume' ? null : image(item);
            if (im) {
              const s = Math.max(cw / im.naturalWidth, ch / im.naturalHeight);
              ctx.drawImage(im, x + (cw - im.naturalWidth * s) / 2, y + (ch - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
            } else {
              const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
              g.addColorStop(0, item.Type === '__resume' ? '#00a4dc' : '#3a3f55'); g.addColorStop(1, item.Type === '__resume' ? '#aa5cc3' : '#1d2030');
              ctx.fillStyle = g; ctx.fillRect(x, y, cw, ch);
              text(ctx, item.Type === '__resume' ? '⏯️' : '🎞️', x + cw / 2, y + ch / 2, { size: 44, align: 'center' });
            }
            const pct = item.UserData?.PlayedPercentage;
            if (pct) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y + ch - 8, cw, 8); ctx.fillStyle = '#00a4dc'; ctx.fillRect(x, y + ch - 8, cw * pct / 100, 8); }
            else if (item.UserData?.Played) { ctx.fillStyle = '#00a4dc'; ctx.beginPath(); ctx.arc(x + cw - 20, y + 20, 13, 0, Math.PI * 2); ctx.fill(); text(ctx, '✓', x + cw - 20, y + 21, { size: 17, weight: 700, align: 'center' }); }
            ctx.restore();
            if (hv) { rr(ctx, x - 3, y - 3, cw + 6, ch + 6, 20); ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke(); }
            const label = item.Type === 'Episode' && item.IndexNumber != null ? `${item.IndexNumber}. ${item.Name}` : item.Name;
            text(ctx, label, x + cw / 2, y + ch + 24, { size: 19, weight: hv ? 650 : 500, align: 'center', maxWidth: cw, color: hv ? '#fff' : 'rgba(255,255,255,0.85)' });
          });
        },
      };
    },

    // Pick an installed Android app to run inside Lumen.
    phoneapps: () => {
      const ph = sys.phone;
      const PAGE = 18;
      const icons = new Map();
      let page = 0, unsub = null;
      const refresh = () => sys.refresh('phoneapps');
      function icon(app) {
        let im = icons.get(app.pkg);
        if (!im) { im = new Image(); im.onload = refresh; im.src = app.icon; icons.set(app.pkg, im); }
        return im.complete && im.naturalWidth ? im : null;
      }
      const steps = {
        missing: ['Install Shizuku', 'Lumen runs your apps through Shizuku, a free helper app. Take the phone out of the headset and install it from the Play Store.', 'Open Play Store', () => ph.openShizuku()],
        not_running: ['Start Shizuku', 'Take the phone out of the headset, open Shizuku and tap Start (via Wireless debugging). You need to do this again after every restart.', 'Open Shizuku', () => ph.openShizuku()],
        outdated: ['Update Shizuku', 'Your Shizuku is too old. Update it from the Play Store.', 'Open Shizuku', () => ph.openShizuku()],
        no_permission: ['Allow Lumen', 'Shizuku needs your OK once. Select the button, then take the phone out and tap Allow.', 'Ask for permission', () => ph.requestShizuku()],
        unknown: ['Checking Shizuku…', '', null, null],
      };
      return {
        w: 1180, h: 760,
        onOpen() {
          unsub = ph.onChange(refresh);
          ph.refreshShizuku();
          if (ph.state.shizuku === 'ready' && !ph.state.apps) ph.loadApps();
        },
        onClose() { unsub?.(); },
        tick(now) {
          // keep polling while waiting on the user to set up Shizuku
          if (ph.state.shizuku !== 'ready' && now - (this._t || 0) > 2000) { this._t = now; ph.refreshShizuku(); }
          if (ph.state.shizuku === 'ready' && !ph.state.apps && !this._asked) { this._asked = true; ph.loadApps(); }
          return false;
        },
        draw(ctx, ui, p) {
          drawGlass(ctx, this.w, this.h);
          if (!ph.available) {
            header(ctx, 'Phone apps');
            text(ctx, 'Only available in the Lumen Android app.', 48, 170, { size: 28, weight: 600 });
            text(ctx, 'The web version cannot run other apps.', 48, 216, { size: 23, color: MUTED });
            return;
          }
          const s = ph.state.shizuku;
          if (s !== 'ready') {
            const [title, body, btn, act] = steps[s] || steps.unknown;
            header(ctx, title);
            if (body) wrapText(ctx, body, 48, 160, this.w - 96, 34, { size: 26, color: 'rgba(255,255,255,0.88)' });
            if (btn) ui.button('act', 48, 330, 360, 66, btn, act, { primary: true });
            ui.button('chk', 428, 330, 260, 66, 'Check again', () => ph.refreshShizuku());
            return;
          }
          const apps = ph.state.apps;
          header(ctx, 'Phone apps');
          if (!apps) { text(ctx, 'Loading your apps…', this.w / 2, 380, { size: 26, align: 'center', color: MUTED }); return; }
          const pages = Math.max(1, Math.ceil(apps.length / PAGE));
          page = Math.min(page, pages - 1);
          if (pages > 1) {
            ui.button('prev', this.w - 290, 32, 70, 60, '‹', () => { page--; refresh(); }, { size: 34, disabled: page === 0 });
            text(ctx, `${page + 1} / ${pages}`, this.w - 165, 62, { size: 22, align: 'center', color: MUTED });
            ui.button('next', this.w - 106, 32, 70, 60, '›', () => { page++; refresh(); }, { size: 34, disabled: page >= pages - 1 });
          }
          apps.slice(page * PAGE, page * PAGE + PAGE).forEach((app, i) => {
            const cx = 125 + (i % 6) * 186, cy = 175 + Math.floor(i / 6) * 196;
            const hv = ui.hit('a' + i, cx - 80, cy - 62, 160, 170, () => {
              sys.close(p);
              sys.openPhone(app);
            });
            if (hv) { rr(ctx, cx - 78, cy - 60, 156, 166, 26); ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill(); }
            const im = icon(app);
            const d = hv ? 104 : 96;
            if (im) ctx.drawImage(im, cx - d / 2, cy - d / 2, d, d);
            text(ctx, app.label, cx, cy + 78, { size: 20, weight: hv ? 650 : 500, align: 'center', maxWidth: 170, color: hv ? '#fff' : 'rgba(255,255,255,0.85)' });
          });
        },
      };
    },

    // The phone screen: a live view of the hidden display with Back / Home / Recents controls.
    phone: () => {
      const ph = sys.phone;
      let unsub = null;
      return {
        w: 1000, h: 130, dist: 2.2,
        onOpen(p) {
          const mat = new THREE.MeshBasicMaterial({ map: ph.texture, transparent: true, depthWrite: false });
          const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
          p.group.add(screen);
          p.extraMats = [mat];
          this._p = p; this._screen = screen; this._mat = mat;
          // The screen takes touches: pinch / tap = finger down, move = drag, release = finger up.
          screen.userData.touch = {
            down: uv => ph.touch(0, uv.x, 1 - uv.y),
            move: uv => ph.touch(2, uv.x, 1 - uv.y),
            up: uv => ph.touch(1, uv.x, 1 - uv.y),
          };
          p.touchMeshes = [screen];
          this.layout();
          unsub = ph.onChange(() => { this.layout(); sys.refresh('phone'); });
        },
        layout() {
          const st = ph.state;
          const aspect = st.width && st.height ? st.width / st.height : 16 / 9;
          if (this._aspect === aspect) return;
          this._aspect = aspect;
          const h = aspect >= 1 ? 2.4 / aspect : 1.5;     // landscape 2.4 m wide, portrait 1.5 m tall
          const w = h * aspect;
          this._screen.geometry.dispose();
          this._screen.geometry = new THREE.PlaneGeometry(w, h);
          const cs = 1.4;
          this._p.body.mesh.scale.setScalar(cs);
          this._p.body.mesh.position.y = -(h / 2 + 0.06 + (this.h / PX_PER_M / 2) * cs);
          this._p.layout();
        },
        onClose() { unsub?.(); ph.stop(); this._screen?.geometry.dispose(); },
        tick(now) { if (now - (this._t || 0) > 1000) { this._t = now; return true; } },
        draw(ctx, ui, p) {
          drawGlass(ctx, this.w, this.h, 46);
          const st = ph.state;
          ui.button('back', 26, 25, 120, 80, '◀', () => ph.back(), { size: 32 });
          ui.button('home', 160, 25, 120, 80, '●', () => ph.home(), { size: 30 });
          ui.button('recent', 294, 25, 120, 80, '▢', () => ph.recents(), { size: 34 });
          const label = st.phone === 'running' ? (st.frames ? (this.params.app?.label || 'Phone') : 'Starting…')
            : st.phone === 'starting' ? 'Starting…'
            : st.phone === 'error' ? 'Could not start' : 'Stopped';
          text(ctx, label, 440, 52, { size: 24, weight: 600, maxWidth: 220 });
          if (st.phone === 'error') text(ctx, st.detail.replace('shizuku:', 'Shizuku: '), 440, 86, { size: 18, color: '#ffb0a0', maxWidth: 220 });
          else if (sys.gameMode) text(ctx, '🎮 Controller → game', 440, 86, { size: 18, weight: 600, color: '#7be0a4', maxWidth: 220 });
          else if (st.phone === 'running') text(ctx, 'Look at the screen to play', 440, 86, { size: 17, color: MUTED, maxWidth: 220 });
          ui.button('apps', 674, 25, 100, 80, '⊞', () => sys.open('phoneapps'), { size: 34 });
          ui.button('rot', 786, 25, 90, 80, '⟳', () => ph.rotate(), { size: 34 });
          ui.button('off', 888, 25, 90, 80, '✕', () => sys.close(p), { size: 30, danger: true });
        },
      };
    },

    settings: () => ({
      w: 1240, h: 600, dist: 2.0,
      draw(ctx, ui) {
        drawGlass(ctx, this.w, this.h);
        header(ctx, 'Settings');
        const s = sys.settings;
        const set = (k, v) => { s[k] = v; sys.saveSettings(k); };
        const W = 548, cols = [44, 648];
        const ys = [106, 106];
        const row = (c, fn) => { fn(cols[c], ys[c]); ys[c] += 64; };
        row(0, (x, y) => ui.toggle('stereo', x, y, W, 'Headset view (side-by-side)', sys.stereo, () => sys.setStereo(!sys.stereo)));
        row(0, (x, y) => ui.stepper('ipd', x, y, W, 'Eye distance (IPD)', `${s.ipd} mm`, () => set('ipd', clamp(s.ipd - 1, 50, 80)), () => set('ipd', clamp(s.ipd + 1, 50, 80))));
        row(0, (x, y) => ui.stepper('fov', x, y, W, 'Field of view', `${s.fov}°`, () => set('fov', clamp(s.fov - 5, 50, 120)), () => set('fov', clamp(s.fov + 5, 50, 120))));
        row(0, (x, y) => ui.stepper('dist', x, y, W, 'Lens distortion', s.distortion.toFixed(2), () => set('distortion', clamp(round(s.distortion - 0.04, 0.01), 0, 0.8)), () => set('distortion', clamp(round(s.distortion + 0.04, 0.01), 0, 0.8))));
        row(0, (x, y) => ui.stepper('lens', x, y, W, 'Lens centre offset', s.lensOffset.toFixed(2), () => set('lensOffset', clamp(round(s.lensOffset - 0.01, 0.01), -0.15, 0.15)), () => set('lensOffset', clamp(round(s.lensOffset + 0.01, 0.01), -0.15, 0.15))));
        row(0, (x, y) => ui.stepper('zoom', x, y, W, 'Passthrough zoom', `${s.ptZoom.toFixed(2)}×`, () => set('ptZoom', clamp(round(s.ptZoom - 0.05, 0.05), 0.4, 2.5)), () => set('ptZoom', clamp(round(s.ptZoom + 0.05, 0.05), 0.4, 2.5))));
        row(1, (x, y) => ui.stepper('sync', x, y, W, 'Passthrough sync', `${s.ptSync} ms`, () => set('ptSync', clamp(s.ptSync - 10, -60, 250)), () => set('ptSync', clamp(s.ptSync + 10, -60, 250))));
        row(1, (x, y) => ui.stepper('wdist', x, y, W, 'Window distance', `${s.panelDist.toFixed(1)} m`, () => set('panelDist', clamp(round(s.panelDist - 0.1, 0.1), 0.8, 4)), () => set('panelDist', clamp(round(s.panelDist + 0.1, 0.1), 0.8, 4))));
        row(1, (x, y) => ui.toggle('hands', x, y, W, 'Hand tracking (pinch)', s.hands, () => set('hands', !s.hands)));
        row(1, (x, y) => ui.toggle('dwell', x, y, W, 'Select by holding gaze', s.dwellOn, () => set('dwellOn', !s.dwellOn)));
        row(1, (x, y) => ui.stepper('dwt', x, y, W, 'Gaze hold time', `${s.dwell.toFixed(1)} s`, () => set('dwell', clamp(round(s.dwell - 0.2, 0.1), 0.4, 3)), () => set('dwell', clamp(round(s.dwell + 0.2, 0.1), 0.4, 3))));
        row(1, (x, y) => ui.toggle('track', x, y, W, 'Low-latency tracking', s.tracking !== 'legacy', () => set('tracking', s.tracking === 'legacy' ? 'sensor' : 'legacy')));
        const y = Math.max(...ys) + 10;
        ui.button('rc', 44, y, 260, 62, 'Recenter', () => sys.recenter());
        ui.button('rs', 320, y, 260, 62, 'Reset all', () => sys.resetSettings());
        ui.button('ex', this.w - 304, y, 260, 62, 'Exit', () => sys.exit(), { danger: true });
      },
    }),
  };
}
