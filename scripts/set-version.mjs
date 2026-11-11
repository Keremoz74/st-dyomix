// CI: gives every build its own version (0.10.<run number>) so Android/iOS install it as an update
// (the Android versionCode is derived from the version and must keep increasing).
import { readFileSync, writeFileSync } from 'node:fs';
const n = process.argv[2];
if (!n) { console.error('usage: node scripts/set-version.mjs <build number>'); process.exit(1); }
const base = JSON.parse(readFileSync('package.json', 'utf8')).version.split('.').slice(0, 2).join('.');
const version = `${base}.${n}`;
for (const f of ['package.json', 'src-tauri/tauri.conf.json']) {
  const j = JSON.parse(readFileSync(f, 'utf8')); j.version = version; writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync('src-tauri/Cargo.toml', cargo);
console.log(`version ${version}`);
