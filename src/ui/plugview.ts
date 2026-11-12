// Live plug-in displays (the "screen" of each plug-in window), in the spirit of pro plug-ins:
//  dynamics  – transfer curve with the live level dot + scrolling input / output / gain-reduction history
//  reverb    – the real impulse response (rendered offline from the current settings) with decay readouts
//  delay     – the real echo pattern (impulse response) with the taps and their times
//  dist/amp  – live transfer (X-Y: input vs output) and oscilloscope
//  mod       – the LFO with a moving phase cursor + live scope
//  spectrum  – input (grey) vs output (colour) spectrum
//  stereo    – goniometer (vectorscope) + correlation meter
//  synth     – ADSR envelope + live scope (instruments)
// Every view has input / output peak + RMS meters.
import type { Insert } from '../model';
import type { PluginInstance } from '../audio/plugins';
import { PLUGINS } from '../audio/plugins';
import { ensureWorklets } from '../audio/worklets';
import { h } from './dom';

export type ViewKind = 'dyn' | 'reverb' | 'delay' | 'dist' | 'mod' | 'spectrum' | 'stereo' | 'synth' | 'none';
const KIND: Record<string, ViewKind> = {
  comp: 'dyn', limiter: 'dyn', gate: 'dyn', deesser: 'dyn', multi: 'dyn', transient: 'dyn', fetcomp: 'dyn', optocomp: 'dyn', strip: 'dyn', maximizer: 'dyn',
  reverb: 'reverb', space: 'reverb',
  delay: 'delay', sdelay: 'delay', tapedelay: 'delay', moddelay: 'delay',
  drive: 'dist', crusher: 'dist', amp: 'dist', fuzz: 'dist', tapesat: 'dist', exciter: 'dist',
  chorus: 'mod', flanger: 'mod', phaser: 'mod', tremolo: 'mod', rotary: 'mod', autofilter: 'mod', wah: 'mod', ringmod: 'mod',
  spread: 'stereo', gain: 'stereo',
  geq: 'spectrum', veq: 'spectrum', pitch: 'spectrum', pitchcorrect: 'spectrum', envfilter: 'spectrum',
};
export const viewKind = (type: string): ViewKind => KIND[type] ?? 'spectrum';
export const KIND_COLOR: Record<ViewKind, string> = { dyn: '#ffb347', reverb: '#7aa2ff', delay: '#55d6be', dist: '#ff6b6b', mod: '#c792ea', spectrum: '#4c9aff', stereo: '#f7d154', synth: '#6fdc8c', none: '#4c9aff' };

const dbOf = (v: number) => v > 1e-6 ? 20 * Math.log10(v) : -120;

/** Peak / RMS of an analyser's current block. */
function levels(an: AnalyserNode, buf: Float32Array<ArrayBuffer>) {
  an.getFloatTimeDomainData(buf);
  let pk = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; sum += buf[i] * buf[i]; }
  return { pk, rms: Math.sqrt(sum / buf.length) };
}

class Meter {
  readonly el: HTMLCanvasElement;
  private hold = -120; private holdT = 0; private val = -120;
  constructor(public label: string) { this.el = h('canvas', { class: 'pv-meter', 'aria-label': `${label} level` }) as HTMLCanvasElement; }
  draw(pk: number, rms: number) {
    const c = this.el, dpr = devicePixelRatio || 1, w = c.clientWidth, H = c.clientHeight; if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pdb = dbOf(pk), rdb = dbOf(rms), now = performance.now();
    this.val = Math.max(pdb, this.val - 1.2);
    if (pdb >= this.hold || now - this.holdT > 1500) { this.hold = pdb; this.holdT = now; }
    const top = 14, bot = H - 4, y = (db: number) => top + (1 - (Math.max(-60, Math.min(6, db)) + 60) / 66) * (bot - top);
    g.clearRect(0, 0, w, H);
    g.fillStyle = '#0c0d0f'; g.fillRect(0, top, w, bot - top);
    const grad = g.createLinearGradient(0, bot, 0, top);
    grad.addColorStop(0, '#2bd67b'); grad.addColorStop(0.68, '#c8e64a'); grad.addColorStop(0.86, '#ffb347'); grad.addColorStop(0.92, '#ff4d4f');
    g.fillStyle = grad; g.globalAlpha = 0.45; g.fillRect(1, y(this.val), w - 2, bot - y(this.val));
    g.globalAlpha = 1; g.fillRect(1, y(rdb), w - 2, bot - y(rdb));
    g.fillStyle = this.hold > 0 ? '#ff4d4f' : '#e9ecf2'; g.fillRect(1, y(this.hold) - 1, w - 2, 2);
    g.fillStyle = '#7d8088'; g.font = '600 9px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(this.label, w / 2, 9);
  }
}

export class PluginView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private readout: HTMLDivElement;
  private inM = new Meter('IN'); private outM = new Meter('OUT');
  private inst: PluginInstance | undefined;
  private inAn: AnalyserNode | null = null; private outAn: AnalyserNode | null = null;
  private outL: AnalyserNode | null = null; private outR: AnalyserNode | null = null; private split: ChannelSplitterNode | null = null;
  private tIn = new Float32Array(2048); private tOut = new Float32Array(2048); private tL = new Float32Array(1024); private tR = new Float32Array(1024);
  private fIn = new Float32Array(1024); private fOut = new Float32Array(1024);
  private hist: { i: number; o: number; gr: number }[] = [];
  private ir: Float32Array | null = null; private irSecs = 0; private irTimer = 0; private irSig = '';
  private t0 = performance.now();
  readonly color: string;

  constructor(private ins: Insert | null, readonly kind: ViewKind, private params: () => Record<string, number>) {
    this.color = KIND_COLOR[kind];
    this.canvas = h('canvas', { class: 'pv-canvas', 'aria-label': 'Plug-in display' }) as HTMLCanvasElement;
    this.readout = h('div', { class: 'pv-readout' }) as HTMLDivElement;
    this.el = h('div', { class: `pv pv-${kind}` }, h('div', { class: 'pv-screen' }, this.canvas, this.readout), h('div', { class: 'pv-meters' }, this.inM.el, this.outM.el)) as HTMLDivElement;
    this.paramsChanged();
  }

  /** Taps (analysers) on the plug-in's input and output; re-made when the engine rebuilds the plug-in. */
  attach(inst: PluginInstance | undefined, input?: AudioNode, output?: AudioNode) {
    const inN = input ?? inst?.input, outN = output ?? inst?.output;
    if ((inst && inst === this.inst) || (!inst && this.inAn && (this.inAn as any)._src === inN)) return;
    this.detach();
    this.inst = inst;
    if (!inN || !outN) return;
    const ctx = outN.context;
    const mk = (n = 2048) => { const a = ctx.createAnalyser(); a.fftSize = n; a.smoothingTimeConstant = 0.75; return a; };
    this.inAn = mk(); this.outAn = mk();
    try { inN.connect(this.inAn); outN.connect(this.outAn); } catch { /* node gone */ }
    (this.inAn as any)._src = inN; (this.outAn as any)._src = outN;
    if (this.kind === 'stereo') {
      this.split = ctx.createChannelSplitter(2); this.outL = mk(1024); this.outR = mk(1024);
      outN.connect(this.split); this.split.connect(this.outL, 0); this.split.connect(this.outR, 1);
    }
  }
  detach() {
    const off = (src: any, a: AudioNode | null) => { try { if (a && src) src.disconnect(a); } catch { /* gone */ } };
    off((this.inAn as any)?._src, this.inAn); off((this.outAn as any)?._src, this.outAn); off((this.outAn as any)?._src, this.split);
    this.inAn = this.outAn = this.outL = this.outR = null; this.split = null; this.inst = undefined;
  }

  /** Settings changed: re-render the impulse response (reverb / delay) a moment later. */
  paramsChanged() {
    if ((this.kind !== 'reverb' && this.kind !== 'delay') || !this.ins) return;
    const sig = JSON.stringify(this.params());
    if (sig === this.irSig) return;
    this.irSig = sig;
    clearTimeout(this.irTimer);
    this.irTimer = window.setTimeout(() => this.renderIr(), 180);
  }
  private async renderIr() {
    const ins = this.ins!, p = { ...this.params() }, def = PLUGINS[ins.type]; if (!def) return;
    let secs = 4;
    if (this.kind === 'reverb') secs = Math.min(10, (p.decay ?? 2) * 1.35 + (p.predelay ?? 0) / 1000 + 0.2);
    else {
      const t = Math.max(p.time ?? 0, p.left ?? 0, p.right ?? 0) / 1000 || 0.4, fb = Math.min(0.97, (p.feedback ?? 30) / 100);
      secs = Math.min(10, t * (fb > 0.01 ? Math.log(0.001) / Math.log(fb) + 1.5 : 2.5) + 0.2);
    }
    const sr = 22050, len = Math.round(secs * sr);
    const ctx = new OfflineAudioContext(2, len, sr);
    await ensureWorklets(ctx).catch(() => {});
    const inst = def.create(ctx);
    if (p.mix != null) p.mix = 100; // show the effect itself
    inst.set(p);
    const src = ctx.createBufferSource(), b = ctx.createBuffer(2, 64, sr);
    b.getChannelData(0)[0] = 1; b.getChannelData(1)[0] = 1; src.buffer = b;
    src.connect(inst.input); inst.output.connect(ctx.destination); src.start(0.02);
    try {
      const out = await ctx.startRendering();
      const l = out.getChannelData(0), r = out.getChannelData(1), m = new Float32Array(len);
      for (let i = 0; i < len; i++) m[i] = Math.max(Math.abs(l[i]), Math.abs(r[i]));
      // remove the dry impulse at t=0 for display (the wet path is what matters)
      for (let i = 0; i < Math.round(0.02 * sr) + 8 && i < len; i++) if (this.kind === 'reverb') m[i] = Math.min(m[i], 0.02);
      this.ir = m; this.irSecs = secs;
    } catch { /* ignore */ }
    try { inst.dispose(); } catch { /* ignore */ }
  }

  frame() {
    const c = this.canvas, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#15171b'); bg.addColorStop(1, '#0d0e11');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const li = this.inAn ? levels(this.inAn, this.tIn) : { pk: 0, rms: 0 }, lo = this.outAn ? levels(this.outAn, this.tOut) : { pk: 0, rms: 0 };
    this.inM.draw(li.pk, li.rms); this.outM.draw(lo.pk, lo.rms);
    switch (this.kind) {
      case 'dyn': this.drawDyn(g, W, H, li, lo); break;
      case 'reverb': case 'delay': this.drawIr(g, W, H); break;
      case 'dist': this.drawDist(g, W, H, li); break;
      case 'mod': this.drawMod(g, W, H); break;
      case 'stereo': this.drawStereo(g, W, H); break;
      case 'synth': this.drawSynth(g, W, H); break;
      default: this.drawSpectrum(g, W, H);
    }
  }

  // ---------- helpers ----------
  private grid(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, hh: number, nx: number, ny: number) {
    g.strokeStyle = '#ffffff0d'; g.lineWidth = 1; g.beginPath();
    for (let i = 1; i < nx; i++) { const x = Math.round(x0 + w * i / nx) + 0.5; g.moveTo(x, y0); g.lineTo(x, y0 + hh); }
    for (let i = 1; i < ny; i++) { const y = Math.round(y0 + hh * i / ny) + 0.5; g.moveTo(x0, y); g.lineTo(x0 + w, y); }
    g.stroke();
  }
  private label(g: CanvasRenderingContext2D, t: string, x: number, y: number, color = '#6d7078', align: CanvasTextAlign = 'left') {
    g.fillStyle = color; g.font = '600 10px Inter, sans-serif'; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(t, x, y); g.textAlign = 'left';
  }
  private setReadout(t: string) { if (this.readout.textContent !== t) this.readout.textContent = t; }

  // ---------- dynamics ----------
  /** Static curve parameters per plug-in (threshold dB, ratio, knee dB) when it has them. */
  private curve(): { th: number; ratio: number; knee: number; gate?: boolean } | null {
    const p = this.params(), t = this.ins?.type;
    switch (t) {
      case 'comp': case 'strip': return { th: p.threshold, ratio: p.ratio, knee: p.knee ?? 6 };
      case 'fetcomp': return { th: -p.input * 0.85, ratio: [4, 8, 12, 20, 20][Math.round(p.ratio)] ?? 4, knee: Math.round(p.ratio) === 4 ? 0 : 2 };
      case 'optocomp': return { th: -p.reduction * 0.45, ratio: Math.round(p.mode) === 1 ? 12 : 3, knee: 18 };
      case 'maximizer': return { th: -2 - p.optimize / 100 * 18 * 0.4, ratio: 20, knee: 0 };
      case 'limiter': return { th: p.ceiling ?? -1, ratio: 30, knee: 0 };
      case 'gate': return { th: p.threshold, ratio: 1, knee: 0, gate: true };
      case 'multi': return { th: p.thMid, ratio: p.ratio, knee: 6 };
      case 'deesser': return { th: p.threshold, ratio: 4, knee: 4 };
      default: return null;
    }
  }
  private drawDyn(g: CanvasRenderingContext2D, W: number, H: number, li: { pk: number; rms: number }, lo: { pk: number; rms: number }) {
    const cv = this.curve(), pad = 12, side = cv ? Math.min(H - 2 * pad, W * 0.34) : 0;
    const inDb = dbOf(li.rms * 1.414), outDb = dbOf(lo.rms * 1.414);
    const red = this.inst?.reduction ? Math.min(0, this.inst.reduction()) : Math.min(0, outDb - inDb);
    // transfer curve
    if (cv) {
      const x0 = pad, y0 = pad, s = side, lo2 = -60;
      const X = (db: number) => x0 + (db - lo2) / -lo2 * s, Y = (db: number) => y0 + s - (Math.max(lo2, Math.min(0, db)) - lo2) / -lo2 * s;
      g.fillStyle = '#0a0b0d'; g.fillRect(x0, y0, s, s); this.grid(g, x0, y0, s, s, 6, 6);
      g.strokeStyle = '#ffffff22'; g.beginPath(); g.moveTo(X(lo2), Y(lo2)); g.lineTo(X(0), Y(0)); g.stroke();
      const f = (x: number) => {
        if (cv.gate) return x < cv.th ? x - 40 : x;
        const k = cv.knee, d = x - cv.th;
        if (2 * d < -k) return x;
        if (k > 0 && 2 * Math.abs(d) <= k) return x + (1 / cv.ratio - 1) * Math.pow(d + k / 2, 2) / (2 * k);
        return cv.th + d / cv.ratio;
      };
      g.strokeStyle = this.color; g.lineWidth = 2.2; g.beginPath();
      for (let x = lo2; x <= 0; x += 0.5) { const yy = Y(f(x)); x === lo2 ? g.moveTo(X(x), yy) : g.lineTo(X(x), yy); }
      g.stroke();
      // threshold marker + live dot
      g.strokeStyle = '#ffffff30'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(cv.th), y0); g.lineTo(X(cv.th), y0 + s); g.stroke(); g.setLineDash([]);
      if (inDb > -60) { g.fillStyle = '#fff'; g.beginPath(); g.arc(X(inDb), Y(f(inDb)), 4.5, 0, Math.PI * 2); g.fill(); g.strokeStyle = this.color; g.lineWidth = 2; g.stroke(); }
      this.label(g, 'IN →', x0 + s - 2, y0 + s - 4, '#55585f', 'right'); this.label(g, `${cv.gate ? 'Threshold' : 'Th'} ${cv.th.toFixed(1)} dB${cv.gate ? '' : `  ${cv.ratio.toFixed(1)}:1`}`, x0 + 4, y0 + 13, '#a0a3aa');
    }
    // history
    const hx = cv ? pad * 2 + side : pad, hw = W - hx - pad, hy = pad, hh = H - 2 * pad;
    this.hist.push({ i: inDb, o: outDb, gr: red });
    const maxN = Math.max(60, Math.floor(hw / 2)); if (this.hist.length > maxN) this.hist.splice(0, this.hist.length - maxN);
    g.fillStyle = '#0a0b0d'; g.fillRect(hx, hy, hw, hh); this.grid(g, hx, hy, hw, hh, 8, 6);
    const Yl = (db: number) => hy + hh - (Math.max(-60, Math.min(0, db)) + 60) / 60 * hh;
    const step = hw / maxN, n = this.hist.length, xs = (i: number) => hx + hw - (n - 1 - i) * step;
    g.beginPath(); g.moveTo(xs(0), hy + hh); this.hist.forEach((p, i) => g.lineTo(xs(i), Yl(p.i))); g.lineTo(xs(n - 1), hy + hh); g.closePath(); g.fillStyle = '#ffffff14'; g.fill();
    g.beginPath(); this.hist.forEach((p, i) => (i ? g.lineTo(xs(i), Yl(p.o)) : g.moveTo(xs(i), Yl(p.o)))); g.strokeStyle = this.color; g.lineWidth = 1.6; g.stroke();
    // gain reduction from the top (0..-24 dB over the full height)
    g.beginPath(); g.moveTo(xs(0), hy); this.hist.forEach((p, i) => g.lineTo(xs(i), hy + Math.min(1, -p.gr / 24) * hh)); g.lineTo(xs(n - 1), hy); g.closePath();
    g.fillStyle = '#ff4d4f40'; g.fill();
    g.beginPath(); this.hist.forEach((p, i) => (i ? g.lineTo(xs(i), hy + Math.min(1, -p.gr / 24) * hh) : g.moveTo(xs(i), hy + Math.min(1, -p.gr / 24) * hh))); g.strokeStyle = '#ff5c5c'; g.lineWidth = 1.4; g.stroke();
    this.label(g, 'INPUT', hx + 6, hy + hh - 6, '#9a9da4'); this.label(g, 'OUTPUT', hx + 54, hy + hh - 6, this.color); this.label(g, 'GAIN REDUCTION', hx + 112, hy + hh - 6, '#ff6b6b');
    for (const db of [-12, -24, -36, -48]) this.label(g, String(db), hx + hw - 4, Yl(db) - 2, '#45484f', 'right');
    this.setReadout(`GR ${red.toFixed(1)} dB`);
  }

  // ---------- reverb / delay ----------
  private drawIr(g: CanvasRenderingContext2D, W: number, H: number) {
    const pad = 12, x0 = pad, y0 = pad, w = W - 2 * pad, hh = H - 2 * pad - 12;
    g.fillStyle = '#0a0b0d'; g.fillRect(x0, y0, w, hh);
    const secs = this.irSecs || 1;
    // time grid
    const stepS = secs > 6 ? 1 : secs > 2.5 ? 0.5 : secs > 1 ? 0.25 : 0.1;
    g.strokeStyle = '#ffffff0d'; g.beginPath();
    for (let t = stepS; t < secs; t += stepS) { const x = Math.round(x0 + t / secs * w) + 0.5; g.moveTo(x, y0); g.lineTo(x, y0 + hh); }
    g.stroke();
    for (let t = 0; t <= secs + 1e-6; t += stepS * (secs > 6 ? 2 : 2)) this.label(g, t >= 1 ? `${+t.toFixed(2)} s` : `${Math.round(t * 1000)} ms`, x0 + t / secs * w + 3, y0 + hh + 11, '#6d7078');
    const ir = this.ir; if (!ir) { this.label(g, 'Rendering…', x0 + 8, y0 + 18); return; }
    const mid = y0 + hh / 2, per = ir.length / w;
    let peak = 1e-6; for (let i = 0; i < ir.length; i++) if (ir[i] > peak) peak = ir[i];
    // log-ish amplitude so the tail stays visible
    const A = (v: number) => { const db = Math.max(-60, dbOf(v / peak)); return (db + 60) / 60; };
    const grad = g.createLinearGradient(x0, 0, x0 + w, 0); grad.addColorStop(0, this.color); grad.addColorStop(1, this.color + '55');
    g.beginPath(); g.moveTo(x0, mid);
    const env: number[] = [];
    for (let x = 0; x < w; x++) { let m = 0; const a = Math.floor(x * per), b = Math.floor((x + 1) * per); for (let i = a; i < b && i < ir.length; i++) if (ir[i] > m) m = ir[i]; env.push(A(m)); g.lineTo(x0 + x, mid - env[x] * (hh / 2 - 4)); }
    for (let x = w - 1; x >= 0; x--) g.lineTo(x0 + x, mid + env[x] * (hh / 2 - 4));
    g.closePath(); g.fillStyle = grad; g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = '#ffffff10'; g.beginPath(); g.moveTo(x0, mid + 0.5); g.lineTo(x0 + w, mid + 0.5); g.stroke();
    // RT60 estimate (reverb) or tap list (delay)
    const p = this.params();
    if (this.kind === 'reverb') {
      let iPk = 0; for (let i = 0; i < ir.length; i++) if (ir[i] === peak) { iPk = i; break; }
      let i60 = ir.length - 1; const thr = peak * 0.001;
      for (let i = ir.length - 1; i > iPk; i -= 64) { let m = 0; for (let j = i; j > i - 64 && j > 0; j--) if (ir[j] > m) m = ir[j]; if (m > thr) { i60 = i; break; } }
      const sr = ir.length / secs, pre = (p.predelay ?? 0);
      const xp = x0 + (iPk / sr) / secs * w; g.strokeStyle = '#ffffff55'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xp, y0); g.lineTo(xp, y0 + hh); g.stroke(); g.setLineDash([]);
      this.setReadout(`Pre-delay ${Math.round(pre)} ms · RT60 ≈ ${((i60 - iPk) / sr).toFixed(2)} s`);
    } else {
      const sr = ir.length / secs, taps: number[] = []; const thr = peak * 0.08;
      for (let i = Math.round(0.03 * sr); i < ir.length - 1 && taps.length < 6; i++) if (ir[i] > thr && ir[i] >= ir[i - 1] && ir[i] >= ir[i + 1]) { taps.push(i / sr - 0.02); i += Math.round(0.02 * sr); }
      g.fillStyle = '#ffffffcc';
      taps.forEach(t => { const x = x0 + (t + 0.02) / secs * w; g.beginPath(); g.arc(x, y0 + 6, 2.5, 0, Math.PI * 2); g.fill(); });
      this.setReadout(taps.length ? `Echoes: ${taps.slice(0, 4).map(t => `${Math.round(t * 1000)} ms`).join(' · ')}` : 'Echoes');
    }
  }

  // ---------- distortion ----------
  private drawDist(g: CanvasRenderingContext2D, W: number, H: number, li: { pk: number }) {
    const pad = 12, s = Math.min(H - 2 * pad, W * 0.34), x0 = pad, y0 = pad;
    g.fillStyle = '#0a0b0d'; g.fillRect(x0, y0, s, s); this.grid(g, x0, y0, s, s, 4, 4);
    g.strokeStyle = '#ffffff22'; g.beginPath(); g.moveTo(x0, y0 + s); g.lineTo(x0 + s, y0); g.stroke();
    // live X-Y: input (x) vs output (y), normalised to the input peak
    const n = Math.min(this.tIn.length, this.tOut.length), ipk = Math.max(0.02, li.pk);
    let opk = 1e-4; for (let i = 0; i < n; i++) opk = Math.max(opk, Math.abs(this.tOut[i]));
    g.fillStyle = this.color;
    for (let i = 0; i < n; i += 2) {
      const x = x0 + s / 2 + (this.tIn[i] / ipk) * (s / 2 - 4), y = y0 + s / 2 - (this.tOut[i] / opk) * (s / 2 - 4);
      g.fillRect(x, y, 1.6, 1.6);
    }
    this.label(g, 'TRANSFER (IN → OUT)', x0 + 6, y0 + 14, '#a0a3aa');
    // scope
    const sx = x0 + s + pad, sw = W - sx - pad, mid = y0 + s / 2;
    g.fillStyle = '#0a0b0d'; g.fillRect(sx, y0, sw, s); this.grid(g, sx, y0, sw, s, 8, 4);
    let z = 0; for (let i = 1; i < n / 2; i++) if (this.tIn[i - 1] < 0 && this.tIn[i] >= 0) { z = i; break; }
    const span = Math.min(n - z, 1024);
    const wave = (b: Float32Array, col: string, lw: number, scale: number) => { g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); for (let i = 0; i < span; i++) { const x = sx + i / span * sw, y = mid - b[z + i] * scale * (s / 2 - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); };
    wave(this.tIn, '#ffffff40', 1, 1 / Math.max(ipk, opk));
    wave(this.tOut, this.color, 1.8, 1 / Math.max(ipk, opk));
    this.label(g, 'SCOPE', sx + 6, y0 + 14, '#a0a3aa');
    this.setReadout(`Out peak ${dbOf(opk).toFixed(1)} dBFS`);
  }

  // ---------- modulation ----------
  private drawMod(g: CanvasRenderingContext2D, W: number, H: number) {
    const p = this.params(), t = this.ins?.type;
    const rate = t === 'rotary' ? [0, 0.8, 6.7][Math.round(p.speed)] ?? 0.8 : t === 'ringmod' ? Math.min(20, p.freq ?? 5) : (p.rate ?? 1);
    const depth = Math.min(1, (p.depth ?? p.width ?? 60) / 100);
    const pad = 12, x0 = pad, y0 = pad, w = W - 2 * pad, hh = (H - 3 * pad) * 0.58, mid = y0 + hh / 2;
    g.fillStyle = '#0a0b0d'; g.fillRect(x0, y0, w, hh); this.grid(g, x0, y0, w, hh, 8, 4);
    const cycles = 2, now = (performance.now() - this.t0) / 1000, phase = (now * rate) % 1;
    g.strokeStyle = this.color; g.lineWidth = 2.2; g.beginPath();
    for (let x = 0; x <= w; x += 2) { const ph = x / w * cycles; const y = mid - Math.sin(ph * Math.PI * 2) * depth * (hh / 2 - 8); x ? g.lineTo(x0 + x, y) : g.moveTo(x0 + x, y); }
    g.stroke();
    const cx = x0 + (phase / cycles) * w, cy = mid - Math.sin(phase * Math.PI * 2) * depth * (hh / 2 - 8);
    g.strokeStyle = '#ffffff40'; g.beginPath(); g.moveTo(cx, y0); g.lineTo(cx, y0 + hh); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.fill(); g.strokeStyle = this.color; g.lineWidth = 2; g.stroke();
    this.label(g, `LFO  ${rate >= 1 ? rate.toFixed(2) : rate.toFixed(3)} Hz  ·  depth ${Math.round(depth * 100)} %`, x0 + 6, y0 + 14, '#a0a3aa');
    // live output scope underneath
    const sy = y0 + hh + pad, sh = H - sy - pad, smid = sy + sh / 2;
    g.fillStyle = '#0a0b0d'; g.fillRect(x0, sy, w, sh);
    let pk = 1e-3; for (let i = 0; i < this.tOut.length; i++) pk = Math.max(pk, Math.abs(this.tOut[i]));
    g.strokeStyle = this.color + 'cc'; g.lineWidth = 1.2; g.beginPath();
    for (let i = 0; i < this.tOut.length; i += 2) { const x = x0 + i / this.tOut.length * w, y = smid - this.tOut[i] / pk * (sh / 2 - 3); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    this.setReadout(`${rate.toFixed(2)} Hz`);
  }

  // ---------- spectrum ----------
  private drawSpectrum(g: CanvasRenderingContext2D, W: number, H: number) {
    const pad = 12, x0 = pad, y0 = pad, w = W - 2 * pad, hh = H - 2 * pad - 10;
    g.fillStyle = '#0a0b0d'; g.fillRect(x0, y0, w, hh);
    const X = (f: number) => x0 + Math.log(f / 20) / Math.log(1000) * w;
    g.strokeStyle = '#ffffff0d'; g.beginPath();
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(X(f)) + 0.5; g.moveTo(x, y0); g.lineTo(x, y0 + hh); }
    g.stroke();
    for (const f of [100, 1000, 10000]) this.label(g, f >= 1000 ? `${f / 1000}k` : String(f), X(f) + 3, y0 + hh + 10);
    if (!this.inAn || !this.outAn) return;
    const sr = this.outAn.context.sampleRate;
    const curve = (an: AnalyserNode, buf: Float32Array<ArrayBuffer>, fill: string, stroke: string) => {
      an.getFloatFrequencyData(buf);
      g.beginPath(); g.moveTo(x0, y0 + hh);
      for (let x = 0; x <= w; x += 2) {
        const f = 20 * Math.pow(1000, x / w), bin = Math.min(buf.length - 1, Math.round(f / (sr / 2) * buf.length * 2) >> 1);
        const v = Math.max(-100, Math.min(-6, buf[bin] + 4.5 * Math.log2(f / 1000)));
        g.lineTo(x0 + x, y0 + hh - (v + 100) / 94 * hh);
      }
      g.lineTo(x0 + w, y0 + hh); g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke();
    };
    if (this.fIn.length !== this.inAn.frequencyBinCount) { this.fIn = new Float32Array(this.inAn.frequencyBinCount); this.fOut = new Float32Array(this.outAn.frequencyBinCount); }
    curve(this.inAn, this.fIn, '#ffffff0c', '#ffffff40');
    curve(this.outAn, this.fOut, this.color + '30', this.color);
    this.label(g, 'INPUT', x0 + 6, y0 + 14, '#9a9da4'); this.label(g, 'OUTPUT', x0 + 50, y0 + 14, this.color);
    this.setReadout('');
  }

  // ---------- stereo ----------
  private drawStereo(g: CanvasRenderingContext2D, W: number, H: number) {
    const pad = 12, s = H - 2 * pad, cx = pad + s / 2, cy = pad + s / 2;
    g.fillStyle = '#0a0b0d'; g.fillRect(pad, pad, s, s);
    g.strokeStyle = '#ffffff14'; g.beginPath(); g.moveTo(cx, pad); g.lineTo(cx, pad + s); g.moveTo(pad, cy); g.lineTo(pad + s, cy);
    g.moveTo(pad, pad); g.lineTo(pad + s, pad + s); g.moveTo(pad + s, pad); g.lineTo(pad, pad + s); g.stroke();
    this.label(g, 'L', pad + 6, pad + 14); this.label(g, 'R', pad + s - 12, pad + 14); this.label(g, 'M', cx + 4, pad + 12);
    let corr = 0;
    if (this.outL && this.outR) {
      this.outL.getFloatTimeDomainData(this.tL); this.outR.getFloatTimeDomainData(this.tR);
      let pk = 1e-3, sLR = 0, sLL = 0, sRR = 0;
      for (let i = 0; i < this.tL.length; i++) { pk = Math.max(pk, Math.abs(this.tL[i]), Math.abs(this.tR[i])); sLR += this.tL[i] * this.tR[i]; sLL += this.tL[i] ** 2; sRR += this.tR[i] ** 2; }
      corr = sLL && sRR ? sLR / Math.sqrt(sLL * sRR) : 0;
      g.fillStyle = this.color;
      for (let i = 0; i < this.tL.length; i++) {
        const l = this.tL[i] / pk, r = this.tR[i] / pk, m = (l + r) / 2, sd = (l - r) / 2;
        g.fillRect(cx - sd * (s / 2 - 6), cy - m * (s / 2 - 6), 1.5, 1.5);
      }
    }
    // correlation meter
    const mx = pad * 2 + s, mw = W - mx - pad, my = H / 2 - 8;
    g.fillStyle = '#0a0b0d'; g.fillRect(mx, my, mw, 16);
    const grad = g.createLinearGradient(mx, 0, mx + mw, 0); grad.addColorStop(0, '#ff4d4f'); grad.addColorStop(0.5, '#ffb347'); grad.addColorStop(1, '#2bd67b');
    g.fillStyle = grad; g.globalAlpha = 0.25; g.fillRect(mx, my, mw, 16); g.globalAlpha = 1;
    const px = mx + (corr + 1) / 2 * mw; g.fillStyle = '#fff'; g.fillRect(px - 2, my - 3, 4, 22);
    this.label(g, '−1', mx, my + 32); this.label(g, '0', mx + mw / 2 - 3, my + 32); this.label(g, '+1', mx + mw - 14, my + 32);
    this.label(g, 'PHASE CORRELATION', mx, my - 10, '#a0a3aa');
    this.setReadout(`Correlation ${corr.toFixed(2)}`);
  }

  // ---------- instruments ----------
  private drawSynth(g: CanvasRenderingContext2D, W: number, H: number) {
    const p = this.params(), pad = 12, ew = W * 0.42, x0 = pad, y0 = pad, hh = H - 2 * pad;
    g.fillStyle = '#0a0b0d'; g.fillRect(x0, y0, ew, hh); this.grid(g, x0, y0, ew, hh, 4, 4);
    const a = (p.attack ?? 5) / 1000, d = (p.decay ?? 300) / 1000, s = (p.sustain ?? 70) / 100, r = (p.release ?? 300) / 1000;
    const tot = a + d + 0.35 + r || 1, X = (t: number) => x0 + 6 + t / tot * (ew - 12), Y = (v: number) => y0 + hh - 8 - v * (hh - 26);
    const pts: [number, number][] = [[0, 0], [a, 1], [a + d, s], [a + d + 0.35, s], [tot, 0]];
    g.beginPath(); pts.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v)))); g.lineTo(X(tot), Y(0)); g.closePath();
    g.fillStyle = this.color + '26'; g.fill();
    g.beginPath(); pts.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v)))); g.strokeStyle = this.color; g.lineWidth = 2.2; g.stroke();
    g.fillStyle = '#fff'; for (const [t, v] of pts.slice(1, 4)) { g.beginPath(); g.arc(X(t), Y(v), 3.5, 0, Math.PI * 2); g.fill(); }
    this.label(g, 'AMP ENVELOPE', x0 + 6, y0 + 14, '#a0a3aa');
    ['A', 'D', 'S', 'R'].forEach((l, i) => this.label(g, l, X([a / 2, a + d / 2, a + d + 0.17, a + d + 0.35 + r / 2][i]) - 3, y0 + hh - 2, '#6d7078'));
    // scope
    const sx = x0 + ew + pad, sw = W - sx - pad, mid = y0 + hh / 2;
    g.fillStyle = '#0a0b0d'; g.fillRect(sx, y0, sw, hh); this.grid(g, sx, y0, sw, hh, 8, 4);
    let pk = 0.05; for (let i = 0; i < this.tOut.length; i++) pk = Math.max(pk, Math.abs(this.tOut[i]));
    let z = 0; for (let i = 1; i < 1024; i++) if (this.tOut[i - 1] < 0 && this.tOut[i] >= 0) { z = i; break; }
    g.strokeStyle = this.color; g.lineWidth = 1.6; g.beginPath();
    for (let i = 0; i < 1024; i++) { const x = sx + i / 1024 * sw, y = mid - this.tOut[z + i] / pk * (hh / 2 - 6); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    this.label(g, 'OUTPUT', sx + 6, y0 + 14, '#a0a3aa');
    this.setReadout('');
  }
}
