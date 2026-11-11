// Third set of Audio FX: Tape Delay, Vintage EQ, Pitch Shifter, Envelope Filter, Transient Designer,
// Tape Saturator, Fuzz, Wah and an Analyzer (spectrum display).
import type { PluginDef, PluginInstance } from './plugins';
import { ramp, wetDry, workletFx } from './plugins2';

const db = (v: number) => Math.pow(10, v / 20);
const disc = (...ns: AudioNode[]) => ns.forEach(n => { try { n.disconnect(); } catch { /* already */ } });
const curve = (fn: (x: number) => number, n = 2048) => { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.max(-1, Math.min(1, fn((i / (n - 1)) * 2 - 1))); return c; };

const TAPE_DELAY: PluginDef = {
  type: 'tapedelay', name: 'Tape Delay', short: 'TapeDly', category: 'Delay',
  params: [
    { id: 'time', label: 'Time', min: 20, max: 2000, def: 375, unit: 'ms', log: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 110, def: 45, unit: '%' },
    { id: 'wow', label: 'Wow', min: 0, max: 100, def: 20, unit: '%' },
    { id: 'flutter', label: 'Flutter', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'drive', label: 'Saturation', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'lowcut', label: 'Low Cut', min: 20, max: 1000, def: 150, unit: 'Hz', log: true },
    { id: 'highcut', label: 'High Cut', min: 1000, max: 12000, def: 3500, unit: 'Hz', log: true },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 30, unit: '%' },
  ],
  presets: {
    'Slapback': { time: 110, feedback: 10, wow: 10, flutter: 10, drive: 30, lowcut: 200, highcut: 5000, mix: 30 },
    'Dub Echo': { time: 500, feedback: 75, wow: 25, flutter: 15, drive: 50, lowcut: 300, highcut: 2200, mix: 40 },
    'Worn Cassette': { time: 300, feedback: 40, wow: 70, flutter: 60, drive: 45, lowcut: 250, highcut: 2500, mix: 35 },
    'Runaway (self-oscillate)': { time: 280, feedback: 105, wow: 30, flutter: 20, drive: 70, lowcut: 300, highcut: 3000, mix: 45 },
  },
  create(ctx) {
    const w = wetDry(ctx);
    const d = ctx.createDelay(2.5), fb = ctx.createGain(), sat = ctx.createWaveShaper(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
    const wow = ctx.createOscillator(), wowG = ctx.createGain(), flt = ctx.createOscillator(), fltG = ctx.createGain();
    hp.type = 'highpass'; lp.type = 'lowpass'; wow.frequency.value = 0.6; flt.frequency.value = 7.5;
    wow.connect(wowG); flt.connect(fltG); wowG.connect(d.delayTime); fltG.connect(d.delayTime); wow.start(); flt.start();
    w.input.connect(d); d.connect(sat); sat.connect(hp); hp.connect(lp); lp.connect(w.wet); lp.connect(fb); fb.connect(d);
    let k = -1;
    return {
      input: w.input, output: w.output,
      set(p) {
        ramp(d.delayTime, p.time / 1000, ctx); ramp(fb.gain, Math.min(1.1, p.feedback / 100), ctx);
        ramp(wowG.gain, 0.004 * p.wow / 100, ctx); ramp(fltG.gain, 0.0006 * p.flutter / 100, ctx);
        ramp(hp.frequency, p.lowcut, ctx); ramp(lp.frequency, p.highcut, ctx); w.mix(p.mix / 100);
        if (k !== p.drive) { k = p.drive; const a = 1 + p.drive / 15; sat.curve = curve(x => Math.tanh(a * x) / a); } // unity gain for small signals, so the feedback stays stable below 100%
      },
      dispose() { wow.stop(); flt.stop(); disc(w.input, w.output, w.dry, w.wet, d, fb, sat, hp, lp, wow, wowG, flt, fltG); },
    };
  },
};

const LOW_F = [20, 30, 60, 100], HIGH_F = [3000, 4000, 5000, 8000, 10000, 12000, 16000], ATT_F = [5000, 10000, 20000];
const VINTAGE_EQ: PluginDef = {
  type: 'veq', name: 'Vintage EQ', short: 'VintEQ', category: 'EQ',
  params: [
    { id: 'lowFreq', label: 'Low Freq', min: 0, max: 3, def: 2, unit: '', step: 1, options: LOW_F.map(f => `${f} Hz`) },
    { id: 'lowBoost', label: 'Low Boost', min: 0, max: 10, def: 0, unit: '', step: 0.1 },
    { id: 'lowAtten', label: 'Low Atten', min: 0, max: 10, def: 0, unit: '', step: 0.1 },
    { id: 'highFreq', label: 'High Freq', min: 0, max: 6, def: 4, unit: '', step: 1, options: HIGH_F.map(f => `${f / 1000} kHz`) },
    { id: 'highBoost', label: 'High Boost', min: 0, max: 10, def: 0, unit: '', step: 0.1 },
    { id: 'bandwidth', label: 'Bandwidth', min: 0, max: 10, def: 5, unit: '', step: 0.1 },
    { id: 'attFreq', label: 'Atten Freq', min: 0, max: 2, def: 1, unit: '', step: 1, options: ATT_F.map(f => `${f / 1000} kHz`) },
    { id: 'highAtten', label: 'High Atten', min: 0, max: 10, def: 0, unit: '', step: 0.1 },
    { id: 'output', label: 'Output', min: -12, max: 12, def: 0, unit: 'dB', step: 0.1 },
  ],
  presets: {
    'Fat Kick (boost + cut trick)': { lowFreq: 2, lowBoost: 6, lowAtten: 4, highFreq: 3, highBoost: 2, bandwidth: 5, attFreq: 1, highAtten: 0, output: -1 },
    'Silky Vocal Air': { lowFreq: 3, lowBoost: 0, lowAtten: 2, highFreq: 5, highBoost: 4, bandwidth: 7, attFreq: 2, highAtten: 2, output: 0 },
    'Warm Bus': { lowFreq: 1, lowBoost: 2.5, lowAtten: 0, highFreq: 4, highBoost: 1.5, bandwidth: 8, attFreq: 1, highAtten: 1.5, output: 0 },
  },
  create(ctx) {
    const lb = ctx.createBiquadFilter(), la = ctx.createBiquadFilter(), hb = ctx.createBiquadFilter(), ha = ctx.createBiquadFilter(), out = ctx.createGain();
    lb.type = 'lowshelf'; la.type = 'lowshelf'; hb.type = 'peaking'; ha.type = 'highshelf';
    lb.connect(la); la.connect(hb); hb.connect(ha); ha.connect(out);
    return {
      input: lb, output: out, eqNodes: [lb, la, hb, ha],
      set(p) {
        const lf = LOW_F[Math.round(p.lowFreq)] ?? 60;
        // boost shelf slightly lower than the cut shelf: the famous "both at once" bump-and-dip
        ramp(lb.frequency, lf * 1.6, ctx); ramp(lb.gain, p.lowBoost * 1.35, ctx);
        ramp(la.frequency, lf * 2.6, ctx); ramp(la.gain, -p.lowAtten * 1.2, ctx);
        ramp(hb.frequency, HIGH_F[Math.round(p.highFreq)] ?? 10000, ctx); ramp(hb.gain, p.highBoost * 1.6, ctx); ramp(hb.Q, 0.4 + (10 - p.bandwidth) * 0.25, ctx);
        ramp(ha.frequency, ATT_F[Math.round(p.attFreq)] ?? 10000, ctx); ramp(ha.gain, -p.highAtten * 1.6, ctx);
        ramp(out.gain, db(p.output), ctx);
      },
      dispose() { disc(lb, la, hb, ha, out); },
    };
  },
};

const PITCH: PluginDef = {
  type: 'pitch', name: 'Pitch Shifter', short: 'Pitch', category: 'Pitch',
  params: [
    { id: 'semi', label: 'Semitones', min: -12, max: 12, def: 0, unit: 'st', step: 1 },
    { id: 'cents', label: 'Cents', min: -100, max: 100, def: 0, unit: 'ct', step: 1 },
    { id: 'window', label: 'Grain', min: 20, max: 150, def: 60, unit: 'ms' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: { 'Octave Down': { semi: -12, cents: 0, window: 80, mix: 100 }, 'Octave Up': { semi: 12, cents: 0, window: 50, mix: 100 }, 'Fifth Harmony': { semi: 7, cents: 0, window: 60, mix: 45 }, 'Doubler (detune)': { semi: 0, cents: 9, window: 40, mix: 45 } },
  create: ctx => workletFx(ctx, 'daw-pitch', p => ({ ratio: Math.pow(2, (p.semi + p.cents / 100) / 12), window: p.window / 1000, mix: p.mix / 100 })),
};

const ENVFILTER: PluginDef = {
  type: 'envfilter', name: 'Envelope Filter', short: 'EnvFilt', category: 'Filter',
  params: [
    { id: 'sens', label: 'Sensitivity', min: -24, max: 24, def: 0, unit: 'dB', step: 0.5 },
    { id: 'base', label: 'Cutoff', min: 60, max: 2000, def: 250, unit: 'Hz', log: true },
    { id: 'range', label: 'Range', min: 0, max: 6, def: 3.5, unit: 'oct', step: 0.1 },
    { id: 'q', label: 'Resonance', min: 0.5, max: 15, def: 5, unit: '', step: 0.1, log: true },
    { id: 'attack', label: 'Attack', min: 0.5, max: 100, def: 5, unit: 'ms', log: true },
    { id: 'release', label: 'Release', min: 10, max: 1000, def: 120, unit: 'ms', log: true },
    { id: 'mode', label: 'Mode', min: 0, max: 2, def: 0, unit: '', step: 1, options: ['Lowpass', 'Bandpass', 'Highpass'] },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: { 'Funky Bass': { sens: 6, base: 180, range: 4, q: 6, attack: 3, release: 90, mode: 0, mix: 100 }, 'Quack Guitar': { sens: 3, base: 350, range: 3.5, q: 9, attack: 2, release: 70, mode: 1, mix: 90 }, 'Synth Squelch': { sens: 0, base: 120, range: 5, q: 12, attack: 1, release: 200, mode: 0, mix: 100 } },
  create: ctx => workletFx(ctx, 'daw-envfilter', p => ({ sens: p.sens, base: p.base, range: p.range, q: p.q, attack: p.attack, release: p.release, mode: p.mode, mix: p.mix / 100 })),
};

const TRANSIENT: PluginDef = {
  type: 'transient', name: 'Transient Designer', short: 'Transient', category: 'Dynamics',
  params: [
    { id: 'attack', label: 'Attack', min: -100, max: 100, def: 0, unit: '%' },
    { id: 'sustain', label: 'Sustain', min: -100, max: 100, def: 0, unit: '%' },
    { id: 'out', label: 'Output', min: -12, max: 12, def: 0, unit: 'dB', step: 0.1 },
  ],
  presets: { 'Punchy Drums': { attack: 60, sustain: -20, out: -2 }, 'Tighten Room': { attack: 10, sustain: -60, out: 0 }, 'Soften Attacks': { attack: -50, sustain: 20, out: 1 } },
  create: ctx => workletFx(ctx, 'daw-transient', p => ({ attack: p.attack, sustain: p.sustain, out: p.out })),
};

const TAPE_SAT: PluginDef = {
  type: 'tapesat', name: 'Tape Saturator', short: 'TapeSat', category: 'Distortion',
  params: [
    { id: 'drive', label: 'Drive', min: 0, max: 24, def: 6, unit: 'dB', step: 0.5 },
    { id: 'bias', label: 'Bias', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'bump', label: 'Head Bump', min: 0, max: 6, def: 2, unit: 'dB', step: 0.1 },
    { id: 'rolloff', label: 'HF Rolloff', min: 6000, max: 20000, def: 15000, unit: 'Hz', log: true },
    { id: 'output', label: 'Output', min: -24, max: 6, def: -4, unit: 'dB', step: 0.1 },
  ],
  presets: { 'Gentle Glue': { drive: 4, bias: 20, bump: 1.5, rolloff: 16000, output: -2.5 }, 'Hot 15 ips': { drive: 12, bias: 35, bump: 3, rolloff: 13000, output: -7 }, 'Lo-Fi 7.5 ips': { drive: 16, bias: 50, bump: 4, rolloff: 7500, output: -9 } },
  create(ctx) {
    const input = ctx.createGain(), sh = ctx.createWaveShaper(), bump = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), output = ctx.createGain();
    sh.oversample = '2x'; bump.type = 'peaking'; bump.frequency.value = 85; bump.Q.value = 1.2; lp.type = 'lowpass'; lp.Q.value = 0.6;
    input.connect(sh); sh.connect(bump); bump.connect(lp); lp.connect(output);
    let key = '';
    return {
      input, output,
      set(p) {
        ramp(input.gain, db(p.drive), ctx); ramp(bump.gain, p.bump, ctx); ramp(lp.frequency, p.rolloff, ctx); ramp(output.gain, db(p.output), ctx);
        const k = `${p.bias}`; if (k !== key) { key = k; const b = p.bias / 250; sh.curve = curve(x => Math.tanh(1.2 * (x + b)) - Math.tanh(1.2 * b)); }
      },
      dispose() { disc(input, sh, bump, lp, output); },
    };
  },
};

const FUZZ: PluginDef = {
  type: 'fuzz', name: 'Fuzz Pedal', short: 'Fuzz', category: 'Amps & Pedals',
  params: [
    { id: 'fuzz', label: 'Fuzz', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'tone', label: 'Tone', min: 400, max: 8000, def: 2500, unit: 'Hz', log: true },
    { id: 'octave', label: 'Octave Up', min: 0, max: 100, def: 0, unit: '%' },
    { id: 'level', label: 'Level', min: -30, max: 6, def: -12, unit: 'dB', step: 0.5 },
  ],
  presets: { 'Big Muff-ish': { fuzz: 85, tone: 1800, octave: 0, level: -14 }, 'Velcro Fuzz': { fuzz: 100, tone: 3500, octave: 0, level: -16 }, 'Octave Fuzz': { fuzz: 75, tone: 3000, octave: 70, level: -14 } },
  create(ctx) {
    const input = ctx.createGain(), hp = ctx.createBiquadFilter(), pre = ctx.createGain(), sh = ctx.createWaveShaper(), oct = ctx.createWaveShaper(), octG = ctx.createGain();
    const tone = ctx.createBiquadFilter(), output = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 90; tone.type = 'lowpass'; tone.Q.value = 0.7; sh.oversample = '4x'; oct.oversample = '4x';
    oct.curve = curve(x => Math.abs(x) * 2 - 0.5); // full-wave rectifier = octave up
    input.connect(hp); hp.connect(pre); pre.connect(sh); sh.connect(tone); pre.connect(oct); oct.connect(octG); octG.connect(tone); tone.connect(output);
    let k = -1;
    return {
      input, output,
      set(p) {
        ramp(pre.gain, 1 + p.fuzz / 2, ctx); ramp(tone.frequency, p.tone, ctx); ramp(octG.gain, p.octave / 120, ctx); ramp(output.gain, db(p.level), ctx);
        if (k !== p.fuzz) { k = p.fuzz; const a = 2 + p.fuzz; sh.curve = curve(x => Math.sign(x) * (1 - Math.exp(-a * Math.abs(x)))); }
      },
      dispose() { disc(input, hp, pre, sh, oct, octG, tone, output); },
    };
  },
};

const WAH: PluginDef = {
  type: 'wah', name: 'Wah Pedal', short: 'Wah', category: 'Amps & Pedals',
  params: [
    { id: 'mode', label: 'Mode', min: 0, max: 1, def: 1, unit: '', step: 1, options: ['Manual (pedal)', 'Auto (LFO)'] },
    { id: 'pedal', label: 'Pedal', min: 0, max: 100, def: 50, unit: '%' },
    { id: 'rate', label: 'Rate', min: 0.1, max: 8, def: 1.5, unit: 'Hz', log: true },
    { id: 'depth', label: 'Depth', min: 0, max: 100, def: 80, unit: '%' },
    { id: 'q', label: 'Resonance', min: 1, max: 20, def: 8, unit: '', step: 0.1, log: true },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: { 'Classic Auto Wah': { mode: 1, pedal: 50, rate: 1.5, depth: 80, q: 8, mix: 100 }, 'Slow Sweep': { mode: 1, pedal: 50, rate: 0.3, depth: 90, q: 10, mix: 100 }, 'Cocked Wah (fixed)': { mode: 0, pedal: 70, rate: 1, depth: 0, q: 9, mix: 100 } },
  create(ctx) {
    const w = wetDry(ctx);
    const bp = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), amt = ctx.createGain(), mk = ctx.createGain();
    bp.type = 'bandpass'; lfo.connect(amt); amt.connect(bp.frequency); lfo.start();
    w.input.connect(bp); bp.connect(mk); mk.connect(w.wet);
    return {
      input: w.input, output: w.output,
      set(p) {
        // sweep 350 Hz – 2.2 kHz like a real pedal
        const lo = 350, hi = 2200, centre = lo * Math.pow(hi / lo, p.pedal / 100);
        const auto = Math.round(p.mode) === 1;
        ramp(bp.frequency, auto ? Math.sqrt(lo * hi) : centre, ctx);
        ramp(amt.gain, auto ? (hi - lo) / 2 * p.depth / 100 : 0, ctx); ramp(lfo.frequency, p.rate, ctx);
        ramp(bp.Q, p.q, ctx); ramp(mk.gain, 1 + p.q / 6, ctx); w.mix(p.mix / 100);
      },
      dispose() { lfo.stop(); disc(w.input, w.output, w.dry, w.wet, bp, lfo, amt, mk); },
    };
  },
};

const ANALYZER: PluginDef = {
  type: 'analyzer', name: 'Analyzer', short: 'Analyzer', category: 'Metering',
  params: [
    { id: 'speed', label: 'Response', min: 0, max: 2, def: 1, unit: '', step: 1, options: ['Fast', 'Medium', 'Slow'] },
    { id: 'range', label: 'Range', min: 0, max: 1, def: 0, unit: '', step: 1, options: ['−90 dB', '−60 dB'] },
  ],
  create(ctx): PluginInstance & { analyser: AnalyserNode } {
    const g = ctx.createGain(), an = ctx.createAnalyser();
    an.fftSize = 4096; g.connect(an);
    return { input: g, output: g, analyser: an, set(p) { an.smoothingTimeConstant = [0.5, 0.8, 0.93][Math.round(p.speed)] ?? 0.8; an.minDecibels = Math.round(p.range) === 1 ? -60 : -90; an.maxDecibels = 0; }, dispose() { disc(g, an); } };
  },
};

export const THIRD_PLUGINS = [TAPE_DELAY, VINTAGE_EQ, PITCH, ENVFILTER, TRANSIENT, TAPE_SAT, FUZZ, WAH, ANALYZER] as PluginDef[];
export type ThirdType = 'tapedelay' | 'veq' | 'pitch' | 'envfilter' | 'transient' | 'tapesat' | 'fuzz' | 'wah' | 'analyzer';
