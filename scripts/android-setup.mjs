// Run after `tauri android init`: adds the permissions the DAW needs to the generated Android project.
// (src-tauri/gen/ is generated, so this is re-applied whenever the project is re-initialised.)
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const path = 'src-tauri/gen/android/app/src/main/AndroidManifest.xml';
if (!existsSync(path)) { console.error(`${path} not found: run "tauri android init" first`); process.exit(1); }
let xml = readFileSync(path, 'utf8');

const perms = [
  'android.permission.RECORD_AUDIO',          // recording audio tracks (getUserMedia)
  'android.permission.MODIFY_AUDIO_SETTINGS', // low-latency audio / input routing
  'android.permission.WAKE_LOCK',             // keep the screen awake while playing/recording
];
for (const p of perms) {
  if (!xml.includes(`"${p}"`)) xml = xml.replace(/<application/, `<uses-permission android:name="${p}" />\n    <application`);
}
// mic is optional hardware: don't hide the app from tablets without one
if (!xml.includes('android.hardware.microphone')) {
  xml = xml.replace(/<application/, `<uses-feature android:name="android.hardware.microphone" android:required="false" />\n    <application`);
}
// tablets: allow split screen / free-form windows
if (!xml.includes('resizeableActivity')) xml = xml.replace(/<application\b/, '<application android:resizeableActivity="true"');

writeFileSync(path, xml);
console.log('AndroidManifest.xml: audio permissions added');

// Full screen (sticky immersive): the status bar and navigation bar are hidden, so taps and drags at the
// top of the app don't pull down the notification shade. A swipe from the edge shows the bars briefly.
const find = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = `${dir}/${f}`;
    if (statSync(p).isDirectory()) { const r = find(p); if (r) return r; }
    else if (f === 'MainActivity.kt') return p;
  }
  return null;
};
const act = find('src-tauri/gen/android/app/src/main/java');
if (!act) { console.error('MainActivity.kt not found'); process.exit(1); }
const pkg = /^package\s+([\w.]+)/m.exec(readFileSync(act, 'utf8'))[1];
writeFileSync(act, `package ${pkg}

import android.os.Bundle
import android.webkit.WebView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    immersive()
  }

  // The app lays itself out for the screen: ignore the system font size (it made the bars overflow).
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.settings.textZoom = 100
  }

  override fun onResume() {
    super.onResume()
    immersive()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) immersive()
  }

  private fun immersive() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val c = WindowInsetsControllerCompat(window, window.decorView)
    c.hide(WindowInsetsCompat.Type.systemBars())
    c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
  }
}
`);
console.log(`${act}: full-screen immersive mode`);
