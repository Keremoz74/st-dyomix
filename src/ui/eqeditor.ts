// Interactive EQ display (Pro EQ and Channel EQ): drag points to set frequency and gain, pinch / scroll for Q,
// tap empty space to add a band (Pro EQ), double-tap a point to remove it, long-press for type and slope.
import type { Commands } from '../commands';
import type { Insert } from '../model';
import type { ParamDef, PluginInstance } from '../audio/plugins';
import { PLUGINS } from '../audio/plugins';
import { h, openMenu, MenuItem } from './dom';
import { MAX_BANDS, BAND_TYPES, SLOPES, BAND_COLORS, bandKeys, hasGain, hasQ } from '../audio/proeq';

type Ctl = (p: ParamDef) => { el: HTMLElement; show: () => void };
interface Band { i: number; color: string; label: string; type: number; f: string; g?: string; q?: string; slope?: string; on?: string }

const FMIN = 20, FMAX = 20000;
const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export class EqEditor {
  readonly el: HTMLDivElement;
  readonly panel: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private sel = -1;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { band: Band; pinch0?: number; q0?: number; moved: boolean } | null = null;
  private lastTap = { i: -1, t: 0 };
  private holdTimer = 0;
  private ctlShows: (() => void)[] = [];
  private panelKey = '';
  private range: number;
  private freqs = (() => { const f = new Float32Array(300); for (let i = 0; i < f.length; i++) f[i] = FMIN * Math.pow(FMAX / FMIN, i / (f.length - 1)); return f; })();
  private mag = new Float32Array(300);
  private ph = new Float32Array(300);
  private spec: Float32Array<ArrayBuffer> | null = null;

  constructor(private cmd: Commands, private owner: string, private ins: Insert, private ctl: Ctl) {
    this.range = ins.type === 'peq' ? 24 : 18;
    this.canvas = h('canvas', { class: 'eqx-canvas', 'aria-label': 'EQ curve: drag the points; tap empty space to add a band' }) as HTMLCanvasElement;
    const hint = h('div', { class: 'eqx-hint' }, ins.type === 'peq'
      ? (COARSE ? 'Tap to add a point · drag to move · pinch for Q · double-tap to remove · hold for type' : 'Click to add a point · drag to move · scroll for Q · double-click to remove · right-click for type')
      : (COARSE ? 'Drag the points · pinch for Q · double-tap to reset' : 'Drag the points · scroll for Q · double-click to reset'));
    this.el = h('div', { class: 'eqx' }, this.canvas, hint);
    this.panel = h('div', { class: 'eqx-panel' });
    this.bindPointer();
    this.renderPanel(true);
    if (ins.type === 'peq') { const first = this.bands()[0]; this.sel = first ? first.i : -1; this.renderPanel(true); }
  }

  // ---------- model ----------
  private p() { return this.ins.params; }
  private bands(): Band[] {
    const p = this.p();
    if (this.ins.type === 'peq') {
      const out: Band[] = [];
      for (let i = 0; i < MAX_BANDS; i++) {
        const kk = bandKeys(i); if (!(p[kk.on] >= 0.5)) continue;
        const type = Math.round(p[kk.type] ?? 0);
        out.push({ i, color: BAND_COLORS[i], label: String(i + 1), type, f: kk.f, g: hasGain(type) ? kk.g : undefined, q: hasQ(type) ? kk.q : undefined, slope: type === 3 || type === 4 ? kk.s : undefined, on: kk.on });
      }
      return out;
    }
    // Channel EQ: fixed bands
    return [
      { i: 0, color: BAND_COLORS[0], label: 'LC', type: 3, f: 'hpf' },
      { i: 1, color: BAND_COLORS[2], label: 'L', type: 1, f: 'lowFreq', g: 'lowGain' },
      { i: 2, color: BAND_COLORS[4], label: 'M', type: 0, f: 'midFreq', g: 'midGain', q: 'midQ' },
      { i: 3, color: BAND_COLORS[6], label: 'H', type: 2, f: 'highFreq', g: 'highGain' },
      { i: 4, color: BAND_COLORS[8], label: 'HC', type: 4, f: 'lpf' },
    ];
  }
  private def(id: string) { return PLUGINS[this.ins.type].params.find(x => x.id === id)!; }
  private set(id: string, v: number) {
    const d = this.def(id); v = Math.max(d.min, Math.min(d.max, v));
    if (d.step) v = Math.round(v / d.step) * d.step;
    this.cmd.setParam(this.owner, this.ins.id, id, v);
  }

  // ---------- geometry ----------
  private W = 0; private H = 0;
  private xOf = (f: number) => Math.log(f / FMIN) / Math.log(FMAX / FMIN) * this.W;
  private fOf = (x: number) => FMIN * Math.pow(FMAX / FMIN, Math.max(0, Math.min(1, x / this.W)));
  private yOf = (db: number) => this.H / 2 - db / this.range * (this.H / 2 - 12);
  private gOf = (y: number) => (this.H / 2 - y) / (this.H / 2 - 12) * this.range;
  private pointOf(b: Band) {
    const p = this.p(), f = p[b.f];
    const off = this.ins.type === 'eq' && ((b.i === 0 && f <= 20.5) || (b.i === 4 && (f ?? 20000) >= 19900));
    const x = off ? (b.i === 0 ? 10 : this.W - 10) : this.xOf(f ?? 20000);
    return { x, y: b.g ? this.yOf(Math.max(-this.range, Math.min(this.range, p[b.g]))) : this.yOf(0) };
  }
  private hit(x: number, y: number): Band | null {
    const r = COARSE ? 26 : 14;
    let best: Band | null = null, bd = r;
    for (const b of this.bands()) { const pt = this.pointOf(b), d = Math.hypot(pt.x - x, pt.y - y); if (d < bd) { bd = d; best = b; } }
    return best;
  }

  // ---------- interaction ----------
  private local(e: PointerEvent | WheelEvent) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private bindPointer() {
    const c = this.canvas;
    c.addEventListener('contextmenu', e => {
      e.preventDefault();
      const { x, y } = this.local(e as unknown as PointerEvent), b = this.hit(x, y);
      if (b) { this.select(b.i); this.bandMenu(b, e.clientX, e.clientY); }
    });
    c.addEventListener('pointerdown', e => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const pt = this.local(e);
      this.pointers.set(e.pointerId, pt);
      if (this.pointers.size === 2 && this.drag?.band.q) { // pinch: Q
        const [a, b] = [...this.pointers.values()];
        this.drag.pinch0 = Math.max(10, Math.abs(a.x - b.x)); this.drag.q0 = this.p()[this.drag.band.q];
        clearTimeout(this.holdTimer);
        return;
      }
      if (this.pointers.size > 1) return;
      let b = this.hit(pt.x, pt.y);
      const now = performance.now();
      if (b && this.lastTap.i === b.i && now - this.lastTap.t < 320) { this.lastTap = { i: -1, t: 0 }; this.removeOrReset(b); return; }
      if (!b && this.ins.type === 'peq') b = this.addBand(pt.x, pt.y);
      if (!b) { this.select(-1); return; }
      this.lastTap = { i: b.i, t: now };
      this.select(b.i);
      this.cmd.store.checkpoint();
      this.drag = { band: b, moved: false };
      const bb = b, cx = e.clientX, cy = e.clientY;
      this.holdTimer = window.setTimeout(() => { if (this.drag && !this.drag.moved) { this.drag = null; this.bandMenu(bb, cx, cy); } }, 550);
    });
    c.addEventListener('pointermove', e => {
      if (!this.pointers.has(e.pointerId)) return;
      const pt = this.local(e); this.pointers.set(e.pointerId, pt);
      const d = this.drag; if (!d) return;
      if (this.pointers.size === 2 && d.pinch0 && d.band.q) {
        const [a, b] = [...this.pointers.values()];
        this.set(d.band.q, (d.q0 ?? 1) * Math.pow(Math.max(10, Math.abs(a.x - b.x)) / d.pinch0, -1.2));
        d.moved = true; return;
      }
      if (!d.moved && performance.now() - this.lastTap.t < 60) return;
      d.moved = true; clearTimeout(this.holdTimer);
      const fine = e.shiftKey ? 0.25 : 1;
      if (fine === 1) this.set(d.band.f, this.fOf(pt.x));
      if (d.band.g) this.set(d.band.g, this.gOf(pt.y));
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) { this.drag = null; clearTimeout(this.holdTimer); }
    };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', e => {
      const { x, y } = this.local(e);
      const b = this.hit(x, y) ?? this.bands().find(z => z.i === this.sel);
      if (!b?.q) return;
      e.preventDefault();
      this.set(b.q, this.p()[b.q] * Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
  }

  private addBand(x: number, y: number): Band | null {
    const p = this.p();
    const free = Array.from({ length: MAX_BANDS }, (_, i) => i).find(i => !(p[bandKeys(i).on] >= 0.5));
    if (free == null) return null;
    this.cmd.store.checkpoint();
    const kk = bandKeys(free), f = this.fOf(x);
    const type = f < 35 ? 3 : f > 14000 ? 4 : 0;
    this.set(kk.type, type); this.set(kk.f, f); this.set(kk.g, type === 0 ? this.gOf(y) : 0); this.set(kk.q, type === 0 ? 1 : 0.71); this.set(kk.s, 1);
    this.set(kk.on, 1);
    return this.bands().find(b => b.i === free) ?? null;
  }
  /** Adds a Low Cut (80 Hz) or High Cut (16 kHz) band, 24 dB/oct. */
  private addCut(type: 3 | 4) {
    const b = this.addBand(this.xOf(type === 3 ? 80 : 16000), this.yOf(0)); if (!b) return;
    const kk = bandKeys(b.i);
    this.set(kk.type, type); this.set(kk.f, type === 3 ? 80 : 16000); this.set(kk.g, 0); this.set(kk.q, 0.71); this.set(kk.s, 1);
    this.select(b.i);
  }
  private removeOrReset(b: Band) {
    this.cmd.store.checkpoint();
    if (this.ins.type === 'peq') { this.set(b.on!, 0); this.select(this.bands()[0]?.i ?? -1); }
    else if (b.i === 0) this.set('hpf', 20);
    else if (b.i === 4) this.set('lpf', 20000);
    else if (b.g) this.set(b.g, 0);
  }
  private bandMenu(b: Band, x: number, y: number) {
    const a = h('div', { style: { position: 'fixed', left: `${x}px`, top: `${y}px` } }); document.body.appendChild(a); setTimeout(() => a.remove(), 0);
    const p = this.p();
    if (this.ins.type !== 'peq') { openMenu(a, [{ header: 'Band' }, ['Reset', '', () => this.removeOrReset(b)]]); return; }
    const kk = bandKeys(b.i);
    const items: MenuItem[] = [{ header: `Band ${b.i + 1}` }, ...BAND_TYPES.map((t, ti) => [t, '', () => { this.cmd.store.checkpoint(); this.set(kk.type, ti); }, b.type === ti] as MenuItem)];
    if (b.slope) items.push('-', ...SLOPES.map((s, si) => [s, '', () => { this.cmd.store.checkpoint(); this.set(kk.s, si); }, Math.round(p[kk.s]) === si] as MenuItem));
    items.push('-', ['Remove Band', '', () => this.removeOrReset(b)]);
    openMenu(a, items);
  }
  private select(i: number) { if (this.sel === i) return; this.sel = i; this.renderPanel(true); }

  // ---------- band panel (under the display) ----------
  private renderPanel(force = false) {
    const def = PLUGINS[this.ins.type];
    if (this.ins.type !== 'peq') {
      if (!force && this.panelKey) return;
      this.panelKey = 'eq';
      const ctls = def.params.map(p => this.ctl(p));
      this.ctlShows = ctls.map(c => c.show);
      this.panel.replaceChildren(h('div', { class: 'pw-knobs' }, ...ctls.map(c => c.el)));
      return;
    }
    const bands = this.bands();
    if (!bands.some(b => b.i === this.sel)) this.sel = bands[0]?.i ?? -1;
    const key = `${bands.map(b => `${b.i}:${b.type}`).join(',')}|${this.sel}`;
    if (!force && key === this.panelKey) return;
    this.panelKey = key;
    const chips = h('div', { class: 'eqx-chips' },
      ...bands.map(b => h('button', { class: `eqx-chip${b.i === this.sel ? ' on' : ''}`, style: { borderColor: b.color, color: b.i === this.sel ? '#111214' : b.color, background: b.i === this.sel ? b.color : 'transparent' }, 'aria-label': `Band ${b.i + 1}: ${BAND_TYPES[b.type]}`, onClick: () => this.select(b.i) }, `${b.i + 1} ${BAND_TYPES[b.type]}`)),
      bands.length < MAX_BANDS ? h('button', { class: 'eqx-chip eqx-add', onClick: () => { const b = this.addBand(this.xOf(1000), this.yOf(0)); if (b) this.select(b.i); } }, '+ Band') : null,
      bands.length < MAX_BANDS && !bands.some(b => b.type === 3) ? h('button', { class: 'eqx-chip eqx-add', title: 'Low Cut (high-pass): removes rumble below the frequency', onClick: () => this.addCut(3) }, '+ Low Cut') : null,
      bands.length < MAX_BANDS && !bands.some(b => b.type === 4) ? h('button', { class: 'eqx-chip eqx-add', title: 'High Cut (low-pass): removes hiss and harshness above the frequency', onClick: () => this.addCut(4) }, '+ High Cut') : null);
    const ctls: { el: HTMLElement; show: () => void }[] = [];
    const b = bands.find(x => x.i === this.sel);
    if (b) {
      const kk = bandKeys(b.i);
      ctls.push(this.ctl(this.def(kk.type)), this.ctl(this.def(kk.f)));
      if (b.g) ctls.push(this.ctl(this.def(kk.g)));
      if (b.q) ctls.push(this.ctl(this.def(kk.q)));
      if (b.slope) ctls.push(this.ctl(this.def(kk.s)));
    }
    const outCtl = this.ctl(this.def('output')), anCtl = this.ctl(this.def('spectrum'));
    this.ctlShows = [...ctls, outCtl, anCtl].map(c => c.show);
    const del = b ? h('button', { class: 'pw-btn', onClick: () => this.removeOrReset(b) }, 'Remove Band') : null;
    this.panel.replaceChildren(chips,
      h('div', { class: 'pw-knobs eqx-knobs' }, ...ctls.map(c => c.el), h('span', { class: 'eqx-sep' }), outCtl.el, anCtl.el),
      del ? h('div', { class: 'eqx-actions' }, del) : h('div', { class: 'eqx-hint' }, 'No bands yet: tap the display to add one.'));
  }
  /** Called on parameter changes. */
  show() { this.renderPanel(); this.ctlShows.forEach(s => s()); }

  // ---------- drawing ----------
  draw(inst: (PluginInstance & { bandNodes?: Map<number, BiquadFilterNode[]> }) | undefined) {
    const c = this.canvas, dpr = devicePixelRatio || 1, w = c.clientWidth, hh = c.clientHeight;
    if (!w) return;
    this.W = w; this.H = hh;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#121316'; g.fillRect(0, 0, w, hh);
    // spectrum behind the curve
    if (inst?.analyser && (this.ins.type !== 'peq' || this.p().spectrum >= 0.5) && !this.ins.bypass) {
      const an = inst.analyser;
      if (!this.spec || this.spec.length !== an.frequencyBinCount) this.spec = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this.spec);
      const sr = an.context.sampleRate, lo = an.minDecibels, hi = an.maxDecibels;
      g.beginPath(); g.moveTo(0, hh);
      for (let x = 0; x <= w; x += 2) {
        const f = this.fOf(x), bin = Math.min(this.spec.length - 1, Math.round(f / (sr / 2) * this.spec.length));
        const v = Math.max(lo, Math.min(hi, this.spec[bin] + 4.5 * Math.log2(f / 1000))); // +4.5 dB/oct tilt, like pro analyzers
        g.lineTo(x, hh - (v - lo) / (hi - lo) * hh);
      }
      g.lineTo(w, hh); g.closePath(); g.fillStyle = '#5c6f9a33'; g.fill();
    }
    // grid
    g.font = '10px "JetBrains Mono", monospace'; g.textBaseline = 'top';
    for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(this.xOf(f)) + 0.5; g.fillStyle = '#24262b'; g.fillRect(x, 0, 1, hh);
      g.fillStyle = '#6d7078'; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, hh - 13);
    }
    const step = this.range >= 24 ? 6 : 6;
    for (let db = -this.range + step; db < this.range; db += step) {
      const y = Math.round(this.yOf(db)) + 0.5; g.fillStyle = db === 0 ? '#3a3c42' : '#22242a'; g.fillRect(0, y, w, 1);
      g.fillStyle = '#5d6068'; g.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y + 2);
    }
    if (!inst) return;
    const bands = this.bands();
    // each band's own curve (selected one filled)
    const nodesOf = (b: Band): BiquadFilterNode[] => this.ins.type === 'peq' ? inst.bandNodes?.get(b.i) ?? [] : inst.eqNodes?.[b.i] ? [inst.eqNodes[b.i]] : [];
    const resp = (nodes: BiquadFilterNode[]) => {
      const tot = new Float32Array(this.freqs.length).fill(1);
      for (const n of nodes) { n.getFrequencyResponse(this.freqs, this.mag, this.ph); for (let i = 0; i < tot.length; i++) tot[i] *= this.mag[i]; }
      return tot;
    };
    const path = (tot: Float32Array) => { g.beginPath(); for (let i = 0; i < tot.length; i++) { const x = this.xOf(this.freqs[i]), y = this.yOf(Math.max(-this.range - 6, Math.min(this.range + 6, 20 * Math.log10(tot[i] || 1e-6)))); i ? g.lineTo(x, y) : g.moveTo(x, y); } };
    for (const b of bands) {
      const nodes = nodesOf(b); if (!nodes.length) continue;
      if (this.ins.type === 'eq' && ((b.i === 0 && this.p().hpf <= 20.5) || (b.i === 4 && (this.p().lpf ?? 20000) >= 19900))) continue;
      path(resp(nodes));
      if (b.i === this.sel) { g.lineTo(w, this.yOf(0)); g.lineTo(0, this.yOf(0)); g.closePath(); g.fillStyle = b.color + '30'; g.fill(); }
      else { g.strokeStyle = b.color + '66'; g.lineWidth = 1; g.stroke(); }
    }
    // total curve
    path(resp(inst.eqNodes ?? []));
    g.strokeStyle = this.ins.bypass ? '#6a6d75' : '#e9ecf2'; g.lineWidth = 2; g.stroke();
    // points
    g.textBaseline = 'middle'; g.textAlign = 'center'; g.font = '700 10px Inter, sans-serif';
    for (const b of bands) {
      const { x, y } = this.pointOf(b), sel = b.i === this.sel, r = (COARSE ? 11 : 8) + (sel ? 2 : 0);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = sel ? b.color : '#121316'; g.fill(); g.lineWidth = 2; g.strokeStyle = b.color; g.stroke();
      g.fillStyle = sel ? '#111214' : b.color; g.fillText(b.label, x, y + 0.5);
      if (sel) {
        const p = this.p(), f = p[b.f];
        const txt = `${f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`}${b.g ? `  ${p[b.g] > 0 ? '+' : ''}${p[b.g].toFixed(1)} dB` : ''}${b.q ? `  Q ${p[b.q].toFixed(2)}` : ''}`;
        g.font = '600 11px Inter, sans-serif'; const tw = g.measureText(txt).width + 12;
        const tx = Math.max(tw / 2 + 2, Math.min(w - tw / 2 - 2, x)), ty = y - r - 14 < 10 ? y + r + 14 : y - r - 14;
        g.fillStyle = '#000000b0'; g.fillRect(tx - tw / 2, ty - 9, tw, 18); g.fillStyle = '#fff'; g.fillText(txt, tx, ty + 0.5);
        g.font = '700 10px Inter, sans-serif';
      }
    }
    g.textAlign = 'left';
  }
}
