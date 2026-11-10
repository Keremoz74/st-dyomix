// Step Sequencer patterns (Logic-style pattern regions).
// A pattern region is a MIDI region whose notes are generated from a grid of steps × rows.
// The pattern repeats for the whole region length; each row may have its own length (polyrhythms).
import type { Region, Note, Store } from './model';
import { DRUM_NAMES } from './audio/instruments';

export const MAX_STEPS = 64;
export interface PatternRow { p: number; cells: number[]; gate: number; len?: number; mute?: boolean; solo?: boolean }
export interface PatternState { steps: number; rate: number; swing: number; rows: PatternRow[] }

/** Step rates (steps per beat) with their Logic-style names. */
export const RATES: [number, string][] = [[2, '1/8'], [3, '1/8T'], [4, '1/16'], [6, '1/16T'], [8, '1/32']];
export const STEP_COUNTS = [8, 12, 16, 24, 32, 48, 64];

const empty = () => new Array(MAX_STEPS).fill(0);
export const DRUM_ROWS = [36, 38, 39, 42, 46, 41, 45, 48, 49, 51];
const NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (p: number) => `${NOTE[p % 12]}${Math.floor(p / 12) - 1}`;
export const rowName = (p: number, drums: boolean) => (drums && DRUM_NAMES[p]) || noteName(p);

/** A fresh pattern: a drum kit layout, or one octave of the project's major scale (high to low). */
export function newPattern(drums: boolean, key = 0, preset = drums ? 'Four on the Floor' : 'Arpeggio'): PatternState {
  const rows: PatternRow[] = drums
    ? DRUM_ROWS.map(p => ({ p, cells: empty(), gate: 0.5 }))
    : (() => { const tonic = 60 + (((key * 7) % 12) + 12) % 12 - (((key * 7) % 12 + 12) % 12 > 5 ? 12 : 0); return [12, 11, 9, 7, 5, 4, 2, 0].map(i => ({ p: tonic + i, cells: empty(), gate: 0.8 })); })();
  const pat: PatternState = { steps: 16, rate: 4, swing: 0, rows };
  applyPreset(pat, preset, drums);
  return pat;
}

export const DRUM_PRESETS = ['Empty', 'Four on the Floor', 'Rock', 'Hip-Hop', 'Trap Hats', 'Breakbeat'];
export const MELODIC_PRESETS = ['Empty', 'Arpeggio', 'Pulse', 'Climb'];

/** Fills the grid with one of the built-in patterns (keeps rows, steps and rate). */
export function applyPreset(pat: PatternState, name: string, drums: boolean) {
  for (const r of pat.rows) r.cells = empty();
  const n = pat.steps;
  const set = (p: number, idx: number[], v = 100) => { const r = pat.rows.find(x => x.p === p); if (r) for (const i of idx) if (i < n) r.cells[i] = v; };
  const every = (k: number, from = 0) => Array.from({ length: Math.ceil(n / k) }, (_, i) => from + i * k).filter(i => i < n);
  if (drums) {
    switch (name) {
      case 'Four on the Floor': set(36, every(4), 112); set(39, every(8, 4), 100); set(42, every(4, 2), 90); set(46, every(8, 6), 70); break;
      case 'Rock': set(36, [0, 6, 8, 16, 22, 24], 110); set(38, every(8, 4), 108); set(42, every(2), 84); every(4).forEach(i => set(42, [i], 100)); set(49, [0], 96); break;
      case 'Hip-Hop': set(36, [0, 7, 10, 16, 23, 26], 112); set(38, every(8, 4), 104); set(42, every(2), 76); every(4, 2).forEach(i => set(42, [i], 92)); break;
      case 'Trap Hats': set(36, [0, 11, 16, 27], 115); set(39, every(16, 8), 104); set(42, every(1), 70); every(4).forEach(i => set(42, [i], 100)); set(42, [13, 14, 15], 58); break;
      case 'Breakbeat': set(36, [0, 10, 16, 26], 112); set(38, [4, 12, 20, 25, 28], 104); set(42, every(2), 84); set(46, [14, 30], 76); break;
    }
  } else {
    const rows = pat.rows; // high → low
    const at = (row: number, idx: number[], v = 100) => { const r = rows[row]; if (r) for (const i of idx) if (i < n) r.cells[i] = v; };
    switch (name) {
      case 'Arpeggio': for (let i = 0; i < n; i += 2) at([7, 5, 3, 0, 3, 5][(i / 2) % 6], [i], i % 8 === 0 ? 108 : 88); break;
      case 'Pulse': for (let i = 0; i < n; i += 2) at(i % 16 < 8 ? 7 : 4, [i], i % 4 === 0 ? 110 : 80); break;
      case 'Climb': for (let i = 0; i < n; i++) if (i % 3 !== 2) at(7 - (i % 8), [i], 70 + (i % 4) * 12); break;
    }
  }
}

/** Duration of one pass through the pattern, in beats. */
export const patternBeats = (pat: PatternState) => pat.steps / pat.rate;

/** Regenerates a pattern region's notes from its grid. */
export function generatePattern(r: Region) {
  const pat = r.pattern; if (!pat) return;
  const dur = 1 / pat.rate, total = Math.ceil(r.length / dur - 1e-6);
  const solo = pat.rows.some(x => x.solo);
  // swing only makes sense on straight (binary) subdivisions: it delays every second step
  const swingAmt = pat.rate % 3 === 0 ? 0 : pat.swing * 0.5 * dur;
  const notes: Note[] = [];
  for (const row of pat.rows) {
    if (row.mute || (solo && !row.solo)) continue;
    const L = Math.max(1, Math.min(pat.steps, row.len ?? pat.steps));
    for (let i = 0; i < total; i++) {
      const v = row.cells[i % L] ?? 0;
      if (v <= 0) continue;
      const s = i * dur + (i % 2 === 1 ? swingAmt : 0);
      if (s >= r.length) continue;
      notes.push({ p: row.p, s, l: Math.max(0.02, Math.min(dur * row.gate, r.length - s)), v });
    }
  }
  r.notes = notes.sort((a, b) => a.s - b.s || a.p - b.p);
}

const sigs = new Map<string, string>();
/** Keeps every pattern region's notes in step with its grid and length (call after structural changes). */
export function syncPatterns(store: Store) {
  for (const r of store.project.regions) {
    if (!r.pattern) continue;
    const sig = JSON.stringify([r.pattern, r.length]);
    if (sigs.get(r.id) === sig && r.notes) continue;
    generatePattern(r); sigs.set(r.id, sig);
  }
}

export const clonePattern = (p: PatternState): PatternState => ({ ...p, rows: p.rows.map(r => ({ ...r, cells: [...r.cells] })) });
