# Lumen Spatial

Lumen turns a phone and a Cardboard-style headset into a spatial computer: camera
passthrough, floating windows that stay put in your room, gaze, tap and hand-pinch
controls, immersive environments, a cinema screen, Jellyfin, and (in the Android app)
your phone's own apps and games running in a floating window.

Try it: **https://aneyex.com/lumen** (web) or download the Android app there.

## Credit, in plain words

Lumen is MIT-licensed, © aneyex.

- **Lumen's base layer** (the code in this repository) must keep its copyright notice
  if you copy, modify or ship it. That's the only requirement.
- **Your own stuff is yours.** Apps, UI, environments, themes or anything else you write
  for Lumen in your own files need no credit to Lumen, and you can license them however
  you like.

## Layout

| Folder | What's in it |
|---|---|
| `lumen/` | The web app (plain ES modules, no build step). `index.html` + `js/`. |
| `lumen/js/main.js` | Rendering, head tracking, passthrough, input (gaze, tap, pinch, controller). |
| `lumen/js/ui.js` | Window system: glass panels drawn on canvases, buttons, hit testing. |
| `lumen/js/apps.js` | The built-in apps (Home, Clock, Photos, Cinema, Settings, Jellyfin, Phone...). |
| `lumen/js/env.js` | Immersive environments (sky-sphere shaders). |
| `lumen/js/hands.js`, `hands-worker.js` | Hand tracking (MediaPipe) and pinch detection. |
| `lumen/js/phone.js` | Android-only: decodes the phone-apps stream and sends touches/gamepad. |
| `lumen-android/` | Android shell: WebView, native head tracking, Shizuku + scrcpy for phone apps. |

## Run the web app

Any static server works; the camera needs `https://` or `localhost`.

```sh
cd lumen
python -m http.server 8765
# open http://localhost:8765
```

On a desktop, drag or use the arrow keys to look around, click or press Enter to select.

## Build the Android app

Needs JDK 17 and the Android SDK.

```sh
cd lumen-android
./gradlew assembleDebug        # build/outputs/apk/debug/lumen-android-debug.apk
```

The build copies the web app from `../lumen` into the APK. Release builds are signed
with a key from `~/.lumen-signing/keystore.properties`; create your own key for your own
releases (never commit it). Running phone apps inside Lumen needs
[Shizuku](https://shizuku.rikka.app) on the phone.

## Write your own app

An app is a function returning a window description. Add it to the object returned by
`createApps()` in `lumen/js/apps.js` (or keep it in your own file and import it there),
and add a Home tile for it in `HOME_TILES`:

```js
import { drawGlass, text } from './ui.js';

export const counter = sys => () => ({
  w: 600, h: 360,                 // size in design pixels (600 px = 1 m)
  count: 0,
  draw(ctx, ui, panel) {          // called whenever the window needs redrawing
    drawGlass(ctx, this.w, this.h);
    text(ctx, `Count: ${this.count}`, 48, 80, { size: 40, weight: 700 });
    ui.button('add', 48, 200, 220, 70, '+1', () => { this.count++; sys.toast('Added'); }, { primary: true });
  },
  tick(now) { return false; },    // optional: return true to redraw (e.g. a clock)
  onOpen(panel) {},               // optional
  onClose(panel) {},              // optional
});

// HOME_TILES entry:
// { id: 'counter', icon: '🔢', label: 'Counter', colors: ['#5b6cff', '#2a2f8f'] }
```

Useful pieces:
- `ui.button(id, x, y, w, h, label, onSelect, opts)`, `ui.tile(...)`, `ui.toggle(...)`,
  `ui.stepper(...)`, or `ui.hit(id, x, y, w, h, onSelect)` for custom-drawn controls.
  Anything registered this way works with gaze, tap, pinch and controllers.
- `sys.open(appId, params)`, `sys.close(panel)`, `sys.toast(text)`, `sys.refresh(appId)`,
  `sys.setEnv(index, immersion)`, `sys.settings`.
- A window can hold extra 3D content: add meshes to `panel.group` in `onOpen`
  (see the Cinema app). Meshes in `panel.touchMeshes` with `userData.touch`
  `{ down, move, up }` receive finger-style input (see the Phone app).

New environments go in `ENVIRONMENTS` in `lumen/js/env.js` plus a branch in its shader.

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Third-party components and their licenses are listed in [NOTICE.md](NOTICE.md).
