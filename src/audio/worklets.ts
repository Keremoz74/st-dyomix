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
