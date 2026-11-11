// Builds a short demo song (A minor, 96 BPM) played entirely by Sound Library instruments:
// acoustic drum kit, finger bass, grand piano, Rhodes, strings and alto sax — all MIDI, so every
// part can be edited, re-voiced or swapped for another instrument.
import { Store, uid, Insert, Note } from '../model';
import { PluginType, defaultParams } from './plugins';
import { newInstrument, InstrumentState } from './instruments';
import { gmName } from './gm';

/** Bump when the demo changes: an autosaved older demo is rebuilt on open. */
export const DEMO_VERSION = 2;
export const DEMO_NAME = 'Demo Song';

const fx = (type: PluginType, p: Record<string, number> = {}): Insert => ({ id: uid('fx'), type, bypass: false, params: { ...defaultParams(type), ...p } });
const gm = (prog: number, p: Record<string, number> = {}): InstrumentState => {
  const i = newInstrument('gm');
  i.params = { ...i.params, program: prog, ...p };
  i.preset = gmName(prog);
  return i;
};

const BPM = 96, BARS = 8;
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
const BASS = [45, 41, 36, 43]; // A1 F1 C1 G1

// GM drum notes
const KICK = 36, SNARE = 38, HAT = 42, OPEN = 46, CRASH = 49, RIDE = 51, TOM_H = 48, TOM_M = 45, TOM_L = 43;

function drumPart(bars: number, fill: boolean, ride = false): Note[] {
  const n: Note[] = [];
  const hit = (p: number, s: number, v: number) => n.push({ p, s, l: 0.25, v });
  for (let b = 0; b < bars; b++) {
    const o = b * 4, last = b === bars - 1;
    if (b === 0) hit(CRASH, o, 105);
    for (let e = 0; e < 8; e++) {
      if (last && fill && e >= 6) continue;
      const s = o + e / 2;
      if (!(b === 0 && e === 0)) hit(ride ? RIDE : (e === 7 && b % 2 === 1 ? OPEN : HAT), s, e % 2 ? 62 : 88);
    }
    hit(KICK, o, 112); hit(KICK, o + 2, 104); if (b % 2 === 1) hit(KICK, o + 2.75, 84); else hit(KICK, o + 1.5, 80);
    hit(SNARE, o + 1, 106);
    if (!(last && fill)) hit(SNARE, o + 3, 108);
    if (b % 4 === 3 && !fill) hit(SNARE, o + 3.75, 52); // ghost note
    if (last && fill) [TOM_H, TOM_H, TOM_M, TOM_M, TOM_L, TOM_L, SNARE, SNARE].forEach((p, i) => hit(p, o + 2 + i * 0.25, 90 + i * 3));
  }
  return n;
}

function bassPart(bars: number): Note[] {
  const n: Note[] = [];
  for (let b = 0; b < bars; b++) {
    const r = BASS[b % 4], o = b * 4;
    n.push({ p: r, s: o, l: 0.9, v: 104 }, { p: r, s: o + 1.5, l: 0.4, v: 86 }, { p: r + 12, s: o + 2, l: 0.45, v: 92 },
      { p: r + 7, s: o + 2.5, l: 0.45, v: 84 }, { p: r, s: o + 3, l: 0.9, v: 96 });
  }
  return n;
}

/** Piano: left-hand octave + right-hand broken chord. */
function pianoPart(bars: number): Note[] {
  const n: Note[] = [];
  for (let b = 0; b < bars; b++) {
    const c = PROG[b % 4], o = b * 4, root = BASS[b % 4] + 12;
    n.push({ p: root, s: o, l: 3.8, v: 78 }, { p: root + 12, s: o, l: 3.8, v: 70 });
    [c[0], c[1], c[2], c[1] + 12, c[2], c[1], c[0] + 12, c[2]].forEach((p, i) => n.push({ p, s: o + i / 2, l: 0.95, v: i % 2 ? 62 : 76 }));
  }
  return n;
}

/** Rhodes: syncopated chord stabs. */
function rhodesPart(bars: number): Note[] {
  const n: Note[] = [];
  for (let b = 0; b < bars; b++) {
    const c = PROG[b % 4], o = b * 4;
    for (const [s, l, v] of [[0, 1.4, 86], [1.5, 0.9, 72], [2.5, 1.4, 80]] as const) c.forEach(p => n.push({ p: p + 12, s: o + s, l, v }));
  }
  return n;
}

function stringsPart(bars: number): Note[] {
  const n: Note[] = [];
  for (let b = 0; b < bars; b++) PROG[b % 4].forEach((p, i) => n.push({ p: p + (i === 0 ? 12 : 0), s: b * 4, l: 3.95, v: 72 }));
  return n;
}

const MEL: [number, number, number][][] = [ // pitch, start, length per bar
  [[76, 0, 1.5], [74, 1.5, 0.5], [72, 2, 1], [71, 3, 1]],
  [[72, 0, 1.5], [69, 1.5, 0.5], [72, 2, 1], [74, 3, 1]],
  [[76, 0, 1], [79, 1, 1], [76, 2, 0.5], [74, 2.5, 0.5], [72, 3, 1]],
  [[74, 0, 2.5], [71, 2.5, 0.5], [67, 3, 1]],
];
function melodyPart(bars: number): Note[] {
  const n: Note[] = [];
  for (let b = 0; b < bars; b++) MEL[b % 4].forEach(([p, s, l], i) => n.push({ p: p - 12 + (b >= 4 ? 12 : 0), s: b * 4 + s, l: l * 0.95, v: 92 + (i === 0 ? 10 : 0) }));
  return n;
}

export async function loadDemo(store: Store) {
  const p = store.project;
  p.name = DEMO_NAME; p.id = p.id ?? uid('p'); p.tempo = BPM; p.tracks = []; p.regions = []; p.auxes = []; p.tempoEvents = []; p.movie = undefined;
  p.demoVersion = DEMO_VERSION;
  const L = BARS * 4;
  p.markers = [{ id: uid('m'), b: 0, name: 'Verse' }, { id: uid('m'), b: L, name: 'Chorus' }];

  const verb = store.addAux('Reverb Bus');
  verb.inserts = [fx('reverb', { decay: 2.4, mix: 100, predelay: 20 })];
  verb.volume = -6;

  type Part = { start: number; notes: Note[] };
  const track = (name: string, inst: InstrumentState, vol: number, pan: number, send: number, parts: Part[], inserts: Insert[] = []) => {
    const t = store.addTrack(name, false, 'inst', inst); t.volume = vol; t.pan = pan; t.inserts = inserts;
    t.sends = [{ id: uid('s'), bus: verb.bus!, level: send }];
    parts.forEach((r, i) => p.regions.push({ id: uid('r'), kind: 'midi', notes: r.notes, trackId: t.id, bufferId: '', name: `${name}${parts.length > 1 ? ` ${i + 1}` : ''}`, start: r.start, length: L, offset: 0, muted: false }));
    return t;
  };

  // Verse: drums, bass, piano, strings. Chorus: + Rhodes and sax melody, ride cymbal.
  const drums = track('Drums', gm(128), -4, 0, -20, [
    { start: 0, notes: drumPart(BARS, true) }, { start: L, notes: drumPart(BARS, true, true) },
  ], [fx('eq', { hpf: 30, lowGain: 2, highGain: 2 }), fx('comp', { threshold: -18, ratio: 3, attack: 10, makeup: 2 })]);
  track('Bass', gm(33), -6, 0, -40, [{ start: 0, notes: bassPart(BARS) }, { start: L, notes: bassPart(BARS) }], [fx('comp', { threshold: -16, ratio: 4, attack: 5, makeup: 2 })]);
  track('Grand Piano', gm(0), -6, -0.2, -12, [{ start: 0, notes: pianoPart(BARS) }, { start: L, notes: pianoPart(BARS) }]);
  track('Rhodes', gm(4), -9, 0.25, -14, [{ start: L, notes: rhodesPart(BARS) }]);
  track('Strings', gm(48, { attack: 180, release: 600 }), -11, -0.35, -8, [{ start: 0, notes: stringsPart(BARS) }, { start: L, notes: stringsPart(BARS) }]);
  track('Alto Sax', gm(65), -7, 0.15, -10, [{ start: L, notes: melodyPart(BARS) }], [fx('delay')]);
  p.masterInserts = [];
  store.addTrack('Vocal', false);
  store.ui.selectedTrackId = drums.id;
  store.ui.cycle = { on: false, start: L, end: 2 * L };
}

/** True for an autosaved demo made by an older version (synth sounds): it gets rebuilt. */
export const isOldDemo = (store: Store) => {
  const p = store.project;
  return p.name === DEMO_NAME && (p.demoVersion ?? 1) < DEMO_VERSION && p.tracks.some(t => t.name === 'Lead Synth');
};
