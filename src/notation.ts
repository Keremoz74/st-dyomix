// Music notation layout: spelling in a key, quantizing to 1/16, splitting durations into notatable values
// with ties, rests, beam groups and stem directions. Pure functions; the Score editor draws the result.
import { Note } from './model';

// ---------------- spelling ----------------
export const NAT = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
export const KEY_NAMES: Record<number, string> = { [-6]: 'G♭ major / E♭ minor', [-5]: 'D♭ major / B♭ minor', [-4]: 'A♭ major / F minor', [-3]: 'E♭ major / C minor', [-2]: 'B♭ major / G minor', [-1]: 'F major / D minor', 0: 'C major / A minor', 1: 'G major / E minor', 2: 'D major / B minor', 3: 'A major / F♯ minor', 4: 'E major / C♯ minor', 5: 'B major / G♯ minor', 6: 'F♯ major / D♯ minor' };

/** Alteration (-1, 0, +1) the key signature gives each letter C..B. */
export function keyAlters(fifths: number): number[] {
  const a = [0, 0, 0, 0, 0, 0, 0];
  if (fifths > 0) for (let i = 0; i < fifths; i++) a[SHARP_ORDER[i]] = 1;
  if (fifths < 0) for (let i = 0; i < -fifths; i++) a[FLAT_ORDER[i]] = -1;
  return a;
}

export interface Spelled { letter: number; oct: number; acc: number; step: number }
/** Letter, octave (scientific: MIDI 60 = C4), alteration and diatonic step (oct*7+letter). */
export function spell(midi: number, fifths: number): Spelled {
  const ka = keyAlters(fifths), pc = ((midi % 12) + 12) % 12;
  let letter = -1, acc = 0;
  for (let L = 0; L < 7; L++) if ((NAT[L] + ka[L] + 12) % 12 === pc) { letter = L; acc = ka[L]; break; }
  if (letter < 0) {
    // a chromatic note: prefer the natural of a letter the key alters (F♮ in D major), then sharps/flats
    for (let L = 0; L < 7 && letter < 0; L++) if (NAT[L] === pc) { letter = L; acc = 0; }
    for (let L = 0; L < 7 && letter < 0; L++) {
      if (fifths >= 0 && (NAT[L] + 1) % 12 === pc) { letter = L; acc = 1; }
      else if (fifths < 0 && (NAT[L] + 11) % 12 === pc) { letter = L; acc = -1; }
    }
    if (letter < 0) for (let L = 0; L < 7; L++) if (NAT[L] === pc) { letter = L; acc = 0; }
  }
  const oct = Math.floor((midi - acc - NAT[letter]) / 12) - 1;
  return { letter, oct, acc, step: oct * 7 + letter };
}
/** MIDI pitch for a diatonic step in the key. */
export function stepToMidi(step: number, fifths: number) {
  const letter = ((step % 7) + 7) % 7, oct = Math.floor(step / 7);
  return (oct + 1) * 12 + NAT[letter] + keyAlters(fifths)[letter];
}

// ---------------- drums ----------------
/** GM drum note -> staff position (half-spaces above the bottom line) and notehead. */
export const DRUM_POS: Record<number, { pos: number; x: boolean }> = {
  35: { pos: 1, x: false }, 36: { pos: 1, x: false }, 37: { pos: 5, x: true }, 38: { pos: 5, x: false }, 40: { pos: 5, x: false }, 39: { pos: 5, x: true },
  41: { pos: 2, x: false }, 43: { pos: 2, x: false }, 45: { pos: 4, x: false }, 47: { pos: 6, x: false }, 48: { pos: 7, x: false }, 50: { pos: 8, x: false },
  42: { pos: 9, x: true }, 44: { pos: -1, x: true }, 46: { pos: 9, x: true }, 49: { pos: 10, x: true }, 57: { pos: 10, x: true }, 51: { pos: 8, x: true }, 59: { pos: 8, x: true },
};
/** Inverse for inserting on the drum staff: nearest drum to a staff position. */
export function drumAtPos(pos: number) {
  const order: [number, number][] = [[-1, 44], [1, 36], [2, 41], [4, 45], [5, 38], [6, 47], [7, 48], [8, 51], [9, 42], [10, 49]];
  let best = order[0]; for (const o of order) if (Math.abs(o[0] - pos) < Math.abs(best[0] - pos)) best = o;
  return best[1];
}

// ---------------- rhythm ----------------
export interface Piece {
  t: number; // 16th within the bar
  d: number; // 16ths: 16, 12, 8, 6, 4, 3, 2, 1
  rest: boolean;
  pitches: number[];
  notes: Note[];
  tieNext: boolean;
  cont: boolean; // continues a tied note (no accidental)
}

const VALUES = [16, 12, 8, 6, 4, 3, 2, 1];
function fits(a: number, v: number, barLen: number) {
  const half = barLen / 2;
  switch (v) {
    case 16: return a === 0 && barLen === 16;
    case 12: return (a === 0 || a === 4) && a + 12 <= barLen && barLen === 16;
    case 8: return a % 8 === 0;
    case 6: return a % 2 === 0 && Math.floor(a / half) === Math.floor((a + 5) / half);
    case 4: return a % 4 === 0 || (a % 2 === 0 && Math.floor(a / half) === Math.floor((a + 3) / half));
    case 3: return a % 4 === 0;
    case 2: return a % 2 === 0;
    default: return true;
  }
}
/** Splits [a, b) inside one bar into notatable values. */
export function splitSpan(a: number, b: number, barLen: number): { t: number; d: number }[] {
  const out: { t: number; d: number }[] = [];
  while (a < b) {
    const v = VALUES.find(v => a + v <= b && fits(a, v, barLen)) ?? 1;
    out.push({ t: a, d: v }); a += v;
  }
  return out;
}

/**
 * Lays one staff's notes into bars. `abs16(n)` gives a note's absolute start in 16ths; bars are `barLen` 16ths.
 * Returns pieces per bar index (relative to firstBar).
 */
export function layoutBars(notes: Note[], start16: (n: Note) => number, len16: (n: Note) => number, firstBar: number, bars: number, barLen: number): Piece[][] {
  type Ev = { a: number; b: number; notes: Note[] };
  const map = new Map<number, Ev>();
  for (const n of notes) {
    const a = start16(n), b = Math.max(a + 1, a + len16(n));
    const ev = map.get(a);
    if (ev) { ev.notes.push(n); ev.b = Math.max(ev.b, b); } else map.set(a, { a, b, notes: [n] });
  }
  const evs = [...map.values()].sort((x, y) => x.a - y.a);
  for (let i = 0; i < evs.length - 1; i++) evs[i].b = Math.min(evs[i].b, evs[i + 1].a);
  const out: Piece[][] = Array.from({ length: bars }, () => []);
  const s0 = firstBar * barLen, end = (firstBar + bars) * barLen;
  let cursor = s0;
  const restUntil = (to: number) => {
    while (cursor < to) {
      const bar = Math.floor(cursor / barLen), barEnd = Math.min(to, (bar + 1) * barLen);
      for (const p of splitSpan(cursor - bar * barLen, barEnd - bar * barLen, barLen)) out[bar - firstBar]?.push({ ...p, rest: true, pitches: [], notes: [], tieNext: false, cont: false });
      cursor = barEnd;
    }
  };
  for (const ev of evs) {
    if (ev.b <= s0 || ev.a >= end) continue;
    const a = Math.max(ev.a, s0), b = Math.min(ev.b, end);
    if (a > cursor) restUntil(a);
    let pos = a;
    const pitches = [...new Set(ev.notes.map(n => n.p))].sort((x, y) => x - y);
    const made: Piece[] = [];
    while (pos < b) {
      const bar = Math.floor(pos / barLen), barEnd = Math.min(b, (bar + 1) * barLen);
      for (const p of splitSpan(pos - bar * barLen, barEnd - bar * barLen, barLen)) {
        const pc: Piece = { ...p, rest: false, pitches, notes: ev.notes, tieNext: false, cont: false };
        out[bar - firstBar]?.push(pc); made.push(pc);
      }
      pos = barEnd;
    }
    made.forEach((p, i) => { p.tieNext = i < made.length - 1; p.cont = i > 0; });
    cursor = Math.max(cursor, b);
  }
  restUntil(end);
  return out;
}

/** Beam groups: runs of eighths/16ths (no rests) inside one beat. Returns arrays of piece indexes. */
export function beamGroups(pieces: Piece[]): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [], beat = -1;
  pieces.forEach((p, i) => {
    const short = !p.rest && p.d <= 3;
    const b = Math.floor(p.t / 4);
    if (short && b === beat && Math.floor((p.t + p.d - 1) / 4) === beat) cur.push(i);
    else { if (cur.length > 1) groups.push(cur); cur = short && Math.floor((p.t + p.d - 1) / 4) === b ? [i] : []; beat = b; }
  });
  if (cur.length > 1) groups.push(cur);
  return groups;
}
