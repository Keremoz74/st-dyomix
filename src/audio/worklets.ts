// AudioWorklet processors for plug-ins that native Web Audio nodes can't do (noise gate, bit crusher).
// Loaded once per AudioContext (live and offline/bounce). Until loaded, those plug-ins pass audio through.

const CODE = `
const db = v => Math.pow(10, v / 20);
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'threshold', defaultValue: -40, automationRate: 'k-rate' },
    { name: 'attack', defaultValue: 1, automationRate: 'k-rate' },
    { name: 'hold', defaultValue: 50, automationRate: 'k-rate' },
    { name: 'release', defaultValue: 120, automationRate: 'k-rate' },
    { name: 'range', defaultValue: -80, automationRate: 'k-rate' },
    { name: 'hysteresis', defaultValue: 6, automationRate: 'k-rate' },
  ]; }
  constructor() { super(); this.g = 1; this.env = 0; this.open = false; this.holdLeft = 0; this.red = 0; this.port.onmessage = () => this.port.postMessage(this.red); }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, sr = sampleRate;
    const thOpen = db(p.threshold[0]), thClose = db(p.threshold[0] - p.hysteresis[0]), floor = db(p.range[0]);
    const aC = Math.exp(-1 / (sr * Math.max(0.05, p.attack[0]) / 1000)), rC = Math.exp(-1 / (sr * Math.max(1, p.release[0]) / 1000));
    const envC = Math.exp(-1 / (sr * 0.002)), holdS = p.hold[0] / 1000 * sr;
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > pk) pk = v; }
      this.env = pk > this.env ? pk : this.env * envC + pk * (1 - envC);
      if (this.env >= thOpen) { this.open = true; this.holdLeft = holdS; }
      else if (this.env < thClose) { if (this.holdLeft > 0) this.holdLeft--; else this.open = false; }
      const target = this.open ? 1 : floor;
      this.g = target > this.g ? target + (this.g - target) * aC : target + (this.g - target) * rC;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
    }
    this.red = 20 * Math.log10(Math.max(1e-5, this.g));
    return true;
  }
}
registerProcessor('daw-gate', Gate);

class Crusher extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'bits', defaultValue: 8, automationRate: 'k-rate' },
    { name: 'downsample', defaultValue: 4, automationRate: 'k-rate' },
    { name: 'mix', defaultValue: 1, automationRate: 'k-rate' },
  ]; }
  constructor() { super(); this.hold = [0, 0]; this.cnt = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const steps = Math.pow(2, Math.max(1, Math.min(24, p.bits[0]))) / 2, ds = Math.max(1, Math.round(p.downsample[0])), mix = p.mix[0];
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      if (this.cnt <= 0) { for (let c = 0; c < out.length; c++) { const v = (inp[c] || inp[0])[i]; this.hold[c] = Math.round(v * steps) / steps; } this.cnt = ds; }
      this.cnt--;
      for (let c = 0; c < out.length; c++) { const dry = (inp[c] || inp[0])[i]; out[c][i] = dry + (this.hold[c] - dry) * mix; }
    }
    return true;
  }
}
registerProcessor('daw-crusher', Crusher);
// granular pitch shifter: two read heads sweep a short delay line with crossfading windows
class Pitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'ratio', defaultValue: 1, automationRate: 'k-rate' },
    { name: 'window', defaultValue: 0.06, automationRate: 'k-rate' },
    { name: 'mix', defaultValue: 1, automationRate: 'k-rate' },
  ]; }
  constructor() { super(); this.size = 1 << 15; this.buf = [new Float32Array(this.size), new Float32Array(this.size)]; this.w = 0; this.ph = 0; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, ratio = p.ratio[0], mix = p.mix[0], win = Math.max(256, Math.min(this.size / 2 - 4, Math.round(p.window[0] * sampleRate)));
    const step = (1 - ratio) / win, M = this.size - 1;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) this.buf[c][this.w] = (inp[c] || inp[0])[i];
      this.ph += step; if (this.ph >= 1) this.ph -= 1; if (this.ph < 0) this.ph += 1;
      const ph2 = (this.ph + 0.5) % 1;
      const d1 = this.ph * win + 2, d2 = ph2 * win + 2;
      const g1 = Math.sin(Math.PI * this.ph), g2 = Math.sin(Math.PI * ph2);
      for (let c = 0; c < out.length; c++) {
        const b = this.buf[c] || this.buf[0];
        const r1 = this.w - d1, r2 = this.w - d2;
        const i1 = Math.floor(r1), f1 = r1 - i1, i2 = Math.floor(r2), f2 = r2 - i2;
        const a1 = b[i1 & M] + (b[(i1 + 1) & M] - b[i1 & M]) * f1;
        const a2 = b[i2 & M] + (b[(i2 + 1) & M] - b[i2 & M]) * f2;
        const wet = a1 * g1 * g1 + a2 * g2 * g2;
        const dry = (inp[c] || inp[0])[i];
        out[c][i] = dry + (wet - dry) * mix;
      }
      this.w = (this.w + 1) & M;
    }
    return true;
  }
}
registerProcessor('daw-pitch', Pitch);

// envelope filter (auto-wah): an envelope follower opens a resonant state-variable filter
class EnvFilter extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'sens', defaultValue: 0, automationRate: 'k-rate' },
    { name: 'base', defaultValue: 300, automationRate: 'k-rate' },
    { name: 'range', defaultValue: 4, automationRate: 'k-rate' },
    { name: 'q', defaultValue: 4, automationRate: 'k-rate' },
    { name: 'attack', defaultValue: 5, automationRate: 'k-rate' },
    { name: 'release', defaultValue: 120, automationRate: 'k-rate' },
    { name: 'mode', defaultValue: 0, automationRate: 'k-rate' },
    { name: 'mix', defaultValue: 1, automationRate: 'k-rate' },
  ]; }
  constructor() { super(); this.env = 0; this.s = [[0, 0], [0, 0]]; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, sr = sampleRate, gain = Math.pow(10, p.sens[0] / 20);
    const aC = Math.exp(-1 / (sr * Math.max(0.1, p.attack[0]) / 1000)), rC = Math.exp(-1 / (sr * Math.max(1, p.release[0]) / 1000));
    const k = 1 / Math.max(0.5, p.q[0]), mode = Math.round(p.mode[0]), mix = p.mix[0];
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < inp.length; c++) pk = Math.max(pk, Math.abs(inp[c][i]));
      pk = Math.min(1, pk * gain * 4);
      this.env = pk > this.env ? pk + (this.env - pk) * aC : pk + (this.env - pk) * rC;
      const fc = Math.min(sr * 0.45, p.base[0] * Math.pow(2, this.env * p.range[0]));
      const g = Math.tan(Math.PI * fc / sr), a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      for (let c = 0; c < out.length; c++) {
        const x = (inp[c] || inp[0])[i], st = this.s[c];
        const v3 = x - st[1], v1 = a1 * st[0] + a2 * v3, v2 = st[1] + a2 * st[0] + a3 * v3;
        st[0] = 2 * v1 - st[0]; st[1] = 2 * v2 - st[1];
        const y = mode === 1 ? v1 * k * 2 : mode === 2 ? x - k * v1 - v2 : v2;
        out[c][i] = x + (y - x) * mix;
      }
    }
    return true;
  }
}
registerProcessor('daw-envfilter', EnvFilter);

// transient designer: compares a fast and a slow envelope to boost/cut attacks and sustain
class Transient extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'attack', defaultValue: 0, automationRate: 'k-rate' },
    { name: 'sustain', defaultValue: 0, automationRate: 'k-rate' },
    { name: 'out', defaultValue: 0, automationRate: 'k-rate' },
  ]; }
  constructor() { super(); this.f = 0; this.sl = 0; this.g = 1; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length, sr = sampleRate;
    const fa = Math.exp(-1 / (sr * 0.001)), fr = Math.exp(-1 / (sr * 0.02)), sa = Math.exp(-1 / (sr * 0.03)), sr2 = Math.exp(-1 / (sr * 0.25)), gs = Math.exp(-1 / (sr * 0.002));
    const att = p.attack[0] / 100, sus = p.sustain[0] / 100, og = Math.pow(10, p.out[0] / 20);
    for (let i = 0; i < n; i++) {
      let pk = 0; for (let c = 0; c < inp.length; c++) pk = Math.max(pk, Math.abs(inp[c][i]));
      this.f = pk > this.f ? pk + (this.f - pk) * fa : pk + (this.f - pk) * fr;
      this.sl = pk > this.sl ? pk + (this.sl - pk) * sa : pk + (this.sl - pk) * sr2;
      const diff = 20 * Math.log10((this.f + 1e-6) / (this.sl + 1e-6));
      const db = att * Math.max(0, Math.min(24, diff)) * 0.75 + sus * Math.max(0, Math.min(24, -diff)) * 0.75;
      const target = Math.pow(10, Math.max(-24, Math.min(12, db)) / 20);
      this.g = target + (this.g - target) * gs;
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g * og;
    }
    return true;
  }
}
registerProcessor('daw-transient', Transient);
// Sample-accurate recorder: captures the raw input (no encoder, no MediaRecorder timing guesswork)
// and posts it in blocks of ~8192 frames together with the context time of the first frame.
class Rec extends AudioWorkletProcessor {
  constructor() {
    super(); this.on = false; this.buf = null; this.n = 0; this.t0 = -1;
    this.port.onmessage = e => {
      if (e.data === 'start') { this.on = true; this.t0 = -1; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.buf && this.n) { const out = this.buf.map(c => c.slice(0, this.n)); this.port.postMessage({ t0: this.t0, ch: out }, out.map(c => c.buffer)); }
    this.buf = null; this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!this.on || !inp || !inp.length) return true;
    if (this.t0 < 0) this.t0 = currentTime;
    if (!this.buf) this.buf = inp.map(() => new Float32Array(8192));
    const len = inp[0].length;
    for (let c = 0; c < this.buf.length; c++) this.buf[c].set(inp[Math.min(c, inp.length - 1)], this.n);
    this.n += len;
    if (this.n + len > 8192) this.flush();
    return true;
  }
}
registerProcessor('daw-recorder', Rec);
`;

const loaded = new WeakSet<BaseAudioContext>();
const loading = new WeakMap<BaseAudioContext, Promise<void>>();
let url = '';

export const workletsReady = (ctx: BaseAudioContext) => loaded.has(ctx);

export function ensureWorklets(ctx: BaseAudioContext): Promise<void> {
  if (loaded.has(ctx)) return Promise.resolve();
  let p = loading.get(ctx);
  if (!p) {
    if (!url) url = URL.createObjectURL(new Blob([CODE], { type: 'text/javascript' }));
    const add = (u: string) => ctx.audioWorklet ? ctx.audioWorklet.addModule(u) : Promise.reject(new Error('no AudioWorklet'));
    // blob: URLs don't load on file:// pages (opaque origin); a data: URL does
    p = add(url).catch(() => add('data:text/javascript;base64,' + btoa(CODE)))
      .then(() => { loaded.add(ctx); })
      .catch(e => { console.warn('worklets unavailable', e); });
    loading.set(ctx, p);
  }
  return p;
}
