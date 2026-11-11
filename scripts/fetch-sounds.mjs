// CI/packaging: downloads a core set of Sound Library instruments into dist/sounds/ so the desktop and
// tablet apps play them without internet. Everything else downloads on first use and is cached.
// Usage: node scripts/fetch-sounds.mjs [all]
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

const FONT = 'FluidR3_GM';
const CORE = [
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  'vibraphone', 'marimba', 'drawbar_organ', 'rock_organ', 'church_organ', 'accordion',
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_clean', 'electric_guitar_jazz', 'overdriven_guitar', 'distortion_guitar',
  'acoustic_bass', 'electric_bass_finger', 'slap_bass_1', 'synth_bass_1',
  'violin', 'cello', 'string_ensemble_1', 'pizzicato_strings', 'orchestral_harp', 'choir_aahs',
  'trumpet', 'trombone', 'brass_section', 'alto_sax', 'tenor_sax', 'clarinet', 'flute', 'pan_flute',
  'lead_2_sawtooth', 'pad_2_warm', 'pad_1_new_age', 'sitar', 'kalimba', 'percussion',
];
const ALL_URL = `https://gleitz.github.io/midi-js-soundfonts/${FONT}/names.json`;
const BASES = [`https://gleitz.github.io/midi-js-soundfonts/${FONT}/`, `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/${FONT}/`];

const dir = `dist/sounds/${FONT}`;
mkdirSync(dir, { recursive: true });
let list = CORE;
if (process.argv[2] === 'all') { try { list = [...new Set([...(await (await fetch(ALL_URL)).json()), 'percussion'])]; } catch { /* keep core */ } }
let ok = 0, bytes = 0;
for (const name of list) {
  const file = `${dir}/${name}-mp3.js`;
  if (existsSync(file) && statSync(file).size > 1000) { ok++; bytes += statSync(file).size; continue; }
  let done = false;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}${name}-mp3.js`);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes('data:audio')) continue;
      writeFileSync(file, text); ok++; bytes += text.length; done = true; break;
    } catch { /* next source */ }
  }
  if (!done) console.warn(`  ! ${name}: not available (it will download on first use instead)`);
}
console.log(`Sound Library: ${ok}/${list.length} instruments bundled (${(bytes / 1e6).toFixed(1)} MB)`);
