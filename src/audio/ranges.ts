// Typical playing range (MIDI notes) of each instrument, so the Piano Roll opens on the right octaves.
import type { InstrumentState } from './instruments';
import { GM_DRUMS } from './gm';

type R = [number, number];
// General MIDI programs by number → range. Unlisted programs use their family's range.
const FAMILY: R[] = [
  [48, 84], // Piano
  [60, 96], // Chromatic Percussion
  [48, 84], // Organ
  [40, 76], // Guitar
  [28, 55], // Bass
  [55, 91], // Strings (violin family default)
  [48, 84], // Ensemble
  [52, 82], // Brass
  [55, 86], // Reed
  [60, 96], // Pipe
  [55, 91], // Synth Lead
  [48, 84], // Synth Pad
  [48, 84], // Synth Effects
  [48, 84], // World
  [36, 72], // Percussive
  [48, 84], // Sound Effects
];
const PROGRAM: Record<number, R> = {
  41: [48, 84], 42: [36, 72], 43: [28, 60], // viola, cello, contrabass
  57: [40, 72], 58: [28, 58], 60: [41, 77], // trombone, tuba, horn
  64: [56, 88], 65: [49, 81], 66: [44, 76], 67: [36, 69], // soprano, alto, tenor, baritone sax
  68: [58, 91], 69: [52, 81], 70: [34, 67], 71: [50, 89], // oboe, english horn, bassoon, clarinet
  72: [74, 108], // piccolo
  38: [24, 55], 39: [24, 55], 87: [28, 60], // synth basses, bass + lead
};
const DRUMS: R = [35, 59];

/** [low, high] MIDI notes where this instrument usually plays. */
export function instrumentRange(inst?: InstrumentState): R {
  if (!inst) return [48, 84];
  if (inst.type === 'drums') return DRUMS;
  if (inst.type === 'gm') {
    const p = Math.round(inst.params.program ?? 0);
    if (p === GM_DRUMS) return DRUMS;
    return PROGRAM[p] ?? FAMILY[Math.floor(p / 8)] ?? [48, 84];
  }
  const name = (inst.preset ?? '').toLowerCase();
  if (/bass|sub/.test(name)) return [28, 55];
  if (/lead|pluck/.test(name)) return [60, 91];
  return [48, 84];
}
