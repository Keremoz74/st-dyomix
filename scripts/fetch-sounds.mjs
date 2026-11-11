// CI/packaging: downloads a core set of Sound Library instruments into dist/sounds/ so the desktop and
// tablet apps play them without internet. Everything else downloads on first use and is cached.
// Usage: node scripts/fetch-sounds.mjs [all]
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

const FONT = 'FluidR3_GM';
const CORE = [
  'acoustic_grand_piano', 'electric_piano_1', 'drawbar_organ',
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_clean', 'distortion_guitar',
  'electric_bass_finger', 'violin', 'string_ensemble_1', 'choir_aahs',
  'trumpet', 'alto_sax', 'flute', 'pad_2_warm',
];
// The GM set has no drum kit in every font: try these folders for 'percussion'.
const DRUM_FONTS = ['FluidR3_GM', 'MusyngKite', 'FatBoy'];
const PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midiOf = n => { const m = /^([A-G])(b|#)?(-?\d)$/.exec(n); return m ? (+m[3] + 1) * 12 + PCS[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0) : -1; };
/** Keeps every third note (a minor third apart): the app re-pitches the nearest one, and the bundle stays small. */
const slim = text => {
  const entries = [...text.matchAll(/"([A-G][b#]?-?\d)"\s*:\s*"(data:audio\/[a-z0-9]+;base64,[A-Za-z0-9+/=]+)"/g)];
  const keep = entries.filter(([, n]) => midiOf(n) % 3 === 0);
  return `MIDI.Soundfont.x = {\n${keep.map(([, n, d]) => `"${n}": "${d}"`).join(',\n')}\n}\n`;
};
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
  const fonts = name === 'percussion' ? DRUM_FONTS : [FONT];
  const urls = fonts.flatMap(f => BASES.map(b => b.replace(FONT, f) + `${name}-mp3.js`));
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes('data:audio')) continue;
      const out = name === 'percussion' ? text : slim(text);
      writeFileSync(file, out); ok++; bytes += out.length; done = true;
      console.log(`  ${name}: ${(out.length / 1e6).toFixed(2)} MB from ${url.split('/').slice(-2, -1)[0]}`);
      break;
    } catch { /* next source */ }
  }
  if (!done) console.warn(`  ! ${name}: not available (it will download on first use instead)`);
}
console.log(`Sound Library: ${ok}/${list.length} instruments bundled (${(bytes / 1e6).toFixed(1)} MB)`);
