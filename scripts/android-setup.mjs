// Run after `tauri android init`: adds the permissions the DAW needs to the generated Android project.
// (src-tauri/gen/ is generated, so this is re-applied whenever the project is re-initialised.)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
