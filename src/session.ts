// Session Players: Drummer, Bass and Keys parts generated from a few musical settings.
// A session region is a normal MIDI region whose notes are regenerated whenever its settings change.
import { Note, Region, Store } from './model';

export type SessionType = 'drums' | 'bass' | 'keys';

export interface SessionState {
  type: SessionType;
  style: string;
  complexity: number; // 0..1  (XY pad x: Simple -> Complex)
  intensity: number; // 0..1  (XY pad y: Soft -> Loud)
  fills: number; // 0..1
  swing: number; // 0..1
  halfTime: boolean;
  seed: number;
  chords: string; // bass/keys: one chord per bar, repeats
}

export const STYLES: Record<SessionType, string[]> = {
  drums: ['Rock', 'Pop', 'Hip-Hop', 'Electronic', 'Funk'],
  bass: ['Root 8ths', 'Root & Fifth', 'Funk', 'Sustained'],
  keys: ['Block Chords', 'Offbeat Stabs', 'Arpeggio', 'Pad'],
};

export function newSession(type: SessionType): SessionState {
  return { type, style: STYLES[type][0], complexity: 0.4, intensity: 0.6, fills: 0.5, swing: 0, halfTime: false, seed: 1, chords: 'Am F C G' };
}

function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// ---------------- chords ----------------
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export interface Chord { root: number; tones: number[] } // pitch classes / semitone offsets from root
export function parseChords(text: string): Chord[] {
  const out: Chord[] = [];
  for (const tok of text.split(/[\s,|]+/).filter(Boolean)) {
    const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(tok); if (!m) continue;
    let root = PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    root = (root + 12) % 12;
    const q = m[3].toLowerCase();
    let tones = [0, 4, 7];
    if (/^(m|min|-)(?!aj)/.test(q)) tones = [0, 3, 7];
    if (q.includes('dim')) tones = [0, 3, 6];
    if (q.includes('sus4')) tones = [0, 5, 7];
    if (q.includes('sus2')) tones = [0, 2, 7];
    if (q.includes('maj7')) tones = [...tones, 11];
    else if (q.includes('7')) tones = [...tones, 10];
    out.push({ root, tones });
  }
  return out.length ? out : [{ root: 9, tones: [0, 3, 7] }];
}

// ---------------- generators ----------------
const D = { kick: 36, snare: 38, clap: 39, hat: 42, open: 46, lowTom: 41, midTom: 45, hiTom: 48, crash: 49, ride: 51 };

function drums(s: SessionState, bars: number, bpb: number): Note[] {
  const r = rng(s.seed), notes: Note[] = [];
  const vel = (base: number, accent = 0) => Math.max(1, Math.min(127, Math.round(base * (0.55 + 0.45 * s.intensity) + accent + (r() - 0.5) * 10)));
  const steps = bpb * 4;
  const swing = (st: number) => (st % 2 === 1 ? s.swing * 0.08 : 0);
  const add = (p: number, bar: number, st: number, v: number, l = 0.2) => notes.push({ p, s: bar * bpb + st / 4 + swing(st), l, v });
  const c = s.complexity;
  for (let bar = 0; bar < bars; bar++) {
    const fillBar = s.fills > 0.05 && bar % 4 === 3 && bar > 0;
    const fillFrom = fillBar ? steps - Math.round(2 + s.fills * 6) : steps; // fill length grows with Fills
    if (bar === 0 || (bar % 4 === 0 && s.fills > 0.05)) add(D.crash, bar, 0, vel(105, 6), 1);
    let kick: number[] = [], snare: number[] = [], hats: number[] = [], extraKick: number[] = [], ghost: number[] = [];
    switch (s.style) {
      case 'Pop': kick = [0, 7, 8]; snare = [4, 12]; hats = [0, 2, 4, 6, 8, 10, 12, 14]; extraKick = [3, 11, 14]; ghost = [7, 15]; break;
      case 'Hip-Hop': kick = [0, 7, 10]; snare = [4, 12]; hats = Array.from({ length: 16 }, (_, i) => i); extraKick = [3, 9, 15]; ghost = [6, 14]; break;
      case 'Electronic': kick = [0, 4, 8, 12]; snare = []; hats = [2, 6, 10, 14]; extraKick = [15]; ghost = []; break;
      case 'Funk': kick = [0, 3, 10]; snare = [4, 12]; hats = Array.from({ length: 16 }, (_, i) => i); extraKick = [6, 13]; ghost = [2, 7, 9, 15]; break;
      default: kick = [0, 8]; snare = [4, 12]; hats = [0, 2, 4, 6, 8, 10, 12, 14]; extraKick = [6, 10, 14]; ghost = [7, 15];
    }
    if (s.halfTime) { snare = [8]; kick = kick.filter(k => k !== 8 && k !== 7); }
    const scale = steps / 16;
    const at = (st: number) => Math.round(st * scale);
    for (const k of kick) if (at(k) < fillFrom) add(D.kick, bar, at(k), vel(110, k === 0 ? 8 : 0));
    for (const k of extraKick) if (r() < c * 0.8 && at(k) < fillFrom) add(D.kick, bar, at(k), vel(90));
    for (const k of snare) if (at(k) < fillFrom) add(s.style === 'Electronic' ? D.clap : D.snare, bar, at(k), vel(112, 4));
    if (s.style === 'Electronic') for (const k of [4, 12]) if (at(k) < fillFrom) add(D.clap, bar, at(k), vel(105));
    for (const g of ghost) if (r() < c * 0.9 && at(g) < fillFrom) add(D.snare, bar, at(g), vel(45));
    const busyHats = c > 0.65 && hats.length === 8;
    const hatList = busyHats ? Array.from({ length: 16 }, (_, i) => i) : hats;
    for (const h of hatList) {
      if (at(h) >= fillFrom) continue;
      const onBeat = h % 4 === 0;
      const open = (s.style === 'Pop' || s.style === 'Rock') && h === 14 && r() < 0.3 + c * 0.4;
      add(s.style === 'Electronic' && !busyHats ? D.open : open ? D.open : D.hat, bar, at(h), vel(onBeat ? 85 : 62, 0), 0.12);
    }
    // fill: a run around the toms, ending on the downbeat crash of the next bar
    if (fillBar) {
      const toms = [D.hiTom, D.hiTom, D.midTom, D.midTom, D.lowTom, D.lowTom, D.snare, D.snare];
      for (let st = fillFrom, i = 0; st < steps; st++, i++) {
        if (c < 0.4 && st % 2 === 1) continue;
        add(st >= steps - 2 && r() < 0.5 ? D.snare : toms[Math.min(toms.length - 1, Math.floor((i / Math.max(1, steps - fillFrom)) * toms.length))], bar, st, vel(95 + i * 2));
      }
      add(D.kick, bar, fillFrom, vel(100));
    }
  }
  return notes;
}

function bass(s: SessionState, bars: number, bpb: number): Note[] {
  const r = rng(s.seed), notes: Note[] = [], chords = parseChords(s.chords);
  const v = (b: number) => Math.max(1, Math.min(127, Math.round(b * (0.6 + 0.4 * s.intensity) + (r() - 0.5) * 8)));
  const rootNote = (ch: Chord) => 33 + ((ch.root - 9 + 12) % 12); // A1 .. G#2
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar % chords.length], next = chords[(bar + 1) % chords.length];
    const root = rootNote(ch), fifth = root + 7, oct = root + 12;
    const b0 = bar * bpb;
    const push = (p: number, beat: number, l: number, vv: number) => { if (beat < bpb) notes.push({ p, s: b0 + beat + (Math.round(beat * 4) % 2 ? s.swing * 0.08 : 0), l, v: v(vv) }); };
    switch (s.style) {
      case 'Root & Fifth':
        push(root, 0, 1.4, 105); push(fifth, 1.5, 0.45, 85); push(root, 2, 0.9, 98); if (s.complexity > 0.3) push(oct, 3, 0.45, 88); if (s.complexity > 0.6) push(fifth, 3.5, 0.45, 80); break;
      case 'Funk':
        for (const [beat, p, l] of [[0, root, 0.3], [0.75, oct, 0.2], [1.5, root, 0.2], [2.25, fifth, 0.2], [3, root, 0.3], [3.5, oct, 0.2]] as [number, number, number][]) if (beat === 0 || r() < 0.45 + s.complexity * 0.5) push(p, beat, l, beat === 0 ? 110 : 90);
        break;
      case 'Sustained': push(root, 0, bpb - 0.1, 100); if (s.complexity > 0.5) push(fifth, bpb / 2, bpb / 2 - 0.1, 85); break;
      default: for (let e = 0; e < bpb * 2; e++) push(e === 0 || r() > s.complexity * 0.4 ? root : oct, e / 2, 0.45, e % 2 ? 82 : 100);
    }
    // approach note into the next chord
    if (s.complexity > 0.45 && s.style !== 'Sustained') {
      const target = rootNote(next), approach = target + (target > root ? -1 : 1);
      while (notes.length && notes[notes.length - 1].s >= b0 + bpb - 0.5) notes.pop(); // make room on the last 8th
      push(approach, bpb - 0.5, 0.45, 88);
    }
  }
  return notes;
}

function keys(s: SessionState, bars: number, bpb: number): Note[] {
  const r = rng(s.seed), notes: Note[] = [], chords = parseChords(s.chords);
  const v = (b: number) => Math.max(1, Math.min(127, Math.round(b * (0.55 + 0.45 * s.intensity) + (r() - 0.5) * 8)));
  const voice = (ch: Chord) => {
    const tones = s.complexity > 0.55 && ch.tones.length === 3 ? [...ch.tones, ch.tones[1] === 3 ? 10 : 11] : ch.tones;
    // close voicing around C4..C5
    return tones.map(t => { let p = 60 + ((ch.root + t) % 12); if (p > 67) p -= 12; return p; }).sort((a, b) => a - b);
  };
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar % chords.length], vs = voice(ch), b0 = bar * bpb;
    const chord = (beat: number, l: number, vv: number) => { for (const p of vs) notes.push({ p, s: b0 + beat + (Math.round(beat * 4) % 2 ? s.swing * 0.08 : 0), l, v: v(vv) }); };
    switch (s.style) {
      case 'Offbeat Stabs': for (let e = 1; e < bpb * 2; e += 2) if (r() < 0.75 + s.complexity * 0.25) chord(e / 2, 0.25, 92); break;
      case 'Arpeggio': {
        const seq = [...vs, ...vs.slice(1, -1).reverse()];
        const per = s.complexity > 0.5 ? 4 : 2;
        for (let i = 0; i < bpb * per; i++) notes.push({ p: seq[i % seq.length] + (i % (seq.length * 2) >= seq.length && s.complexity > 0.7 ? 12 : 0), s: b0 + i / per, l: 1 / per - 0.02, v: v(i % per ? 78 : 96) });
        break;
      }
      case 'Pad': chord(0, bpb - 0.05, 80); break;
      default: chord(0, bpb / 2 - 0.1, 96); chord(bpb / 2, bpb / 2 - 0.1, 86); if (s.complexity > 0.6) chord(bpb - 0.5, 0.45, 76);
    }
  }
  return notes;
}

/** Regenerates a session region's notes from its settings. */
export function generate(store: Store, r: Region) {
  const s = r.session; if (!s) return;
  const bpb = store.beatsPerBar, bars = Math.max(1, Math.ceil(r.length / bpb - 1e-6));
  const notes = s.type === 'drums' ? drums(s, bars, bpb) : s.type === 'bass' ? bass(s, bars, bpb) : keys(s, bars, bpb);
  r.notes = notes.filter(n => n.s < r.length).sort((a, b) => a.s - b.s);
}

const sigs = new Map<string, string>();
/** Keeps every session region's notes in step with its settings and length (call after any structural change). */
export function syncSessions(store: Store) {
  for (const r of store.project.regions) {
    if (!r.session) continue;
    const sig = JSON.stringify([r.session, r.length, store.beatsPerBar]);
    if (sigs.get(r.id) === sig && r.notes?.length) continue;
    generate(store, r); sigs.set(r.id, sig);
  }
}
