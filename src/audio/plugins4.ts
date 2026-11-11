// Fourth set of Audio FX, in the spirit of the classic Cubase / Pro Tools stock plug-ins (own designs):
// FET Compressor, Opto Compressor, Maximizer, Mod Delay, Rotary Speaker, Channel Strip and Pitch Correct.
import type { PluginDef, PluginInstance } from './plugins';
import { stereoSplitter } from './plugins';
import { ramp, wetDry, workletFx } from './plugins2';

const db = (v: number) => Math.pow(10, v / 20);
const disc = (...ns: AudioNode[]) => ns.forEach(n => { try { n.disconnect(); } catch { /* already */ } });
const curve = (fn: (x: number) => number, n = 2048) => { const c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.max(-1, Math.min(1, fn((i / (n - 1)) * 2 - 1))); return c; };
/** Gentle odd+even harmonic saturation with unity small-signal gain. */
const warm = (amt: number) => { const a = 1 + amt * 4; return curve(x => Math.tanh(a * (x + 0.08 * amt * x * x)) / a); };

const FET_RATIOS = [4, 8, 12, 20, 40];
const FET: PluginDef = {
  type: 'fetcomp', name: 'FET Compressor', short: 'FET Comp', category: 'Dynamics',
  params: [
    { id: 'input', label: 'Input', min: 0, max: 36, def: 18, unit: 'dB', step: 0.5 },
    { id: 'output', label: 'Output', min: -24, max: 12, def: -8, unit: 'dB', step: 0.5 },
    { id: 'ratio', label: 'Ratio', min: 0, max: 4, def: 0, unit: '', step: 1, options: ['4:1', '8:1', '12:1', '20:1', 'All Buttons'] },
    { id: 'attack', label: 'Attack', min: 0.02, max: 0.8, def: 0.2, unit: 'ms', log: true },
    { id: 'release', label: 'Release', min: 50, max: 1100, def: 250, unit: 'ms', log: true },
    { id: 'mix', label: 'Mix (parallel)', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: {
    'Vocal Grab': { input: 20, output: -10, ratio: 0, attack: 0.3, release: 200, mix: 100 },
    'Drum Smash (All Buttons)': { input: 28, output: -14, ratio: 4, attack: 0.02, release: 60, mix: 60 },
    'Bass Even-Out': { input: 16, output: -6, ratio: 1, attack: 0.5, release: 300, mix: 100 },
    'Parallel Drums': { input: 30, output: -12, ratio: 3, attack: 0.05, release: 80, mix: 40 },
  },
  create(ctx) {
    const w = wetDry(ctx);
    const inG = ctx.createGain(), c = ctx.createDynamicsCompressor(), sat = ctx.createWaveShaper(), outG = ctx.createGain();
    sat.oversample = '2x';
    w.input.connect(inG); inG.connect(c); c.connect(sat); sat.connect(outG); outG.connect(w.wet);
    let r = -1;
    return {
      input: w.input, output: w.output, reduction: () => c.reduction,
      set(p) {
        const ri = Math.round(p.ratio);
        // the compressor sees the input drive as a lower threshold (the FET has a fixed one)
        ramp(inG.gain, db(p.input * 0.25), ctx); ramp(c.threshold, -p.input * 0.85, ctx);
        ramp(c.ratio, Math.min(20, FET_RATIOS[ri] ?? 4), ctx); ramp(c.knee, ri === 4 ? 0 : 2, ctx);
        ramp(c.attack, p.attack / 1000, ctx); ramp(c.release, p.release / 1000, ctx);
        ramp(outG.gain, db(p.output + p.input * 0.55), ctx); w.mix(p.mix / 100);
        if (r !== ri) { r = ri; sat.curve = warm(ri === 4 ? 0.6 : 0.2); }
      },
      dispose() { disc(w.input, w.output, w.dry, w.wet, inG, c, sat, outG); },
    };
  },
};

const OPTO: PluginDef = {
  type: 'optocomp', name: 'Opto Compressor', short: 'Opto Comp', category: 'Dynamics',
  params: [
    { id: 'reduction', label: 'Peak Reduction', min: 0, max: 100, def: 45, unit: '' },
    { id: 'gain', label: 'Gain', min: 0, max: 40, def: 12, unit: 'dB', step: 0.5 },
    { id: 'mode', label: 'Mode', min: 0, max: 1, def: 0, unit: '', step: 1, options: ['Compress', 'Limit'] },
    { id: 'tube', label: 'Tube', min: 0, max: 100, def: 30, unit: '%' },
  ],
  presets: {
    'Smooth Vocal': { reduction: 50, gain: 14, mode: 0, tube: 30 },
    'Bass Leveler': { reduction: 60, gain: 16, mode: 1, tube: 40 },
    'Mix Glue': { reduction: 25, gain: 4, mode: 0, tube: 15 },
  },
  create(ctx) {
    const c = ctx.createDynamicsCompressor(), sat = ctx.createWaveShaper(), g = ctx.createGain();
    c.connect(sat); sat.connect(g);
    // optical cell: soft knee, gentle attack, slow program-dependent release
    c.knee.value = 18; c.attack.value = 0.01; c.release.value = 0.5;
    let t = -1;
    return {
      input: c, output: g, reduction: () => c.reduction,
      set(p) {
        ramp(c.threshold, -p.reduction * 0.45, ctx); ramp(c.ratio, Math.round(p.mode) === 1 ? 12 : 3, ctx);
        ramp(g.gain, db(p.gain - 6), ctx);
        if (t !== p.tube) { t = p.tube; sat.curve = warm(p.tube / 100 * 0.5); }
      },
      dispose() { disc(c, sat, g); },
    };
  },
};

const MAXIMIZER: PluginDef = {
  type: 'maximizer', name: 'Maximizer', short: 'Maximizer', category: 'Dynamics',
  params: [
    { id: 'optimize', label: 'Optimize', min: 0, max: 100, def: 40, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
    { id: 'release', label: 'Release', min: 10, max: 500, def: 60, unit: 'ms', log: true },
    { id: 'ceiling', label: 'Output Ceiling', min: -12, max: 0, def: -0.3, unit: 'dB', step: 0.1 },
    { id: 'soft', label: 'Soft Clip', min: 0, max: 1, def: 1, unit: '', step: 1, options: ['Off', 'On'] },
  ],
  presets: { 'Gentle Master': { optimize: 25, mix: 100, release: 80, ceiling: -0.3, soft: 1 }, 'Loud Master': { optimize: 70, mix: 100, release: 40, ceiling: -0.3, soft: 1 }, 'Drum Bus Push': { optimize: 55, mix: 60, release: 30, ceiling: -1, soft: 1 } },
  create(ctx) {
    const w = wetDry(ctx);
    const pre = ctx.createGain(), lim = ctx.createDynamicsCompressor(), clip = ctx.createWaveShaper(), out = ctx.createGain();
    lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; clip.oversample = '4x';
    w.input.connect(pre); pre.connect(lim); lim.connect(clip); clip.connect(out); out.connect(w.wet);
    let s = -1, ce = 99;
    return {
      input: w.input, output: w.output, reduction: () => lim.reduction,
      set(p) {
        const drive = p.optimize / 100 * 18;
        ramp(pre.gain, db(drive), ctx); ramp(lim.threshold, -2 - drive * 0.4, ctx); ramp(lim.release, p.release / 1000, ctx);
        ramp(out.gain, db(drive * 0.4 - 2), ctx); w.mix(p.mix / 100);
        if (s !== Math.round(p.soft) || ce !== p.ceiling) {
          s = Math.round(p.soft); ce = p.ceiling; const c = db(p.ceiling);
          clip.curve = curve(x => s ? c * Math.tanh(x * 1.4 / c) : Math.max(-c, Math.min(c, x)));
        }
      },
      dispose() { disc(w.input, w.output, w.dry, w.wet, pre, lim, clip, out); },
    };
  },
};

const MOD_DELAY: PluginDef = {
  type: 'moddelay', name: 'Mod Delay', short: 'ModDelay', category: 'Delay',
  params: [
    { id: 'time', label: 'Delay', min: 1, max: 1500, def: 350, unit: 'ms', log: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 95, def: 35, unit: '%' },
    { id: 'depth', label: 'Mod Depth', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'rate', label: 'Mod Rate', min: 0.05, max: 10, def: 0.8, unit: 'Hz', log: true },
    { id: 'lpf', label: 'LPF', min: 1000, max: 20000, def: 8000, unit: 'Hz', log: true },
    { id: 'spread', label: 'Stereo Spread', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%' },
  ],
  presets: { 'Chorus Echo': { time: 30, feedback: 20, depth: 60, rate: 0.6, lpf: 12000, spread: 80, mix: 40 }, 'Wide Quarter': { time: 375, feedback: 40, depth: 15, rate: 0.5, lpf: 6000, spread: 70, mix: 25 }, 'Slapback': { time: 95, feedback: 5, depth: 5, rate: 1, lpf: 9000, spread: 0, mix: 30 } },
  create(ctx) {
    const w = wetDry(ctx);
    const sp = stereoSplitter(ctx), m = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2), fl = ctx.createGain(), fr = ctx.createGain(), ll = ctx.createBiquadFilter(), lr = ctx.createBiquadFilter();
    const lfo = ctx.createOscillator(), ldep = ctx.createGain(), rdep = ctx.createGain();
    ll.type = lr.type = 'lowpass';
    w.input.connect(sp.upmix); sp.connect(dl, 0); sp.connect(dr, 1);
    dl.connect(ll); ll.connect(fl); fl.connect(dl); dr.connect(lr); lr.connect(fr); fr.connect(dr);
    ll.connect(m, 0, 0); lr.connect(m, 0, 1); m.connect(w.wet);
    lfo.connect(ldep); lfo.connect(rdep); ldep.connect(dl.delayTime); rdep.connect(dr.delayTime); lfo.start();
    return {
      input: w.input, output: w.output,
      set(p) {
        const t = p.time / 1000, off = t * 0.15 * p.spread / 100;
        ramp(dl.delayTime, Math.max(0.001, t - off), ctx); ramp(dr.delayTime, t + off, ctx);
        ramp(fl.gain, p.feedback / 100, ctx); ramp(fr.gain, p.feedback / 100, ctx);
        const dep = Math.min(t * 0.5, 0.006) * p.depth / 100;
        ramp(ldep.gain, dep, ctx); ramp(rdep.gain, -dep, ctx); ramp(lfo.frequency, p.rate, ctx);
        ramp(ll.frequency, p.lpf, ctx); ramp(lr.frequency, p.lpf, ctx); w.mix(p.mix / 100);
      },
      dispose() { lfo.stop(); disc(w.input, w.output, w.dry, w.wet, sp.upmix, sp, m, dl, dr, fl, fr, ll, lr, lfo, ldep, rdep); },
    };
  },
};

const ROTARY: PluginDef = {
  type: 'rotary', name: 'Rotary Speaker', short: 'Rotary', category: 'Modulation',
  params: [
    { id: 'speed', label: 'Speed', min: 0, max: 2, def: 1, unit: '', step: 1, options: ['Stop', 'Slow (Chorale)', 'Fast (Tremolo)'] },
    { id: 'accel', label: 'Acceleration', min: 0.2, max: 5, def: 1.5, unit: 's', log: true },
    { id: 'horn', label: 'Horn Level', min: -12, max: 6, def: 0, unit: 'dB', step: 0.5 },
    { id: 'drive', label: 'Drive', min: 0, max: 100, def: 25, unit: '%' },
    { id: 'width', label: 'Mic Width', min: 0, max: 100, def: 80, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: { 'Organ Chorale': { speed: 1, accel: 1.5, horn: 0, drive: 25, width: 80, mix: 100 }, 'Organ Fast': { speed: 2, accel: 1.2, horn: 1, drive: 40, width: 90, mix: 100 }, 'Guitar Leslie': { speed: 1, accel: 2, horn: 2, drive: 15, width: 70, mix: 70 } },
  create(ctx) {
    const w = wetDry(ctx);
    const pre = ctx.createWaveShaper(), lo = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
    lo.type = 'lowpass'; hi.type = 'highpass'; lo.frequency.value = hi.frequency.value = 800;
    w.input.connect(pre); pre.connect(lo); pre.connect(hi);
    // each rotor: amplitude + Doppler (delay) + left/right movement
    const rotor = (src: AudioNode, depthAmp: number, depthDop: number) => {
      const lfo = ctx.createOscillator(), amp = ctx.createGain(), ampDep = ctx.createGain(), del = ctx.createDelay(0.05), dopDep = ctx.createGain(), pan = ctx.createStereoPanner(), panDep = ctx.createGain(), lvl = ctx.createGain();
      amp.gain.value = 1 - depthAmp; ampDep.gain.value = depthAmp; del.delayTime.value = 0.004; dopDep.gain.value = depthDop;
      lfo.connect(ampDep); ampDep.connect(amp.gain); lfo.connect(dopDep); dopDep.connect(del.delayTime); lfo.connect(panDep); panDep.connect(pan.pan);
      src.connect(del); del.connect(amp); amp.connect(pan); pan.connect(lvl); lvl.connect(w.wet); lfo.start();
      lvl.gain.value = 1.8;
      return { lfo, panDep, lvl, nodes: [lfo, amp, ampDep, del, dopDep, pan, panDep, lvl] };
    };
    const horn = rotor(hi, 0.35, 0.0009), drum = rotor(lo, 0.2, 0.0004);
    let dv = -1;
    return {
      input: w.input, output: w.output,
      set(p) {
        const s = Math.round(p.speed), hz = [0, 0.8, 6.7][s], dhz = [0, 0.7, 5.9][s];
        const T = p.accel / 3;
        if (ctx instanceof OfflineAudioContext) { horn.lfo.frequency.value = hz || 0.0001; drum.lfo.frequency.value = dhz || 0.0001; }
        else { horn.lfo.frequency.setTargetAtTime(hz || 0.0001, ctx.currentTime, T); drum.lfo.frequency.setTargetAtTime(dhz || 0.0001, ctx.currentTime, T * 1.8); }
        ramp(horn.panDep.gain, p.width / 100 * 0.9, ctx); ramp(drum.panDep.gain, p.width / 100 * 0.5, ctx);
        ramp(horn.lvl.gain, 1.8 * db(p.horn), ctx); ramp(drum.lvl.gain, 1.8, ctx); w.mix(p.mix / 100);
        if (dv !== p.drive) { dv = p.drive; pre.curve = warm(p.drive / 100); }
      },
      dispose() { horn.lfo.stop(); drum.lfo.stop(); disc(w.input, w.output, w.dry, w.wet, pre, lo, hi, ...horn.nodes, ...drum.nodes); },
    };
  },
};

const STRIP: PluginDef = {
  type: 'strip', name: 'Channel Strip', short: 'Strip', category: 'Dynamics',
  params: [
    { id: 'hpf', label: 'High Pass', min: 20, max: 400, def: 60, unit: 'Hz', log: true },
    { id: 'low', label: 'Low (100 Hz)', min: -15, max: 15, def: 0, unit: 'dB', step: 0.5 },
    { id: 'midFreq', label: 'Mid Freq', min: 200, max: 8000, def: 1500, unit: 'Hz', log: true },
    { id: 'mid', label: 'Mid', min: -15, max: 15, def: 0, unit: 'dB', step: 0.5 },
    { id: 'high', label: 'High (10 kHz)', min: -15, max: 15, def: 0, unit: 'dB', step: 0.5 },
    { id: 'threshold', label: 'Comp Threshold', min: -50, max: 0, def: -16, unit: 'dB', step: 0.5 },
    { id: 'ratio', label: 'Comp Ratio', min: 1, max: 10, def: 3, unit: ':1', step: 0.1 },
    { id: 'sat', label: 'Saturation', min: 0, max: 100, def: 15, unit: '%' },
    { id: 'output', label: 'Output', min: -24, max: 24, def: 2, unit: 'dB', step: 0.5 },
  ],
  presets: {
    'Vocal': { hpf: 90, low: -2, midFreq: 3000, mid: 2, high: 3, threshold: -20, ratio: 3, sat: 15, output: 3 },
    'Kick': { hpf: 30, low: 4, midFreq: 400, mid: -4, high: 2, threshold: -14, ratio: 4, sat: 25, output: 1 },
    'Acoustic Guitar': { hpf: 100, low: -3, midFreq: 2500, mid: 1.5, high: 2.5, threshold: -18, ratio: 2.5, sat: 10, output: 2 },
    'Bass': { hpf: 35, low: 3, midFreq: 800, mid: 1.5, high: -2, threshold: -18, ratio: 4, sat: 30, output: 2 },
  },
  create(ctx) {
    const hp = ctx.createBiquadFilter(), lo = ctx.createBiquadFilter(), mid = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter();
    const c = ctx.createDynamicsCompressor(), sat = ctx.createWaveShaper(), out = ctx.createGain();
    hp.type = 'highpass'; hp.Q.value = 0.7; lo.type = 'lowshelf'; lo.frequency.value = 100; mid.type = 'peaking'; mid.Q.value = 1; hi.type = 'highshelf'; hi.frequency.value = 10000;
    c.knee.value = 6; c.attack.value = 0.008; c.release.value = 0.15;
    hp.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(c); c.connect(sat); sat.connect(out);
    let sv = -1;
    return {
      input: hp, output: out, reduction: () => c.reduction,
      set(p) {
        ramp(hp.frequency, p.hpf, ctx); ramp(lo.gain, p.low, ctx); ramp(mid.frequency, p.midFreq, ctx); ramp(mid.gain, p.mid, ctx); ramp(hi.gain, p.high, ctx);
        ramp(c.threshold, p.threshold, ctx); ramp(c.ratio, p.ratio, ctx); ramp(out.gain, db(p.output), ctx);
        if (sv !== p.sat) { sv = p.sat; sat.curve = warm(p.sat / 100 * 0.7); }
      },
      dispose() { disc(hp, lo, mid, hi, c, sat, out); },
    };
  },
};

export const SCALES = ['Chromatic', 'Major', 'Minor'];
const PITCH_CORRECT: PluginDef = {
  type: 'pitchcorrect', name: 'Pitch Correct', short: 'PitchCor', category: 'Pitch',
  params: [
    { id: 'key', label: 'Key', min: 0, max: 11, def: 0, unit: '', step: 1, options: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] },
    { id: 'scale', label: 'Scale', min: 0, max: 2, def: 0, unit: '', step: 1, options: SCALES },
    { id: 'speed', label: 'Speed', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'tolerance', label: 'Tolerance', min: 0, max: 50, def: 5, unit: 'ct' },
    { id: 'shift', label: 'Transpose', min: -12, max: 12, def: 0, unit: 'st', step: 1 },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: {
    'Natural (Chromatic)': { key: 0, scale: 0, speed: 45, tolerance: 15, shift: 0, mix: 100 },
    'Hard Tune (Robot)': { key: 0, scale: 0, speed: 100, tolerance: 0, shift: 0, mix: 100 },
    'A Minor Vocal': { key: 9, scale: 2, speed: 70, tolerance: 5, shift: 0, mix: 100 },
  },
  create(ctx): PluginInstance {
    return workletFx(ctx, 'daw-pitchcorrect', p => ({ key: p.key, scale: p.scale, speed: p.speed / 100, tolerance: p.tolerance, shift: p.shift, mix: p.mix / 100 }));
  },
};

export const FOURTH_PLUGINS = [FET, OPTO, STRIP, MAXIMIZER, MOD_DELAY, ROTARY, PITCH_CORRECT] as PluginDef[];
export type FourthType = 'fetcomp' | 'optocomp' | 'strip' | 'maximizer' | 'moddelay' | 'rotary' | 'pitchcorrect';
