// Sound Library: real, sampled instruments — the 128 General MIDI instruments plus a drum kit,
// recorded from the FluidR3 GM SoundFont (Frank Wen; MIT / CC-BY 3.0), in the MIDI.js format
// published by the midi-js-soundfonts project.
//
// Where the samples come from, in order:
//   1. this device's cache (anything loaded once stays available offline),
//   2. sounds bundled with the desktop/tablet app (dist/sounds/, added by scripts/fetch-sounds.mjs),
//   3. the internet (GitHub Pages, then the jsDelivr CDN).
import type { InstDef, Voice } from './instruments';
import type { ParamDef } from './plugins';

export const GM_FONT = 'FluidR3_GM';
const SOURCES = [
  `./sounds/${GM_FONT}/`,
  `https://gleitz.github.io/midi-js-soundfonts/${GM_FONT}/`,
  `https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/${GM_FONT}/`,
];
const CACHE = 'ozmix-sounds-v1';

/** [file id, display name] for GM programs 0–127, then the drum kit. */
export const GM: [string, string][] = [
  ['acoustic_grand_piano', 'Grand Piano'], ['bright_acoustic_piano', 'Bright Piano'], ['electric_grand_piano', 'Electric Grand'], ['honkytonk_piano', 'Honky-Tonk Piano'],
  ['electric_piano_1', 'Electric Piano (Rhodes)'], ['electric_piano_2', 'Electric Piano (FM)'], ['harpsichord', 'Harpsichord'], ['clavinet', 'Clavinet'],
  ['celesta', 'Celesta'], ['glockenspiel', 'Glockenspiel'], ['music_box', 'Music Box'], ['vibraphone', 'Vibraphone'],
  ['marimba', 'Marimba'], ['xylophone', 'Xylophone'], ['tubular_bells', 'Tubular Bells'], ['dulcimer', 'Dulcimer'],
  ['drawbar_organ', 'Drawbar Organ'], ['percussive_organ', 'Percussive Organ'], ['rock_organ', 'Rock Organ'], ['church_organ', 'Church Organ'],
  ['reed_organ', 'Reed Organ'], ['accordion', 'Accordion'], ['harmonica', 'Harmonica'], ['tango_accordion', 'Tango Accordion'],
  ['acoustic_guitar_nylon', 'Nylon Guitar'], ['acoustic_guitar_steel', 'Steel Guitar'], ['electric_guitar_jazz', 'Jazz Guitar'], ['electric_guitar_clean', 'Clean Electric Guitar'],
  ['electric_guitar_muted', 'Muted Guitar'], ['overdriven_guitar', 'Overdriven Guitar'], ['distortion_guitar', 'Distortion Guitar'], ['guitar_harmonics', 'Guitar Harmonics'],
  ['acoustic_bass', 'Acoustic Bass'], ['electric_bass_finger', 'Finger Bass'], ['electric_bass_pick', 'Pick Bass'], ['fretless_bass', 'Fretless Bass'],
  ['slap_bass_1', 'Slap Bass 1'], ['slap_bass_2', 'Slap Bass 2'], ['synth_bass_1', 'Synth Bass 1'], ['synth_bass_2', 'Synth Bass 2'],
  ['violin', 'Violin'], ['viola', 'Viola'], ['cello', 'Cello'], ['contrabass', 'Contrabass'],
  ['tremolo_strings', 'Tremolo Strings'], ['pizzicato_strings', 'Pizzicato Strings'], ['orchestral_harp', 'Harp'], ['timpani', 'Timpani'],
  ['string_ensemble_1', 'String Ensemble'], ['string_ensemble_2', 'Slow Strings'], ['synth_strings_1', 'Synth Strings 1'], ['synth_strings_2', 'Synth Strings 2'],
  ['choir_aahs', 'Choir Aahs'], ['voice_oohs', 'Voice Oohs'], ['synth_choir', 'Synth Choir'], ['orchestra_hit', 'Orchestra Hit'],
  ['trumpet', 'Trumpet'], ['trombone', 'Trombone'], ['tuba', 'Tuba'], ['muted_trumpet', 'Muted Trumpet'],
  ['french_horn', 'French Horn'], ['brass_section', 'Brass Section'], ['synth_brass_1', 'Synth Brass 1'], ['synth_brass_2', 'Synth Brass 2'],
  ['soprano_sax', 'Soprano Sax'], ['alto_sax', 'Alto Sax'], ['tenor_sax', 'Tenor Sax'], ['baritone_sax', 'Baritone Sax'],
  ['oboe', 'Oboe'], ['english_horn', 'English Horn'], ['bassoon', 'Bassoon'], ['clarinet', 'Clarinet'],
  ['piccolo', 'Piccolo'], ['flute', 'Flute'], ['recorder', 'Recorder'], ['pan_flute', 'Pan Flute'],
  ['blown_bottle', 'Blown Bottle'], ['shakuhachi', 'Shakuhachi'], ['whistle', 'Whistle'], ['ocarina', 'Ocarina'],
  ['lead_1_square', 'Square Lead'], ['lead_2_sawtooth', 'Saw Lead'], ['lead_3_calliope', 'Calliope Lead'], ['lead_4_chiff', 'Chiff Lead'],
  ['lead_5_charang', 'Charang Lead'], ['lead_6_voice', 'Voice Lead'], ['lead_7_fifths', 'Fifths Lead'], ['lead_8_bass__lead', 'Bass + Lead'],
  ['pad_1_new_age', 'New Age Pad'], ['pad_2_warm', 'Warm Pad'], ['pad_3_polysynth', 'Polysynth Pad'], ['pad_4_choir', 'Choir Pad'],
  ['pad_5_bowed', 'Bowed Pad'], ['pad_6_metallic', 'Metallic Pad'], ['pad_7_halo', 'Halo Pad'], ['pad_8_sweep', 'Sweep Pad'],
  ['fx_1_rain', 'Rain FX'], ['fx_2_soundtrack', 'Soundtrack FX'], ['fx_3_crystal', 'Crystal FX'], ['fx_4_atmosphere', 'Atmosphere FX'],
  ['fx_5_brightness', 'Brightness FX'], ['fx_6_goblins', 'Goblins FX'], ['fx_7_echoes', 'Echoes FX'], ['fx_8_scifi', 'Sci-Fi FX'],
  ['sitar', 'Sitar'], ['banjo', 'Banjo'], ['shamisen', 'Shamisen'], ['koto', 'Koto'],
  ['kalimba', 'Kalimba'], ['bagpipe', 'Bagpipe'], ['fiddle', 'Fiddle'], ['shanai', 'Shanai'],
  ['tinkle_bell', 'Tinkle Bell'], ['agogo', 'Agogo'], ['steel_drums', 'Steel Drums'], ['woodblock', 'Woodblock'],
  ['taiko_drum', 'Taiko Drum'], ['melodic_tom', 'Melodic Tom'], ['synth_drum', 'Synth Drum'], ['reverse_cymbal', 'Reverse Cymbal'],
  ['guitar_fret_noise', 'Guitar Fret Noise'], ['breath_noise', 'Breath Noise'], ['seashore', 'Seashore'], ['bird_tweet', 'Bird Tweet'],
  ['telephone_ring', 'Telephone'], ['helicopter', 'Helicopter'], ['applause', 'Applause'], ['gunshot', 'Gunshot'],
  ['percussion', 'Drum Kit (GM)'],
];
export const GM_DRUMS = 128;
export const GM_CATEGORIES = ['Piano', 'Chromatic Percussion', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth Effects', 'World', 'Percussive', 'Sound Effects'];
export const gmName = (prog: number) => GM[Math.max(0, Math.min(GM.length - 1, Math.round(prog)))][1];

// ---------- loading ----------
export type Bank = Map<number, AudioBuffer>;
const banks = new Map<string, Promise<Bank>>();
const ready = new Map<string, Bank>();
const listeners = new Set<(id: string, state: 'loading' | 'ready' | 'error') => void>();
export const onBankState = (f: (id: string, state: 'loading' | 'ready' | 'error') => void) => listeners.add(f);
let decodeCtx: BaseAudioContext | null = null;
/** The context used to decode samples (buffers work in any context, including bounces). */
export const setDecodeContext = (ctx: BaseAudioContext) => { decodeCtx = ctx; };

const PCS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const noteToMidi = (n: string) => {
  const m = /^([A-G])(b|#)?(-?\d)$/.exec(n); if (!m) return -1;
  return (+m[3] + 1) * 12 + PCS[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0);
};

async function fetchText(file: string): Promise<string> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(SOURCES[1] + file); if (hit) return await hit.text(); } catch { cache = null; }
  let lastErr: unknown = null;
  // the drum kit isn't in every font: also look in the other midi-js-soundfonts sets
  const sources = file.startsWith('percussion') ? [...SOURCES, ...['MusyngKite', 'FatBoy'].flatMap(f => SOURCES.slice(1).map(s => s.replace(GM_FONT, f)))] : SOURCES;
  for (const base of sources) {
    if (base.startsWith('./') && location.protocol === 'file:') continue; // no bundled sounds next to a local file
    try {
      const res = await fetch(base + file);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const text = await res.text();
      if (!text.includes('data:audio')) { lastErr = new Error('not a soundfont file'); continue; }
      if (cache && base !== SOURCES[0]) cache.put(SOURCES[1] + file, new Response(text, { headers: { 'Content-Type': 'text/javascript' } })).catch(() => {});
      return text;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('unavailable');
}

/** Downloads every instrument into this device's cache (for offline use) without loading them into memory. */
export async function cacheAllInstruments(progress: (done: number, total: number, failed: number) => void) {
  let done = 0, bad = 0;
  for (const [id] of GM) {
    try { await fetchText(`${id}-mp3.js`); } catch { bad++; }
    progress(++done, GM.length, bad);
  }
  return bad;
}

const b64 = (s: string) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

/** Loads (once) every sample of an instrument. */
export function loadBank(prog: number): Promise<Bank> {
  const id = GM[Math.round(prog)]?.[0] ?? GM[0][0];
  let p = banks.get(id);
  if (!p) {
    listeners.forEach(f => f(id, 'loading'));
    p = (async () => {
      const text = await fetchText(`${id}-mp3.js`);
      const bank: Bank = new Map();
      const re = /"([A-G][b#]?-?\d)"\s*:\s*"data:audio\/[a-z0-9]+;base64,([A-Za-z0-9+/=]+)"/g;
      const jobs: Promise<void>[] = [];
      for (let m; (m = re.exec(text)); ) {
        const midi = noteToMidi(m[1]), data = m[2];
        if (midi < 0) continue;
        jobs.push(decodeCtx!.decodeAudioData(b64(data)).then(buf => { bank.set(midi, buf); }).catch(() => {}));
      }
      await Promise.all(jobs);
      if (!bank.size) throw new Error('no samples');
      ready.set(id, bank);
      listeners.forEach(f => f(id, 'ready'));
      return bank;
    })();
    banks.set(id, p);
    p.catch(() => { banks.delete(id); listeners.forEach(f => f(id, 'error')); });
  }
  return p;
}
export const bankReady = (prog: number) => ready.has(GM[Math.round(prog)]?.[0] ?? '');
const failed = new Set<string>();
onBankState((id, s) => { if (s === 'error') failed.add(id); else failed.delete(id); });
/** True when an instrument's samples couldn't be loaded (offline and not cached). */
export const bankFailed = (prog: number) => failed.has(GM[Math.round(prog)]?.[0] ?? '');

// ---------- instrument ----------
const GM_PARAMS: ParamDef[] = [
  { id: 'program', label: 'Instrument', min: 0, max: GM.length - 1, def: 0, unit: '', step: 1, options: GM.map(g => g[1]) },
  { id: 'attack', label: 'Attack', min: 1, max: 2000, def: 2, unit: 'ms', log: true },
  { id: 'release', label: 'Release', min: 20, max: 4000, def: 300, unit: 'ms', log: true },
  { id: 'tone', label: 'Tone', min: 500, max: 20000, def: 20000, unit: 'Hz', log: true },
  { id: 'velSens', label: 'Velocity', min: 0, max: 100, def: 70, unit: '%' },
  { id: 'tune', label: 'Transpose', min: -24, max: 24, def: 0, unit: 'st', step: 1 },
  { id: 'level', label: 'Level', min: -24, max: 12, def: 0, unit: 'dB', step: 0.5 },
];
export const gmParams = (prog: number) => ({ ...Object.fromEntries(GM_PARAMS.map(p => [p.id, p.def])), program: prog });

const silent = (ctx: BaseAudioContext): Voice => ({ src: [], env: ctx.createGain(), release() {} });

export const GM_INST: InstDef = {
  type: 'gm' as any, name: 'Sound Library', params: GM_PARAMS,
  presets: Object.fromEntries(GM.map((g, i) => [g[1], gmParams(i)])),
  play(ctx, dest, p, pitch, vel, when, dur): Voice {
    const prog = Math.round(p.program), id = GM[prog]?.[0];
    const bank = id ? ready.get(id) : undefined;
    if (!bank) { loadBank(prog).catch(() => {}); return silent(ctx); }
    const drums = prog === GM_DRUMS;
    const want = drums ? pitch : pitch + Math.round(p.tune);
    // nearest recorded note, resampled to the wanted pitch
    let best = -1, bd = 999;
    for (const k of bank.keys()) { const d = Math.abs(k - want); if (d < bd) { bd = d; best = k; } }
    if (best < 0 || (drums && bd > 0)) return silent(ctx);
    const buf = bank.get(best)!;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = Math.pow(2, (want - best) / 12);
    const env = ctx.createGain(), tone = ctx.createBiquadFilter();
    tone.type = 'lowpass'; tone.frequency.value = Math.min(20000, p.tone * (0.5 + 0.5 * vel / 127)); tone.Q.value = 0.3;
    const sens = p.velSens / 100, lvl = Math.pow(10, p.level / 20) * 0.9 * ((1 - sens) + sens * Math.pow(vel / 127, 1.5));
    const A = Math.max(0.001, p.attack / 1000), R = Math.max(0.02, p.release / 1000);
    env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(lvl, when + A);
    src.connect(tone); tone.connect(env); env.connect(dest);
    src.start(when);
    const natural = buf.duration / src.playbackRate.value;
    const end = (at: number) => { env.gain.cancelScheduledValues(at); env.gain.setValueAtTime(lvl, at); env.gain.setTargetAtTime(0, at, R / 4); try { src.stop(at + R * 1.5 + 0.05); } catch { /* */ } };
    if (dur != null && !drums) end(when + Math.min(dur, natural));
    else src.stop(when + natural + 0.05);
    src.onended = () => [src, tone, env].forEach(n => n.disconnect());
    return { src: [src], env, release(at) { if (dur == null && !drums) end(Math.max(at, when + A)); } };
  },
};
