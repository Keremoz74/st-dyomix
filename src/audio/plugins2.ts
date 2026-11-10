// More Audio FX, modeled on the stock plug-ins of a full DAW (Logic-style categories):
// Dynamics: Noise Gate, DeEsser, Multipressor · Modulation: Phaser, Flanger, Ring Modulator
// Distortion: Amp Designer, Bitcrusher, Exciter · Reverb: Space Designer (convolution)
// Delay: Stereo Delay · EQ: Graphic EQ · Imaging: Stereo Spread · Utility: Gain
import type { PluginDef, PluginInstance } from './plugins';
import { workletsReady } from './worklets';
import { stereoSplitter } from './plugins';

const ramp = (p: AudioParam, v: number, ctx: BaseAudioContext) => {
  if (!isFinite(v)) return;
  if (ctx instanceof OfflineAudioContext) p.value = v;
  else p.setTargetAtTime(v, ctx.currentTime, 0.015);
};
const db = (v: number) => Math.pow(10, v / 20);
const off = (ctx: BaseAudioContext) => ctx instanceof OfflineAudioContext;
const disc = (...ns: AudioNode[]) => ns.forEach(n => { try { n.disconnect(); } catch { /* already */ } });
function wetDry(ctx: BaseAudioContext) {
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  input.connect(dry); dry.connect(output); wet.connect(output);
  const mix = (m: number) => { ramp(dry.gain, Math.cos(m * Math.PI / 2), ctx); ramp(wet.gain, Math.sin(m * Math.PI / 2), ctx); };
  return { input, output, dry, wet, mix };
}
/** Plug-in built on an AudioWorklet processor; passes audio through until the worklet module is loaded. */
function workletFx(ctx: BaseAudioContext, name: string, params: (p: Record<string, number>) => Record<string, number>, outGain?: (p: Record<string, number>) => number): PluginInstance {
  const input = ctx.createGain(), output = ctx.createGain();
  if (!workletsReady(ctx)) { input.connect(output); return { input, output, pending: true, set() {}, dispose() { disc(input, output); } }; }
  const node = new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  input.connect(node); node.connect(output);
  let red = 0;
  node.port.onmessage = e => { red = e.data; };
  return {
    input, output,
    set(p) { const v = params(p); for (const k in v) { const ap = (node.parameters as any).get(k) as AudioParam | undefined; if (ap) ramp(ap, v[k], ctx); } if (outGain) ramp(output.gain, outGain(p), ctx); },
    reduction: () => { node.port.postMessage(0); return red; },
    dispose() { disc(input, node, output); },
  };
}

// ---------------- Dynamics ----------------
const GATE: PluginDef = {
  type: 'gate', name: 'Noise Gate', short: 'Gate', category: 'Dynamics',
  params: [
    { id: 'threshold', label: 'Threshold', min: -80, max: 0, def: -40, unit: 'dB', step: 0.5 },
    { id: 'range', label: 'Reduction', min: -100, max: 0, def: -80, unit: 'dB', step: 1 },
    { id: 'attack', label: 'Attack', min: 0.1, max: 50, def: 1, unit: 'ms', log: true },
    { id: 'hold', label: 'Hold', min: 0, max: 500, def: 50, unit: 'ms' },
    { id: 'release', label: 'Release', min: 5, max: 2000, def: 120, unit: 'ms', log: true },
    { id: 'hysteresis', label: 'Hysteresis', min: 0, max: 20, def: 6, unit: 'dB', step: 0.5 },
  ],
  presets: {
    'Vocal Cleanup': { threshold: -48, range: -20, attack: 2, hold: 80, release: 200, hysteresis: 6 },
    'Tight Drums': { threshold: -30, range: -80, attack: 0.3, hold: 20, release: 60, hysteresis: 4 },
    'Guitar Noise': { threshold: -55, range: -60, attack: 1, hold: 100, release: 250, hysteresis: 8 },
  },
  create: ctx => workletFx(ctx, 'daw-gate', p => ({ threshold: p.threshold, range: p.range, attack: p.attack, hold: p.hold, release: p.release, hysteresis: p.hysteresis })),
};

const DEESSER: PluginDef = {
  type: 'deesser', name: 'DeEsser', short: 'DeEsser', category: 'Dynamics',
  params: [
    { id: 'freq', label: 'Frequency', min: 2000, max: 12000, def: 6000, unit: 'Hz', log: true },
    { id: 'threshold', label: 'Threshold', min: -60, max: 0, def: -30, unit: 'dB', step: 0.5 },
    { id: 'reduction', label: 'Max Reduction', min: 2, max: 20, def: 10, unit: ':1', log: true, step: 0.1 },
  ],
  presets: { 'Female Vocal': { freq: 7500, threshold: -32, reduction: 8 }, 'Male Vocal': { freq: 5500, threshold: -30, reduction: 8 }, 'Harsh Cymbals': { freq: 9000, threshold: -26, reduction: 6 } },
  create(ctx) {
    // split band: lows pass straight through, highs go through a fast compressor
    const input = ctx.createGain(), output = ctx.createGain();
    const lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter(), hp1 = ctx.createBiquadFilter(), hp2 = ctx.createBiquadFilter();
    [lp1, lp2].forEach(f => { f.type = 'lowpass'; f.Q.value = 0.707; }); [hp1, hp2].forEach(f => { f.type = 'highpass'; f.Q.value = 0.707; });
    const comp = ctx.createDynamicsCompressor(); comp.attack.value = 0.0005; comp.release.value = 0.06; comp.knee.value = 3;
    input.connect(lp1); lp1.connect(lp2); lp2.connect(output);
    input.connect(hp1); hp1.connect(hp2); hp2.connect(comp); comp.connect(output);
    return {
      input, output, reduction: () => comp.reduction,
      set(p) { [lp1, lp2, hp1, hp2].forEach(f => ramp(f.frequency, p.freq, ctx)); ramp(comp.threshold, p.threshold, ctx); ramp(comp.ratio, p.reduction, ctx); },
      dispose() { disc(input, lp1, lp2, hp1, hp2, comp, output); },
    };
  },
};

const MULTI: PluginDef = {
  type: 'multi', name: 'Multipressor', short: 'Multipress', category: 'Dynamics',
  params: [
    { id: 'xLow', label: 'Low/Mid', min: 60, max: 1000, def: 200, unit: 'Hz', log: true },
    { id: 'xHigh', label: 'Mid/High', min: 1000, max: 12000, def: 3000, unit: 'Hz', log: true },
    { id: 'thLow', label: 'Low Thresh', min: -60, max: 0, def: -20, unit: 'dB', step: 0.5 },
    { id: 'thMid', label: 'Mid Thresh', min: -60, max: 0, def: -20, unit: 'dB', step: 0.5 },
    { id: 'thHigh', label: 'High Thresh', min: -60, max: 0, def: -20, unit: 'dB', step: 0.5 },
    { id: 'ratio', label: 'Ratio', min: 1, max: 20, def: 3, unit: ':1', log: true, step: 0.1 },
    { id: 'gLow', label: 'Low Gain', min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 },
    { id: 'gMid', label: 'Mid Gain', min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 },
    { id: 'gHigh', label: 'High Gain', min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 },
    { id: 'attack', label: 'Attack', min: 0.5, max: 100, def: 10, unit: 'ms', log: true },
    { id: 'release', label: 'Release', min: 20, max: 1000, def: 150, unit: 'ms', log: true },
  ],
  presets: {
    'Master Glue': { xLow: 150, xHigh: 4000, thLow: -18, thMid: -16, thHigh: -18, ratio: 2, gLow: 1, gMid: 0, gHigh: 1, attack: 20, release: 200 },
    'Bass Tamer': { xLow: 120, xHigh: 2500, thLow: -24, thMid: -12, thHigh: -12, ratio: 4, gLow: 0, gMid: 0, gHigh: 0, attack: 8, release: 120 },
    'Vocal Presence': { xLow: 250, xHigh: 5000, thLow: -20, thMid: -22, thHigh: -26, ratio: 3, gLow: -1, gMid: 2, gHigh: 1.5, attack: 5, release: 100 },
  },
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain();
    const lr = (type: BiquadFilterType) => { const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter(); a.type = b.type = type; a.Q.value = b.Q.value = 0.707; a.connect(b); return [a, b]; };
    const lowLP = lr('lowpass'), midHP = lr('highpass'), midLP = lr('lowpass'), highHP = lr('highpass');
    const comps = [0, 1, 2].map(() => ctx.createDynamicsCompressor()), gains = [0, 1, 2].map(() => ctx.createGain());
    input.connect(lowLP[0]); lowLP[1].connect(comps[0]);
    input.connect(midHP[0]); midHP[1].connect(midLP[0]); midLP[1].connect(comps[1]);
    input.connect(highHP[0]); highHP[1].connect(comps[2]);
    comps.forEach((c, i) => { c.knee.value = 6; c.connect(gains[i]); gains[i].connect(output); });
    return {
      input, output, reduction: () => Math.min(...comps.map(c => c.reduction)),
      set(p) {
        [...lowLP, ...midHP].forEach(f => ramp(f.frequency, p.xLow, ctx)); [...midLP, ...highHP].forEach(f => ramp(f.frequency, p.xHigh, ctx));
        [p.thLow, p.thMid, p.thHigh].forEach((t, i) => ramp(comps[i].threshold, t, ctx));
        comps.forEach(c => { ramp(c.ratio, p.ratio, ctx); ramp(c.attack, p.attack / 1000, ctx); ramp(c.release, p.release / 1000, ctx); });
        [p.gLow, p.gMid, p.gHigh].forEach((g, i) => ramp(gains[i].gain, db(g), ctx));
      },
      dispose() { disc(input, output, ...lowLP, ...midHP, ...midLP, ...highHP, ...comps, ...gains); },
    };
  },
};

// ---------------- Modulation ----------------
const PHASER: PluginDef = {
  type: 'phaser', name: 'Phaser', short: 'Phaser', category: 'Modulation',
  params: [
    { id: 'rate', label: 'Rate', min: 0.05, max: 10, def: 0.5, unit: 'Hz', log: true },
    { id: 'depth', label: 'Depth', min: 0, max: 100, def: 70, unit: '%' },
    { id: 'center', label: 'Center', min: 200, max: 4000, def: 900, unit: 'Hz', log: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 90, def: 50, unit: '%' },
    { id: 'stages', label: 'Stages', min: 0, max: 2, def: 1, unit: '', step: 1, options: ['4', '6', '8'] },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 50, unit: '%' },
  ],
  presets: { 'Slow Swirl': { rate: 0.2, depth: 80, center: 700, feedback: 60, stages: 2, mix: 50 }, 'Funky Guitar': { rate: 1.6, depth: 60, center: 1200, feedback: 40, stages: 1, mix: 50 }, 'Subtle Keys': { rate: 0.4, depth: 40, center: 900, feedback: 20, stages: 0, mix: 35 } },
  create(ctx) {
    const w = wetDry(ctx);
    const aps = Array.from({ length: 8 }, () => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.5; return f; });
    const fb = ctx.createGain(), lfo = ctx.createOscillator(), lfoAmt = ctx.createGain();
    lfo.connect(lfoAmt); aps.forEach(a => lfoAmt.connect(a.frequency)); lfo.start();
    let n = -1;
    const wire = (stages: number) => {
      if (stages === n) return; n = stages;
      disc(...aps); disc(fb);
      lfoAmt.disconnect(); aps.forEach(a => lfoAmt.connect(a.frequency));
      w.input.connect(aps[0]);
      for (let i = 0; i < stages - 1; i++) aps[i].connect(aps[i + 1]);
      aps[stages - 1].connect(w.wet); aps[stages - 1].connect(fb); fb.connect(aps[0]);
    };
    return {
      input: w.input, output: w.output,
      set(p) {
        wire([4, 6, 8][Math.round(p.stages)] ?? 6);
        aps.forEach(a => ramp(a.frequency, p.center, ctx));
        ramp(lfo.frequency, p.rate, ctx); ramp(lfoAmt.gain, p.center * 0.9 * p.depth / 100, ctx);
        ramp(fb.gain, p.feedback / 100 * 0.9, ctx); w.mix(p.mix / 100);
      },
      dispose() { lfo.stop(); disc(w.input, w.output, w.dry, w.wet, fb, lfo, lfoAmt, ...aps); },
    };
  },
};

const FLANGER: PluginDef = {
  type: 'flanger', name: 'Flanger', short: 'Flanger', category: 'Modulation',
  params: [
    { id: 'rate', label: 'Rate', min: 0.05, max: 5, def: 0.3, unit: 'Hz', log: true },
    { id: 'depth', label: 'Depth', min: 0, max: 100, def: 60, unit: '%' },
    { id: 'delay', label: 'Delay', min: 0.5, max: 10, def: 2.5, unit: 'ms', log: true },
    { id: 'feedback', label: 'Feedback', min: -90, max: 90, def: 50, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 50, unit: '%' },
  ],
  presets: { 'Jet Plane': { rate: 0.12, depth: 90, delay: 3, feedback: 75, mix: 50 }, 'Metallic': { rate: 0.8, depth: 40, delay: 1, feedback: -70, mix: 50 }, 'Gentle': { rate: 0.25, depth: 40, delay: 2.5, feedback: 20, mix: 35 } },
  create(ctx) {
    const w = wetDry(ctx);
    const d = ctx.createDelay(0.05), fb = ctx.createGain(), lfo = ctx.createOscillator(), amt = ctx.createGain();
    lfo.type = 'triangle'; lfo.connect(amt); amt.connect(d.delayTime); lfo.start();
    w.input.connect(d); d.connect(w.wet); d.connect(fb); fb.connect(d);
    return {
      input: w.input, output: w.output,
      set(p) {
        ramp(d.delayTime, p.delay / 1000, ctx); ramp(amt.gain, (p.delay / 1000) * 0.95 * p.depth / 100, ctx);
        ramp(lfo.frequency, p.rate, ctx); ramp(fb.gain, p.feedback / 100 * 0.95, ctx); w.mix(p.mix / 100);
      },
      dispose() { lfo.stop(); disc(w.input, w.output, w.dry, w.wet, d, fb, lfo, amt); },
    };
  },
};

const RINGMOD: PluginDef = {
  type: 'ringmod', name: 'Ring Modulator', short: 'RingMod', category: 'Modulation',
  params: [
    { id: 'freq', label: 'Frequency', min: 1, max: 5000, def: 220, unit: 'Hz', log: true },
    { id: 'wave', label: 'Wave', min: 0, max: 3, def: 3, unit: 'wave', step: 1 },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 50, unit: '%' },
  ],
  presets: { 'Robot Voice': { freq: 60, wave: 3, mix: 70 }, 'Bell Tones': { freq: 680, wave: 3, mix: 60 }, 'Tremolo-ish': { freq: 6, wave: 2, mix: 40 } },
  create(ctx) {
    const w = wetDry(ctx);
    const vca = ctx.createGain(), osc = ctx.createOscillator();
    vca.gain.value = 0; osc.connect(vca.gain); osc.start();
    w.input.connect(vca); vca.connect(w.wet);
    return {
      input: w.input, output: w.output,
      set(p) { osc.type = (['sawtooth', 'square', 'triangle', 'sine'] as OscillatorType[])[Math.round(p.wave)] ?? 'sine'; ramp(osc.frequency, p.freq, ctx); w.mix(p.mix / 100); },
      dispose() { osc.stop(); disc(w.input, w.output, w.dry, w.wet, vca, osc); },
    };
  },
};

// ---------------- Distortion ----------------
const AMP_MODELS = ['Clean', 'Crunch', 'British Lead', 'High Gain', 'Bass'];
const CABS = ['1x12 Open Back', '2x12 British', '4x12 Closed', '1x15 Bass', 'DI (No Cab)'];
function ampCurve(model: number, drive: number) {
  const n = 2048, c = new Float32Array(n), k = 1 + drive * [2, 8, 20, 45, 6][model];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y: number;
    if (model === 0) y = Math.tanh(k * x * 0.6) / Math.tanh(k * 0.6);           // clean: soft, mostly linear
    else if (model === 3) y = Math.tanh(k * (x + 0.08)) - Math.tanh(k * 0.08);   // high gain: asymmetric, saturated
    else y = (2 / Math.PI) * Math.atan(k * x) / ((2 / Math.PI) * Math.atan(k));  // crunch/lead/bass
    c[i] = Math.max(-1, Math.min(1, y));
  }
  return c;
}
const AMP: PluginDef = {
  type: 'amp', name: 'Amp Designer', short: 'Amp', category: 'Amps & Pedals',
  params: [
    { id: 'model', label: 'Amp', min: 0, max: 4, def: 1, unit: '', step: 1, options: AMP_MODELS },
    { id: 'cab', label: 'Cabinet', min: 0, max: 4, def: 1, unit: '', step: 1, options: CABS },
    { id: 'gain', label: 'Gain', min: 0, max: 10, def: 5, unit: '', step: 0.1 },
    { id: 'bass', label: 'Bass', min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 },
    { id: 'mid', label: 'Mids', min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 },
    { id: 'treble', label: 'Treble', min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 },
    { id: 'presence', label: 'Presence', min: -12, max: 12, def: 2, unit: 'dB', step: 0.5 },
    { id: 'master', label: 'Master', min: -30, max: 6, def: -6, unit: 'dB', step: 0.5 },
  ],
  presets: {
    'Sparkling Clean': { model: 0, cab: 0, gain: 3, bass: 1, mid: -1, treble: 3, presence: 3, master: -4 },
    'Classic Crunch': { model: 1, cab: 1, gain: 5.5, bass: 0, mid: 2, treble: 1, presence: 2, master: -8 },
    'Lead Solo': { model: 2, cab: 2, gain: 7.5, bass: 1, mid: 4, treble: 0, presence: 3, master: -12 },
    'Metal Rhythm': { model: 3, cab: 2, gain: 8.5, bass: 4, mid: -5, treble: 3, presence: 4, master: -15 },
    'Bass Amp': { model: 4, cab: 3, gain: 3.5, bass: 4, mid: 0, treble: -2, presence: 0, master: -6 },
  },
  create(ctx) {
    const input = ctx.createGain(), pre = ctx.createGain(), hp = ctx.createBiquadFilter(), shaper = ctx.createWaveShaper();
    const bass = ctx.createBiquadFilter(), mid = ctx.createBiquadFilter(), treble = ctx.createBiquadFilter(), pres = ctx.createBiquadFilter();
    const cabLP = ctx.createBiquadFilter(), cabHP = ctx.createBiquadFilter(), cabPk = ctx.createBiquadFilter(), output = ctx.createGain();
    hp.type = 'highpass'; hp.frequency.value = 70; shaper.oversample = '4x';
    bass.type = 'lowshelf'; bass.frequency.value = 120; mid.type = 'peaking'; mid.frequency.value = 750; mid.Q.value = 0.8;
    treble.type = 'highshelf'; treble.frequency.value = 3000; pres.type = 'peaking'; pres.frequency.value = 4500; pres.Q.value = 1;
    cabLP.type = 'lowpass'; cabHP.type = 'highpass'; cabPk.type = 'peaking';
    input.connect(hp); hp.connect(pre); pre.connect(shaper); shaper.connect(bass); bass.connect(mid); mid.connect(treble); treble.connect(pres);
    pres.connect(cabHP); cabHP.connect(cabPk); cabPk.connect(cabLP); cabLP.connect(output);
    let curve = '';
    return {
      input, output,
      set(p) {
        const m = Math.round(p.model), c = Math.round(p.cab);
        const key = `${m}:${p.gain.toFixed(1)}`;
        if (key !== curve) { curve = key; shaper.curve = ampCurve(m, p.gain / 10); }
        ramp(pre.gain, m === 4 ? 1.2 : 1 + p.gain / 4, ctx);
        ramp(bass.gain, p.bass + (m === 4 ? 3 : 0), ctx); ramp(mid.gain, p.mid + (m === 2 ? 3 : m === 3 ? -3 : 0), ctx); ramp(treble.gain, p.treble, ctx); ramp(pres.gain, p.presence, ctx);
        const cab = [[5500, 80, 2200, 2], [4800, 90, 1800, 3], [4200, 100, 1500, 4], [3500, 40, 800, 2], [18000, 20, 1000, 0]][c] ?? [5000, 80, 2000, 2];
        ramp(cabLP.frequency, cab[0], ctx); cabLP.Q.value = 0.9; ramp(cabHP.frequency, cab[1], ctx); ramp(cabPk.frequency, cab[2], ctx); ramp(cabPk.gain, cab[3], ctx);
        ramp(output.gain, db(p.master) * (m >= 2 ? 0.5 : 0.8), ctx);
      },
      dispose() { disc(input, pre, hp, shaper, bass, mid, treble, pres, cabLP, cabHP, cabPk, output); },
    };
  },
};

const CRUSHER: PluginDef = {
  type: 'crusher', name: 'Bitcrusher', short: 'Bitcrush', category: 'Distortion',
  params: [
    { id: 'bits', label: 'Resolution', min: 1, max: 16, def: 8, unit: 'bit', step: 1 },
    { id: 'downsample', label: 'Downsampling', min: 1, max: 50, def: 4, unit: 'x', step: 1, log: true },
    { id: 'drive', label: 'Drive', min: 0, max: 24, def: 0, unit: 'dB', step: 0.5 },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%' },
  ],
  presets: { '8-bit Console': { bits: 6, downsample: 6, drive: 3, mix: 100 }, 'Lo-Fi Drums': { bits: 10, downsample: 3, drive: 6, mix: 60 }, 'Destroyed': { bits: 3, downsample: 20, drive: 12, mix: 100 } },
  create(ctx) {
    const inst = workletFx(ctx, 'daw-crusher', p => ({ bits: p.bits, downsample: p.downsample, mix: p.mix / 100 }));
    const drive = ctx.createGain(), input = drive;
    drive.connect(inst.input);
    return { ...inst, input, set(p) { ramp(drive.gain, db(p.drive), ctx); inst.set(p); }, dispose() { disc(drive); inst.dispose(); } };
  },
};

const EXCITER: PluginDef = {
  type: 'exciter', name: 'Exciter', short: 'Exciter', category: 'Distortion',
  params: [
    { id: 'freq', label: 'Frequency', min: 1000, max: 12000, def: 4000, unit: 'Hz', log: true },
    { id: 'harmonics', label: 'Harmonics', min: 0, max: 100, def: 40, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 30, unit: '%' },
  ],
  presets: { 'Vocal Air': { freq: 6000, harmonics: 35, mix: 25 }, 'Dull Recording Fix': { freq: 3000, harmonics: 50, mix: 40 } },
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), hp = ctx.createBiquadFilter(), sh = ctx.createWaveShaper(), hp2 = ctx.createBiquadFilter(), wet = ctx.createGain();
    hp.type = 'highpass'; hp2.type = 'highpass'; sh.oversample = '2x';
    input.connect(output); input.connect(hp); hp.connect(sh); sh.connect(hp2); hp2.connect(wet); wet.connect(output);
    let k = -1;
    return {
      input, output,
      set(p) {
        ramp(hp.frequency, p.freq, ctx); ramp(hp2.frequency, p.freq, ctx); ramp(wet.gain, p.mix / 100 * 1.5, ctx);
        if (k !== p.harmonics) { k = p.harmonics; const c = new Float32Array(1024), a = 1 + k / 5; for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(a * x) / Math.tanh(a); } sh.curve = c; }
      },
      dispose() { disc(input, output, hp, sh, hp2, wet); },
    };
  },
};

// ---------------- Reverb ----------------
const SPACES = ['Room', 'Chamber', 'Hall', 'Plate', 'Cathedral', 'Spring'];
/** Synthesizes an impulse response: early reflections + a damped, diffuse noise tail. */
export function synthIR(ctx: BaseAudioContext, space: number, decay: number, size: number, damping: number) {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * Math.min(12, decay * 1.2 + 0.1)));
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 1234 + space * 77;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  const er = [[7, 11, 17, 23, 31], [9, 15, 22, 34, 47], [13, 21, 33, 48, 66], [3, 5, 8, 12, 15], [19, 31, 47, 71, 97], [4, 9, 14, 21, 27]][space] ?? [10, 20, 30];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-6.9 * t / decay);
      const damp = Math.min(0.97, damping * (0.3 + t / decay));            // more high-frequency loss as the tail decays
      let v = rnd();
      if (space === 3) v *= 1 + 0.3 * Math.sin(i * 0.37);                   // plate: denser, brighter
      if (space === 5) v = v * 0.6 + Math.sin(2 * Math.PI * 1800 * t * (1 + 0.1 * Math.sin(t * 40))) * 0.4; // spring "boing"
      lp = lp * damp + v * (1 - damp);
      d[i] = lp * env * (t < 0.008 * size ? t / (0.008 * size) : 1);
    }
    for (const ms of er) { const i = Math.floor(ms * size * sr / 1000) + ch * 7; if (i < len) d[i] += (ch ? -0.6 : 0.6) * Math.exp(-ms / 60); }
  }
  return buf;
}
const SPACE: PluginDef = {
  type: 'space', name: 'Space Designer', short: 'SpaceDsgn', category: 'Reverb',
  params: [
    { id: 'space', label: 'Space', min: 0, max: 5, def: 2, unit: '', step: 1, options: SPACES },
    { id: 'decay', label: 'Length', min: 0.2, max: 10, def: 2.5, unit: 's', log: true },
    { id: 'size', label: 'Size', min: 0.3, max: 3, def: 1, unit: 'x', log: true },
    { id: 'damping', label: 'Damping', min: 0, max: 0.95, def: 0.5, unit: '', step: 0.01 },
    { id: 'predelay', label: 'Pre-Delay', min: 0, max: 250, def: 15, unit: 'ms' },
    { id: 'lowcut', label: 'Low Cut', min: 20, max: 1000, def: 120, unit: 'Hz', log: true },
    { id: 'width', label: 'Width', min: 0, max: 150, def: 100, unit: '%' },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%' },
  ],
  presets: {
    'Vocal Plate': { space: 3, decay: 1.8, size: 1, damping: 0.35, predelay: 30, lowcut: 200, width: 110, mix: 22 },
    'Drum Room': { space: 0, decay: 0.8, size: 0.8, damping: 0.55, predelay: 5, lowcut: 150, width: 100, mix: 18 },
    'Concert Hall': { space: 2, decay: 3.2, size: 1.4, damping: 0.5, predelay: 25, lowcut: 100, width: 120, mix: 28 },
    'Huge Cathedral': { space: 4, decay: 7.5, size: 2.5, damping: 0.6, predelay: 60, lowcut: 120, width: 140, mix: 35 },
    'Surf Spring': { space: 5, decay: 2.2, size: 0.6, damping: 0.3, predelay: 0, lowcut: 250, width: 70, mix: 30 },
  },
  create(ctx) {
    const w = wetDry(ctx);
    const pre = ctx.createDelay(0.5), hp = ctx.createBiquadFilter(), conv = ctx.createConvolver();
    const split = stereoSplitter(ctx), merge = ctx.createChannelMerger(2);
    const mid = ctx.createGain(), sideL = ctx.createGain(), sideR = ctx.createGain(), sideAmt = ctx.createGain();
    hp.type = 'highpass';
    w.input.connect(pre); pre.connect(hp); hp.connect(conv);
    // width: M/S on the reverb return
    conv.connect(split.upmix);
    split.connect(mid, 0); split.connect(mid, 1); mid.gain.value = 0.5;
    split.connect(sideL, 0); split.connect(sideR, 1); sideL.gain.value = 0.5; sideR.gain.value = -0.5;
    sideL.connect(sideAmt); sideR.connect(sideAmt);
    const inv = ctx.createGain(); inv.gain.value = -1; sideAmt.connect(inv);
    mid.connect(merge, 0, 0); mid.connect(merge, 0, 1); sideAmt.connect(merge, 0, 0); inv.connect(merge, 0, 1);
    merge.connect(w.wet);
    let key = '', timer: any = null;
    const build = (p: Record<string, number>) => { conv.buffer = synthIR(ctx, Math.round(p.space), p.decay, p.size, p.damping); };
    return {
      input: w.input, output: w.output,
      set(p) {
        const k = `${Math.round(p.space)}:${p.decay.toFixed(2)}:${p.size.toFixed(2)}:${p.damping.toFixed(2)}`;
        if (k !== key) { const first = !key; key = k; if (first || off(ctx)) build(p); else { clearTimeout(timer); timer = setTimeout(() => build(p), 150); } }
        ramp(pre.delayTime, p.predelay / 1000, ctx); ramp(hp.frequency, p.lowcut, ctx); ramp(sideAmt.gain, p.width / 100, ctx);
        w.mix(p.mix / 100);
      },
      dispose() { clearTimeout(timer); disc(w.input, w.output, w.dry, w.wet, pre, hp, conv, split, merge, mid, sideL, sideR, sideAmt, inv); },
    };
  },
};

// ---------------- Delay ----------------
const STEREO_DELAY: PluginDef = {
  type: 'sdelay', name: 'Stereo Delay', short: 'StDelay', category: 'Delay',
  params: [
    { id: 'left', label: 'Left Time', min: 1, max: 2000, def: 375, unit: 'ms', log: true },
    { id: 'right', label: 'Right Time', min: 1, max: 2000, def: 500, unit: 'ms', log: true },
    { id: 'feedback', label: 'Feedback', min: 0, max: 95, def: 35, unit: '%' },
    { id: 'cross', label: 'Crossfeed', min: 0, max: 100, def: 30, unit: '%' },
    { id: 'lowcut', label: 'Low Cut', min: 20, max: 2000, def: 200, unit: 'Hz', log: true },
    { id: 'highcut', label: 'High Cut', min: 1000, max: 20000, def: 7000, unit: 'Hz', log: true },
    { id: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%' },
  ],
  presets: { 'Ping Pong 1/8': { left: 250, right: 500, feedback: 40, cross: 80, lowcut: 250, highcut: 6000, mix: 25 }, 'Wide Slap': { left: 90, right: 120, feedback: 10, cross: 0, lowcut: 150, highcut: 9000, mix: 20 }, 'Dub Echo': { left: 375, right: 750, feedback: 70, cross: 40, lowcut: 400, highcut: 2500, mix: 35 } },
  create(ctx) {
    const w = wetDry(ctx);
    const split = stereoSplitter(ctx), merge = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(2.1), dr = ctx.createDelay(2.1), fl = ctx.createGain(), fr = ctx.createGain(), xl = ctx.createGain(), xr = ctx.createGain();
    const hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(); hp.type = 'highpass'; lp.type = 'lowpass';
    w.input.connect(hp); hp.connect(lp); lp.connect(split.upmix);
    split.connect(dl, 0); split.connect(dr, 1);
    dl.connect(fl); fl.connect(dl); dr.connect(fr); fr.connect(dr);
    dl.connect(xl); xl.connect(dr); dr.connect(xr); xr.connect(dl);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(w.wet);
    return {
      input: w.input, output: w.output,
      set(p) {
        ramp(dl.delayTime, p.left / 1000, ctx); ramp(dr.delayTime, p.right / 1000, ctx);
        const fb = p.feedback / 100 * 0.95, x = p.cross / 100;
        ramp(fl.gain, fb * (1 - x), ctx); ramp(fr.gain, fb * (1 - x), ctx); ramp(xl.gain, fb * x, ctx); ramp(xr.gain, fb * x, ctx);
        ramp(hp.frequency, p.lowcut, ctx); ramp(lp.frequency, p.highcut, ctx); w.mix(p.mix / 100);
      },
      dispose() { disc(w.input, w.output, w.dry, w.wet, split, merge, dl, dr, fl, fr, xl, xr, hp, lp); },
    };
  },
};

// ---------------- EQ ----------------
const GEQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const GRAPHIC_EQ: PluginDef = {
  type: 'geq', name: 'Graphic EQ', short: 'GraphicEQ', category: 'EQ',
  params: GEQ_BANDS.map(f => ({ id: `b${f}`, label: f >= 1000 ? `${f / 1000}k` : String(f), min: -12, max: 12, def: 0, unit: 'dB', step: 0.5 })),
  presets: {
    'Smile': Object.fromEntries(GEQ_BANDS.map((f, i) => [`b${f}`, [4, 3, 1, -1, -2, -2, -1, 1, 3, 4][i]])),
    'Telephone': Object.fromEntries(GEQ_BANDS.map((f, i) => [`b${f}`, [-12, -12, -10, -3, 3, 6, 4, -6, -12, -12][i]])),
    'Warmth': Object.fromEntries(GEQ_BANDS.map((f, i) => [`b${f}`, [1, 2, 2.5, 1.5, 0, -0.5, -1, -1.5, -2, -2][i]])),
  },
  create(ctx) {
    const fs = GEQ_BANDS.map((f, i) => { const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === GEQ_BANDS.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.4; return b; });
    for (let i = 0; i < fs.length - 1; i++) fs[i].connect(fs[i + 1]);
    return { input: fs[0], output: fs[fs.length - 1], eqNodes: fs, set(p) { fs.forEach((b, i) => ramp(b.gain, p[`b${GEQ_BANDS[i]}`], ctx)); }, dispose() { disc(...fs); } };
  },
};

// ---------------- Imaging / Utility ----------------
const SPREAD: PluginDef = {
  type: 'spread', name: 'Stereo Spread', short: 'Spread', category: 'Imaging',
  params: [
    { id: 'width', label: 'Width', min: 0, max: 200, def: 130, unit: '%' },
    { id: 'haas', label: 'Haas Delay', min: 0, max: 30, def: 0, unit: 'ms', step: 0.1 },
    { id: 'lowmono', label: 'Bass Mono', min: 20, max: 400, def: 20, unit: 'Hz', log: true },
  ],
  presets: { 'Wide Pads': { width: 170, haas: 0, lowmono: 150 }, 'Mono Check': { width: 0, haas: 0, lowmono: 20 }, 'Double Tracked': { width: 120, haas: 14, lowmono: 120 } },
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain();
    const split = stereoSplitter(ctx), merge = ctx.createChannelMerger(2);
    const mL = ctx.createGain(), mR = ctx.createGain(), sL = ctx.createGain(), sR = ctx.createGain(), side = ctx.createGain(), inv = ctx.createGain(), mid = ctx.createGain();
    const sideHP = ctx.createBiquadFilter(), haas = ctx.createDelay(0.05);
    sideHP.type = 'highpass';
    input.connect(split.upmix);
    split.connect(mL, 0); split.connect(mR, 1); mL.gain.value = mR.gain.value = 0.5; mL.connect(mid); mR.connect(mid);
    split.connect(sL, 0); split.connect(sR, 1); sL.gain.value = 0.5; sR.gain.value = -0.5; sL.connect(sideHP); sR.connect(sideHP); sideHP.connect(side);
    inv.gain.value = -1; side.connect(inv);
    mid.connect(merge, 0, 0); mid.connect(haas); haas.connect(merge, 0, 1);
    side.connect(merge, 0, 0); inv.connect(merge, 0, 1);
    merge.connect(output);
    return {
      input, output,
      set(p) { ramp(side.gain, p.width / 100, ctx); ramp(haas.delayTime, p.haas / 1000, ctx); ramp(sideHP.frequency, p.lowmono <= 20.5 ? 10 : p.lowmono, ctx); },
      dispose() { disc(input, output, split, merge, mL, mR, sL, sR, side, inv, mid, sideHP, haas); },
    };
  },
};

const GAIN: PluginDef = {
  type: 'gain', name: 'Gain', short: 'Gain', category: 'Utility',
  params: [
    { id: 'gain', label: 'Gain', min: -48, max: 24, def: 0, unit: 'dB', step: 0.1 },
    { id: 'invL', label: 'Phase L', min: 0, max: 1, def: 0, unit: 'onoff', step: 1 },
    { id: 'invR', label: 'Phase R', min: 0, max: 1, def: 0, unit: 'onoff', step: 1 },
    { id: 'mono', label: 'Mono', min: 0, max: 1, def: 0, unit: 'onoff', step: 1 },
    { id: 'swap', label: 'Swap L/R', min: 0, max: 1, def: 0, unit: 'onoff', step: 1 },
  ],
  create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), split = stereoSplitter(ctx), merge = ctx.createChannelMerger(2);
    const ll = ctx.createGain(), lr = ctx.createGain(), rl = ctx.createGain(), rr = ctx.createGain();
    input.connect(split.upmix);
    split.connect(ll, 0); split.connect(lr, 0); split.connect(rl, 1); split.connect(rr, 1);
    ll.connect(merge, 0, 0); rl.connect(merge, 0, 0); lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
    merge.connect(output);
    return {
      input, output,
      set(p) {
        const sl = p.invL >= 0.5 ? -1 : 1, sr = p.invR >= 0.5 ? -1 : 1, mono = p.mono >= 0.5, swap = p.swap >= 0.5;
        // matrix: [L->L, L->R, R->L, R->R]
        let m = swap ? [0, sl, sr, 0] : [sl, 0, 0, sr];
        if (mono) m = [sl * 0.5, sl * 0.5, sr * 0.5, sr * 0.5];
        ramp(ll.gain, m[0], ctx); ramp(lr.gain, m[1], ctx); ramp(rl.gain, m[2], ctx); ramp(rr.gain, m[3], ctx);
        ramp(output.gain, db(p.gain), ctx);
      },
      dispose() { disc(input, output, split, merge, ll, lr, rl, rr); },
    };
  },
};

export const MORE_PLUGINS = [GATE, DEESSER, MULTI, PHASER, FLANGER, RINGMOD, AMP, CRUSHER, EXCITER, SPACE, STEREO_DELAY, GRAPHIC_EQ, SPREAD, GAIN] as PluginDef[];
export type MoreType = 'gate' | 'deesser' | 'multi' | 'phaser' | 'flanger' | 'ringmod' | 'amp' | 'crusher' | 'exciter' | 'space' | 'sdelay' | 'geq' | 'spread' | 'gain';
