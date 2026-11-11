// Built-in Audio FX plugins. Each definition builds a node chain on any BaseAudioContext
// (live or offline), so the same code runs for playback and for bounce.

import { MORE_PLUGINS, MoreType } from './plugins2';
import { THIRD_PLUGINS, ThirdType } from './plugins3';
import { FOURTH_PLUGINS, FourthType } from './plugins4';

export type PluginType = 'eq' | 'comp' | 'reverb' | 'delay' | 'chorus' | 'drive' | 'limiter' | 'tremolo' | 'autofilter' | MoreType | ThirdType | FourthType | 'wam' | 'native';

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  def: number;
  unit: string;
  log?: boolean;
  step?: number;
  /** Named choices (value = index), shown as a menu instead of a knob. */
  options?: string[];
}

export interface PluginInstance {
  input: AudioNode;
  output: AudioNode;
  set(params: Record<string, number>): void;
  dispose(): void;
  /** Optional live data for the plugin window. */
  eqNodes?: BiquadFilterNode[];
  reduction?: () => number;
  /** Waiting for an AudioWorklet module; the engine rebuilds it once loaded. */
  pending?: boolean;
  /** Analyzer plug-in: the spectrum source. */
  analyser?: AnalyserNode;
}

export interface PluginDef {
  type: PluginType;
  name: string;
  short: string;
  params: ParamDef[];
  /** Logic-style plug-in menu category. */
  category?: string;
  /** Factory presets: name -> params. */
  presets?: Record<string, Record<string, number>>;
  create(ctx: BaseAudioContext): PluginInstance;
}

/** A splitter that also works for mono sources (a plain splitter would leave the right side silent). */
export function stereoSplitter(ctx: BaseAudioContext) {
  const up = ctx.createGain(); up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
  const split = ctx.createChannelSplitter(2); up.connect(split);
  return Object.assign(split, { upmix: up });
}
const ramp = (p: AudioParam, v: number, ctx: BaseAudioContext) => {
  if (ctx instanceof OfflineAudioContext) p.value = v;
  else p.setTargetAtTime(v, ctx.currentTime, 0.015);
};

const EQ: PluginDef = {
  type: 'eq', name: 'Channel EQ', short: 'Channel EQ',
  params: [
    { id: 'hpf', label: 'Low Cut', min: 20, max: 1000, def: 20, unit: 'Hz', log: true },
    { id: 'lowGain', label: 'Low', min: -18, max: 18, def: 0, unit: 'dB', step: 0.5 },
    { id: 'lowFreq', label: 'Low Freq', min: 40, max: 500, def: 120, unit: 'Hz', log: true },
    { id: 'midGain', label: 'Mid', min: -18, max: 18, def: 0, unit: 'dB', step: 0.5 },
    { id: 'midFreq', label: 'Mid Freq', min: 200, max: 8000, def: 1000, unit: 'Hz', log: true },
    { id: 'midQ', label: 'Mid Q', min: 0.3, max: 8, def: 1, unit: '', log: true },
    { id: 'highGain', label: 'High', min: -18, max: 18, def: 0, unit: 'dB', step: 0.5 },
    { id: 'highFreq', label: 'High Freq', min: 2000, max: 16000, def: 8000, unit: 'Hz', log: true },
  ],
  create(ctx) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
    const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf';
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
    const hi = ctx.createBiquadFilter(); hi.type = 'highshelf';
    hp.connect(lo); lo.connect(mid); mid.connect(hi);
    return {
      input: hp, output: hi, eqNodes: [hp, lo, mid, hi],
      set(p) {
        ramp(hp.frequency, p.hpf <= 20.5 ? 10 : p.hpf, ctx);
        ramp(lo.gain, p.lowGain, ctx); ramp(lo.frequency, p.lowFreq, ctx);
        ramp(mid.gain, p.midGain, ctx); ramp(mid.frequency, p.midFreq, ctx); ramp(mid.Q, p.midQ, ctx);
        ramp(hi.gain, p.highGain, ctx); ramp(hi.frequency, p.highFreq, ctx);
      },
      dispose() { [hp, lo, mid, hi].forEach(n => n.disconnect()); },
    };
  },
};

const COMP: PluginDef = {
  type: 'comp', name: 'Compressor', short: 'Compressor',
  params: [
    { id: 'threshold', label: 'Threshold', min: -60, max: 0, def: -18, unit: 'dB', step: 0.5 },
    { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, unit: ':1', log: true, step: 0.1 },
    { id: 'attack', label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', log: true },
    { id: 'release', label: 'Release', min: 10, max: 1000, def: 150, unit: 'ms', log: true },
    { id: 'knee', label: 'Knee', min: 0, max: 40, def: 6, unit: 'dB', step: 0.5 },
    { id: 'makeup', label: 'Make-Up', min: 0, max: 24, def: 4, unit: 'dB', step: 0.5 },
  ],
  create(ctx) {
    const c = ctx.createDynamicsCompressor();
    const g = ctx.createGain();
    c.connect(g);
    return {
      input: c, output: g,
      reduction: () => c.reduction,
      set(p) {
        ramp(c.threshold, p.threshold, ctx); ramp(c.ratio, p.ratio, ctx); ramp(c.knee, p.knee, ctx);
        ramp(c.attack, p.attack / 1000, ctx); ramp(c.release, p.release / 1000, ctx);
        ramp(g.gain, Math.pow(10, p.makeup / 20), ctx);
      },
      dispose() { c.disconnect(); g.disconnect(); },
    };
  },
};

function makeIR(ctx: BaseAudioContext, seconds: number) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let s = 1234567 + c * 7919;
    for (let i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = s / 0x3fffffff - 1;
      const t = i / len;
      d[i] = n * Math.pow(1 - t, 2.2) * (i < sr * 0.004 ? i / (sr * 0.004) : 1);
    }
  }
  return buf;
}

const REVERB: PluginDef = {
  type: 'reverb', name: 'Space Reverb', short: 'Reverb',
  params: [
    { id: 'decay', label: 'Decay', min: 0.3, max: 8, def: 2.2, unit: 's', log: true },
    { id: 'predelay', label: 'Pre-Delay', min: 0, max: 200, def: 20, unit: 'ms' },
    { id: 'tone', label: 'Tone', min: 1000, max: 18000, def: 7000, unit: 'Hz', log: true },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain();
    const dry = ctx.createGain(), wet = ctx.createGain();
    const pre = ctx.createDelay(1), conv = ctx.createConvolver(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    input.connect(dry); dry.connect(output);
    input.connect(pre); pre.connect(conv); conv.connect(lp); lp.connect(wet); wet.connect(output);
    let curDecay = -1, timer: any = null;
    const setIR = (d: number) => { curDecay = d; conv.buffer = makeIR(ctx, d); };
    return {
      input, output,
      set(p) {
        if (curDecay < 0 || ctx instanceof OfflineAudioContext) setIR(p.decay);
        else if (Math.abs(p.decay - curDecay) > 0.01) { clearTimeout(timer); timer = setTimeout(() => setIR(p.decay), 120); }
        ramp(pre.delayTime, p.predelay / 1000, ctx); ramp(lp.frequency, p.tone, ctx);
        const m = p.mix / 100;
        ramp(dry.gain, Math.cos(m * Math.PI / 2), ctx); ramp(wet.gain, Math.sin(m * Math.PI / 2) * 0.9, ctx);
      },
      dispose() { clearTimeout(timer); [input, output, dry, wet, pre, conv, lp].forEach(n => n.disconnect()); },
    };
  },
};

const DELAY: PluginDef = {
  type: 'delay', name: 'Tape Delay', short: 'Delay',
  params: [
    { id: 'time', label: 'Time', min: 20, max: 1500, def: 375, unit: 'ms', log: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 90, def: 35, unit: '%' },
    { id: 'tone', label: 'Tone', min: 800, max: 16000, def: 4500, unit: 'Hz', log: true },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain();
    const dry = ctx.createGain(), wet = ctx.createGain();
    const dl = ctx.createDelay(2), fb = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    input.connect(dry); dry.connect(output);
    input.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(output);
    return {
      input, output,
      set(p) {
        ramp(dl.delayTime, p.time / 1000, ctx); ramp(fb.gain, p.feedback / 100, ctx); ramp(lp.frequency, p.tone, ctx);
        const m = p.mix / 100;
        ramp(dry.gain, Math.cos(m * Math.PI / 2), ctx); ramp(wet.gain, Math.sin(m * Math.PI / 2), ctx);
      },
      dispose() { [input, output, dry, wet, dl, fb, lp].forEach(n => n.disconnect()); },
    };
  },
};

// ---- modulation helpers ----
function lfo(ctx: BaseAudioContext, type: OscillatorType = 'sine') {
  const o = ctx.createOscillator(); o.type = type; const amt = ctx.createGain(); o.connect(amt); o.start(0);
  return { o, amt };
}

const CHORUS: PluginDef = {
  type: 'chorus', name: 'Chorus', short: 'Chorus',
  params: [
    { id: 'rate', label: 'Rate', min: 0.05, max: 8, def: 0.8, unit: 'Hz', log: true },
    { id: 'depth', label: 'Depth', min: 0, max: 100, def: 45, unit: '%' },
    { id: 'delay', label: 'Delay', min: 5, max: 40, def: 15, unit: 'ms' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 50, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    const split = stereoSplitter(ctx), merge = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1);
    const l1 = lfo(ctx), l2 = lfo(ctx); l2.o.detune.value = 700; // the right side moves a little differently
    l1.amt.connect(dl.delayTime); l2.amt.connect(dr.delayTime);
    input.connect(dry); dry.connect(output);
    input.connect(split.upmix); split.connect(dl, 0); split.connect(dr, 1); dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(wet); wet.connect(output);
    return {
      input, output,
      set(p) {
        ramp(l1.o.frequency, p.rate, ctx); ramp(l2.o.frequency, p.rate * 1.07, ctx);
        const d = p.delay / 1000, depth = (p.depth / 100) * d * 0.8;
        ramp(dl.delayTime, d, ctx); ramp(dr.delayTime, d * 1.1, ctx); ramp(l1.amt.gain, depth, ctx); ramp(l2.amt.gain, depth, ctx);
        const m = p.mix / 100; ramp(dry.gain, Math.cos(m * Math.PI / 2), ctx); ramp(wet.gain, Math.sin(m * Math.PI / 2), ctx);
      },
      dispose() { l1.o.stop(); l2.o.stop(); [input, output, dry, wet, split, merge, dl, dr, l1.o, l1.amt, l2.o, l2.amt].forEach(n => n.disconnect()); },
    };
  },
};

function driveCurve(amount: number) {
  const n = 2048, c = new Float32Array(n), k = amount * 0.9 + 1;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
}
const DRIVE: PluginDef = {
  type: 'drive', name: 'Overdrive', short: 'Overdrive',
  params: [
    { id: 'drive', label: 'Drive', min: 0, max: 40, def: 12, unit: 'dB', step: 0.5 },
    { id: 'tone', label: 'Tone', min: 500, max: 16000, def: 4000, unit: 'Hz', log: true },
    { id: 'output', label: 'Output', min: -24, max: 6, def: -6, unit: 'dB', step: 0.5 },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    const pre = ctx.createGain(), shaper = ctx.createWaveShaper(), lp = ctx.createBiquadFilter(), out = ctx.createGain();
    shaper.oversample = '4x'; lp.type = 'lowpass';
    input.connect(dry); dry.connect(output);
    input.connect(pre); pre.connect(shaper); shaper.connect(lp); lp.connect(out); out.connect(wet); wet.connect(output);
    let lastDrive = -1;
    return {
      input, output,
      set(p) {
        if (p.drive !== lastDrive) { shaper.curve = driveCurve(Math.pow(10, p.drive / 20) - 1); lastDrive = p.drive; }
        ramp(pre.gain, Math.pow(10, p.drive / 40), ctx); ramp(lp.frequency, p.tone, ctx); ramp(out.gain, Math.pow(10, p.output / 20), ctx);
        const m = p.mix / 100; ramp(dry.gain, 1 - m, ctx); ramp(wet.gain, m, ctx);
      },
      dispose() { [input, output, dry, wet, pre, shaper, lp, out].forEach(n => n.disconnect()); },
    };
  },
};

const LIMITER: PluginDef = {
  type: 'limiter', name: 'Limiter', short: 'Limiter',
  params: [
    { id: 'gain', label: 'Gain', min: 0, max: 18, def: 3, unit: 'dB', step: 0.5 },
    { id: 'ceiling', label: 'Ceiling', min: -12, max: 0, def: -0.3, unit: 'dB', step: 0.1 },
    { id: 'release', label: 'Release', min: 10, max: 800, def: 120, unit: 'ms', log: true },
  ],
  create(ctx) {
    const pre = ctx.createGain(), c = ctx.createDynamicsCompressor(), post = ctx.createGain();
    c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001;
    pre.connect(c); c.connect(post);
    return {
      input: pre, output: post, reduction: () => c.reduction,
      set(p) {
        ramp(pre.gain, Math.pow(10, p.gain / 20), ctx);
        ramp(c.threshold, p.ceiling - 1, ctx); ramp(c.release, p.release / 1000, ctx);
        ramp(post.gain, Math.pow(10, 0.9 / 20), ctx);
      },
      dispose() { [pre, c, post].forEach(n => n.disconnect()); },
    };
  },
};

const TREMOLO: PluginDef = {
  type: 'tremolo', name: 'Tremolo / Auto Pan', short: 'Tremolo',
  params: [
    { id: 'rate', label: 'Rate', min: 0.1, max: 16, def: 4, unit: 'Hz', log: true },
    { id: 'depth', label: 'Depth', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'pan', label: 'Auto Pan', min: 0, max: 100, def: 0, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain(), vca = ctx.createGain(), pan = ctx.createStereoPanner();
    const a = lfo(ctx), b = lfo(ctx);
    a.amt.connect(vca.gain); b.amt.connect(pan.pan);
    input.connect(vca); vca.connect(pan);
    return {
      input, output: pan,
      set(p) {
        ramp(a.o.frequency, p.rate, ctx); ramp(b.o.frequency, p.rate, ctx);
        const d = p.depth / 100; ramp(vca.gain, 1 - d / 2, ctx); ramp(a.amt.gain, d / 2, ctx); ramp(b.amt.gain, p.pan / 100, ctx);
      },
      dispose() { a.o.stop(); b.o.stop(); [input, vca, pan, a.o, a.amt, b.o, b.amt].forEach(n => n.disconnect()); },
    };
  },
};

const AUTOFILTER: PluginDef = {
  type: 'autofilter', name: 'Auto Filter', short: 'AutoFilter',
  params: [
    { id: 'cutoff', label: 'Cutoff', min: 80, max: 16000, def: 1200, unit: 'Hz', log: true },
    { id: 'reso', label: 'Resonance', min: 0.5, max: 18, def: 4, unit: '', log: true },
    { id: 'rate', label: 'LFO Rate', min: 0.05, max: 12, def: 0.5, unit: 'Hz', log: true },
    { id: 'depth', label: 'LFO Depth', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    const l = lfo(ctx); l.amt.connect(f.detune);
    input.connect(dry); dry.connect(output); input.connect(f); f.connect(wet); wet.connect(output);
    return {
      input, output,
      set(p) {
        ramp(f.frequency, p.cutoff, ctx); ramp(f.Q, p.reso, ctx); ramp(l.o.frequency, p.rate, ctx); ramp(l.amt.gain, (p.depth / 100) * 2400, ctx);
        const m = p.mix / 100; ramp(dry.gain, 1 - m, ctx); ramp(wet.gain, m, ctx);
      },
      dispose() { l.o.stop(); [input, output, dry, wet, f, l.o, l.amt].forEach(n => n.disconnect()); },
    };
  },
};

// categories + factory presets for the original set
EQ.category = 'EQ'; COMP.category = 'Dynamics'; LIMITER.category = 'Dynamics'; REVERB.category = 'Reverb'; DELAY.category = 'Delay';
CHORUS.category = 'Modulation'; TREMOLO.category = 'Modulation'; DRIVE.category = 'Distortion'; AUTOFILTER.category = 'Filter';
EQ.presets = {
  'Vocal Clarity': { hpf: 90, lowGain: -2, lowFreq: 200, midGain: -2, midFreq: 400, midQ: 1.2, highGain: 3, highFreq: 9000 },
  'Kick Punch': { hpf: 30, lowGain: 4, lowFreq: 70, midGain: -4, midFreq: 350, midQ: 1.5, highGain: 2, highFreq: 4000 },
  'Bright Acoustic': { hpf: 80, lowGain: -1, lowFreq: 150, midGain: 1, midFreq: 2500, midQ: 0.8, highGain: 3, highFreq: 10000 },
  'Low Cut Only': { hpf: 100, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1, highGain: 0, highFreq: 8000 },
};
COMP.presets = {
  'Vocal Leveler': { threshold: -22, ratio: 3, attack: 8, release: 120, knee: 8, makeup: 5 },
  'Drum Bus Glue': { threshold: -16, ratio: 2, attack: 30, release: 100, knee: 6, makeup: 3 },
  'Bass Control': { threshold: -20, ratio: 5, attack: 5, release: 80, knee: 4, makeup: 4 },
  'Heavy Squash': { threshold: -35, ratio: 12, attack: 1, release: 60, knee: 0, makeup: 12 },
};
REVERB.presets = { 'Small Room': { decay: 0.7, predelay: 5, tone: 6000, mix: 18 }, 'Big Hall': { decay: 3.5, predelay: 30, tone: 8000, mix: 30 }, 'Dark Ambience': { decay: 5, predelay: 60, tone: 2500, mix: 35 } };
for (const d of [...MORE_PLUGINS, ...THIRD_PLUGINS, ...FOURTH_PLUGINS]) d.category = d.category ?? 'Utility';

export const PLUGINS = Object.fromEntries([EQ, COMP, REVERB, DELAY, CHORUS, DRIVE, LIMITER, TREMOLO, AUTOFILTER, ...MORE_PLUGINS, ...THIRD_PLUGINS, ...FOURTH_PLUGINS].map(d => [d.type, d])) as Record<PluginType, PluginDef>;
export const PLUGIN_LIST: PluginDef[] = [EQ, GEQ(), COMP, LIMITER, ...MORE_PLUGINS.filter(d => d.type !== 'geq'), REVERB, DELAY, CHORUS, DRIVE, TREMOLO, AUTOFILTER, ...THIRD_PLUGINS, ...FOURTH_PLUGINS];
function GEQ() { return MORE_PLUGINS.find(d => d.type === 'geq')!; }
/** Logic's plug-in menu order. */
export const CATEGORIES = ['EQ', 'Dynamics', 'Reverb', 'Delay', 'Modulation', 'Distortion', 'Amps & Pedals', 'Filter', 'Pitch', 'Imaging', 'Metering', 'Utility'];
export const MAX_INSERTS = 15;

export const defaultParams = (t: PluginType) => Object.fromEntries(PLUGINS[t].params.map(p => [p.id, p.def]));

export function fmtParam(p: ParamDef, v: number) {
  let s: string;
  if (p.options) return p.options[Math.round(v)] ?? '';
  if (!p.unit && p.step === 1) return String(Math.round(v));
  if (p.unit === 'bit') return `${Math.round(v)} bit`;
  if (p.unit === 'x') return `${v < 10 ? v.toFixed(v % 1 ? 2 : 0) : Math.round(v)}x`;
  if (p.unit === 'note') { const n = Math.round(v); return `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12]}${Math.floor(n / 12) - 2}`; }
  if (p.unit === 'onoff') return v >= 0.5 ? 'On' : 'Off';
  if (p.unit === 'wave') return ['Saw', 'Square', 'Triangle', 'Sine'][Math.round(v)] ?? '';
  if (p.unit === 'st') return `${v > 0 ? '+' : ''}${Math.round(v)} st`;
  if (p.unit === 'ct') return `${Math.round(v)} ct`;
  if (p.unit === 'Hz') s = v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} k` : `${Math.round(v)} `;
  else if (p.unit === 'dB') s = `${v > 0 ? '+' : ''}${v.toFixed(1)} `;
  else if (p.unit === 'ms') s = v < 10 ? `${v.toFixed(1)} ` : `${Math.round(v)} `;
  else if (p.unit === ':1') s = `${v.toFixed(1)}`;
  else if (p.unit === 's') s = `${v.toFixed(1)} `;
  else if (p.unit === '%') s = `${Math.round(v)} `;
  else s = v.toFixed(2);
  if (p.id === 'hpf' && v <= 20.5) return 'Off';
  return s + p.unit;
}

// Normalized knob position <-> value
export const toNorm = (p: ParamDef, v: number) => p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
export const fromNorm = (p: ParamDef, n: number) => {
  n = Math.max(0, Math.min(1, n));
  let v = p.log ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
  if (p.step) v = Math.round(v / p.step) * p.step;
  return v;
};
