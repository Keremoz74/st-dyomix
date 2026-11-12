// Pro EQ: a free-form parametric EQ (up to 16 bands) edited by dragging points on the curve.
// Band types: Bell, Low Shelf, High Shelf, Low Cut, High Cut (12–48 dB/oct), Notch, Band Pass, Tilt.
import type { PluginDef, PluginInstance, ParamDef } from './plugins';

export const MAX_BANDS = 16;
export const BAND_TYPES = ['Bell', 'Low Shelf', 'High Shelf', 'Low Cut', 'High Cut', 'Notch', 'Band Pass', 'Tilt'];
export const SLOPES = ['12 dB/oct', '24 dB/oct', '36 dB/oct', '48 dB/oct'];
export const BAND_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac', '#ff8787', '#ffc078', '#a9e34b', '#63e6be', '#74c0fc', '#b197fc', '#e599f7'];
export const hasGain = (type: number) => type <= 2 || type === 7;
export const hasQ = (type: number) => type !== 1 && type !== 2 && type !== 7;

const k = (i: number, p: string) => `b${i}${p}`;
export const bandKeys = (i: number) => ({ on: k(i, 'on'), type: k(i, 'type'), f: k(i, 'f'), g: k(i, 'g'), q: k(i, 'q'), s: k(i, 's') });

const bandParams = (i: number): ParamDef[] => [
  { id: k(i, 'on'), label: `Band ${i + 1}`, min: 0, max: 1, def: 0, unit: 'onoff', step: 1 },
  { id: k(i, 'type'), label: 'Type', min: 0, max: BAND_TYPES.length - 1, def: 0, unit: '', step: 1, options: BAND_TYPES },
  { id: k(i, 'f'), label: 'Freq', min: 20, max: 20000, def: 1000, unit: 'Hz', log: true },
  { id: k(i, 'g'), label: 'Gain', min: -24, max: 24, def: 0, unit: 'dB', step: 0.1 },
  { id: k(i, 'q'), label: 'Q', min: 0.1, max: 18, def: 1, unit: '', log: true },
  { id: k(i, 's'), label: 'Slope', min: 0, max: 3, def: 1, unit: '', step: 1, options: SLOPES },
];

// Butterworth stage Qs for 2nd-order cascades (12, 24, 36, 48 dB/oct)
const BUTTER = [[0.7071], [0.5412, 1.3065], [0.5176, 0.7071, 1.9319], [0.5098, 0.6013, 0.9, 2.5629]];

type Preset = Record<string, number>;
const preset = (bands: [number, number, number, number, number?][], output = 0): Preset => {
  const p: Preset = { output };
  bands.forEach(([type, f, g, q, s], i) => Object.assign(p, { [k(i, 'on')]: 1, [k(i, 'type')]: type, [k(i, 'f')]: f, [k(i, 'g')]: g, [k(i, 'q')]: q, [k(i, 's')]: s ?? 1 }));
  return p;
};

export const PRO_EQ: PluginDef = {
  type: 'peq', name: 'Pro EQ', short: 'Pro EQ', category: 'EQ',
  params: [
    ...Array.from({ length: MAX_BANDS }, (_, i) => bandParams(i)).flat(),
    { id: 'output', label: 'Output', min: -24, max: 24, def: 0, unit: 'dB', step: 0.1 },
    { id: 'spectrum', label: 'Analyzer', min: 0, max: 1, def: 1, unit: 'onoff', step: 1 },
  ],
  presets: {
    'Vocal Clarity': preset([[3, 90, 0, 0.7, 1], [0, 300, -2.5, 1.2], [0, 3200, 2.5, 0.9], [2, 10000, 3, 0.7]]),
    'Kick Punch': preset([[3, 30, 0, 0.7, 2], [0, 60, 4, 1.4], [0, 350, -5, 1.6], [0, 4000, 3, 1.2]]),
    'Bass Tight': preset([[3, 35, 0, 0.7, 2], [1, 90, 2.5, 0.7], [0, 250, -3, 1.4], [0, 900, 2, 1.2]]),
    'Acoustic Guitar': preset([[3, 100, 0, 0.7, 1], [0, 200, -3, 1.2], [0, 2500, 1.5, 1], [2, 8000, 3, 0.7]]),
    'Low Cut 80 Hz': preset([[3, 80, 0, 0.7, 1]]),
    'Telephone': preset([[3, 400, 0, 0.7, 3], [4, 3000, 0, 0.7, 3], [0, 1500, 6, 1.2]]),
    'Air & Shine': preset([[2, 12000, 4, 0.7], [0, 5000, 1.5, 0.8]]),
    'Mud Remover': preset([[0, 280, -4, 1.4], [0, 500, -2, 2]]),
  },
  create(ctx): PluginInstance & { bandNodes: Map<number, BiquadFilterNode[]> } {
    const input = ctx.createGain(), out = ctx.createGain(), an = ctx.createAnalyser();
    an.fftSize = 4096; an.smoothingTimeConstant = 0.82; an.minDecibels = -96; an.maxDecibels = -6;
    out.connect(an);
    const all: BiquadFilterNode[] = [];
    const bandNodes = new Map<number, BiquadFilterNode[]>();
    let sig = '';
    const rebuild = (p: Record<string, number>, active: number[]) => {
      input.disconnect(); all.forEach(n => n.disconnect()); all.length = 0; bandNodes.clear();
      let prev: AudioNode = input;
      for (const i of active) {
        const t = Math.round(p[k(i, 'type')]), stages = t === 3 || t === 4 ? Math.round(p[k(i, 's')] ?? 1) + 1 : t === 7 ? 2 : 1;
        const nodes = Array.from({ length: stages }, () => ctx.createBiquadFilter());
        for (const n of nodes) { prev.connect(n); prev = n; all.push(n); }
        bandNodes.set(i, nodes);
      }
      prev.connect(out);
    };
    const inst = {
      input, output: out, eqNodes: all, analyser: an, bandNodes,
      set(p: Record<string, number>) {
        const active = Array.from({ length: MAX_BANDS }, (_, i) => i).filter(i => p[k(i, 'on')] >= 0.5);
        const s = active.map(i => `${i}:${Math.round(p[k(i, 'type')])}:${Math.round(p[k(i, 's')] ?? 1)}`).join(',');
        if (s !== sig) { sig = s; rebuild(p, active); }
        const now = ctx.currentTime;
        const put = (a: AudioParam, v: number) => { if (ctx instanceof OfflineAudioContext) a.value = v; else a.setTargetAtTime(v, now, 0.012); };
        for (const i of active) {
          const nodes = bandNodes.get(i)!, t = Math.round(p[k(i, 'type')]);
          const f = Math.min(ctx.sampleRate / 2 - 100, Math.max(10, p[k(i, 'f')])), g = p[k(i, 'g')] ?? 0, q = Math.max(0.1, p[k(i, 'q')] ?? 1);
          nodes.forEach((n, j) => {
            put(n.frequency, f);
            if (t === 0) { n.type = 'peaking'; put(n.gain, g); put(n.Q, q); }
            else if (t === 1) { n.type = 'lowshelf'; put(n.gain, g); }
            else if (t === 2) { n.type = 'highshelf'; put(n.gain, g); }
            else if (t === 3 || t === 4) {
              n.type = t === 3 ? 'highpass' : 'lowpass';
              // Web Audio takes the resonance of these filters in dB; the last stage carries the band's Q
              const bq = BUTTER[nodes.length - 1][j] * (j === nodes.length - 1 ? q / 0.7071 : 1);
              put(n.Q, 20 * Math.log10(bq));
            }
            else if (t === 5) { n.type = 'notch'; put(n.Q, q); }
            else if (t === 6) { n.type = 'bandpass'; put(n.Q, q); }
            else { n.type = j === 0 ? 'lowshelf' : 'highshelf'; put(n.gain, j === 0 ? -g / 2 : g / 2); }
          });
        }
        put(out.gain, Math.pow(10, (p.output ?? 0) / 20));
      },
      dispose() { input.disconnect(); all.forEach(n => n.disconnect()); out.disconnect(); an.disconnect(); },
    };
    return inst;
  },
};
