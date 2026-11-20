# Third-party software

Lumen's own code is MIT-licensed (see [LICENSE](LICENSE)). It ships with these
third-party components, which keep their own licenses:

| Component | Where | License |
|---|---|---|
| [three.js](https://threejs.org) | `lumen/vendor/three.*.min.js` | MIT ([lumen/vendor/three-LICENSE](lumen/vendor/three-LICENSE)) |
| [hls.js](https://github.com/video-dev/hls.js) | `lumen/vendor/hls.light.min.js` | Apache-2.0 ([lumen/vendor/hls-LICENSE](lumen/vendor/hls-LICENSE)) |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and the hand landmarker model, by Google | `lumen/vendor/mediapipe/` | Apache-2.0 ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)) |
| [scrcpy](https://github.com/Genymobile/scrcpy) server 5.0.1, by Genymobile and contributors | `lumen-android/src/main/assets/scrcpy-server` | Apache-2.0 ([licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)) |
| [Shizuku API](https://github.com/RikkaApps/Shizuku-API), by RikkaApps (Gradle dependency) | `lumen-android/build.gradle` | Apache-2.0 |
| [AndroidX WebKit](https://developer.android.com/jetpack/androidx/releases/webkit) (Gradle dependency) | `lumen-android/build.gradle` | Apache-2.0 |

The scrcpy server is used unmodified. Lumen's virtual gamepad uses the same HID
report layout as scrcpy's gamepad support.
