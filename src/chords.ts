// Chord Track (Cubase style): chord events on the timeline; MIDI can be made to follow them, and chord
// regions can be generated from them with smooth voice leading.
import { Store, ChordEvent, Note, uid } from './model';

export const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const QUALITIES: [string, string, number[]][] = [
  ['', 'Major', [0, 4, 7]], ['m', 'Minor', [0, 3, 7]], ['7', 'Dominant 7', [0, 4, 7, 10]], ['maj7', 'Major 7', [0, 4, 7, 11]],
  ['m7', 'Minor 7', [0, 3, 7, 10]], ['sus2', 'Sus 2', [0, 2, 7]], ['sus4', 'Sus 4', [0, 5, 7]], ['6', 'Major 6', [0, 4, 7, 9]],
  ['m6', 'Minor 6', [0, 3, 7, 9]], ['add9', 'Add 9', [0, 4, 7, 14]], ['9', 'Dominant 9', [0, 4, 7, 10, 14]], ['dim', 'Diminished', [0, 3, 6]],
  ['m7b5', 'Half-diminished', [0, 3, 6, 10]], ['aug', 'Augmented', [0, 4, 8]],
];
export const intervals = (q: string) => QUALITIES.find(x => x[0] === q)?.[2] ?? [0, 4, 7];
export const chordName = (c: { root: number; q: string }) => ROOTS[((c.root % 12) + 12) % 12] + c.q;
export const chordPcs = (c: { root: number; q: string }) => intervals(c.q).map(i => (c.root + i) % 12);

export const chordList = (store: Store) => (store.project.chords ??= []);
export function chordAt(store: Store, b: number): ChordEvent | undefined {
  let cur: ChordEvent | undefined;
  for (const c of [...chordList(store)].sort((x, y) => x.b - y.b)) { if (c.b <= b + 1e-6) cur = c; else break; }
  return cur;
}

export function addChord(store: Store, b: number, root: number, q: string): ChordEvent {
  const list = chordList(store);
  const same = list.find(c => Math.abs(c.b - b) < 1e-6);
  if (same) { same.root = root; same.q = q; return same; }
  const c: ChordEvent = { id: uid('c'), b, root, q };
  list.push(c); list.sort((x, y) => x.b - y.b);
  return c;
}

/** Moves a pitch to the nearest note whose pitch class is in `pcs` (ties go down). */
export function nearestPc(p: number, pcs: number[]) {
  for (let d = 0; d <= 6; d++) { if (pcs.includes(((p - d) % 12 + 12) % 12)) return p - d; if (pcs.includes((p + d) % 12)) return p + d; }
  return p;
}

/** Makes notes (region-relative, region starts at `start`) follow the Chord Track. Returns how many moved. */
export function followChords(store: Store, notes: Note[], start: number) {
  let moved = 0;
  for (const n of notes) {
    const c = chordAt(store, start + n.s); if (!c) continue;
    const p = nearestPc(n.p, chordPcs(c));
    if (p !== n.p) { n.p = p; moved++; }
  }
  return moved;
}

/** Voice-led chord notes for the Chord Track from `from` to `to` (beats): close-position chords around
 *  middle C that move as little as possible, plus a bass root an octave or two below. */
export function chordNotes(store: Store, from: number, to: number, opts: { bass: boolean; rhythm: 'whole' | 'beats' } = { bass: true, rhythm: 'whole' }): Note[] {
  const list = [...chordList(store)].sort((a, b) => a.b - b.b);
  const out: Note[] = [];
  let prev: number[] = [60, 64, 67];
  list.forEach((c, i) => {
    const s = Math.max(c.b, from), e = Math.min(list[i + 1]?.b ?? to, to);
    if (e <= s) return;
    const pcs = chordPcs(c).slice(0, 4);
    // choose the inversion closest to the previous voicing
    let best: number[] = [], bestCost = Infinity;
    for (let inv = 0; inv < pcs.length; inv++) {
      const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
      for (const base of [48, 60]) {
        const v: number[] = []; let last = base - 1;
        for (const pc of order) { let p = Math.floor(last / 12) * 12 + pc; while (p <= last) p += 12; v.push(p); last = p; }
        if (v[0] < 52 || v[v.length - 1] > 79) continue;
        const cost = v.reduce((a, p, k) => a + Math.abs(p - (prev[Math.min(k, prev.length - 1)] ?? p)), 0);
        if (cost < bestCost) { bestCost = cost; best = v; }
      }
    }
    if (!best.length) best = pcs.map(pc => 60 + pc);
    prev = best;
    const hits = opts.rhythm === 'beats' ? Array.from({ length: Math.ceil(e - s) }, (_, k) => s + k).filter(b => b < e) : [s];
    for (const h of hits) {
      const len = (opts.rhythm === 'beats' ? Math.min(1, e - h) : e - h) * 0.95;
      for (const p of best) out.push({ p, s: h - from, l: len, v: h === s ? 92 : 76 });
    }
    if (opts.bass) out.push({ p: 36 + c.root % 12, s: s - from, l: (e - s) * 0.95, v: 96 });
  });
  return out;
}
