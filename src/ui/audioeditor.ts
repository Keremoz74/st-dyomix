// Audio Editor: waveform view of an audio region with destructive (but undoable) processing on a selection.
// Processing writes a new copy of the audio file, so other regions that use the same file stay untouched.
import { PlayLine } from './playline';
import { Region } from '../model';
import { Commands } from '../commands';
import { h, icon, toast } from './dom';
import { isFolder, compOf, setComp, expandRegion } from '../takes';
import { anchors, srcAt, beatOfSrc, transients, enableFlex, setFollowTempo, quantizeFlex } from '../flex';
import { FlexMarker, uid } from '../model';

const RH = 24;

type Drag = { kind: 'flex'; m: FlexMarker; started: boolean } | { kind: 'sel'; b0: number } | { kind: 'scrub' } | { kind: 'pan'; x: number; sl: number } | { kind: 'swipe'; take: string; b0: number };
const GW = 120, COMP_H = 40;

export class AudioEditor {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private title: HTMLElement;
  private info: HTMLElement;
  private sel: [number, number] | null = null; // beats, absolute
  private drag: Drag | null = null;
  private dirty = true;
  private ppb = 60;
  private shown: string | null = null;
  private opsGroup!: HTMLElement;
  private flexBtn!: HTMLButtonElement;
  private followBtn!: HTMLButtonElement;
  private quantBtn!: HTMLButtonElement;
  private resetBtn!: HTMLButtonElement;
  private takesGroup!: HTMLElement;

  constructor(private cmd: Commands) {
    const { store } = cmd;
    this.title = h('span', { class: 'lm-title' });
    this.info = h('span', { class: 'pr-info' });
    const op = (label: string, title: string, f: () => void) => h('button', { class: 'tool-btn', title, onClick: f }, label);
    this.canvas = h('canvas', { class: 'pr-canvas' });
    this.spacer = h('div', { class: 'spacer' });
    this.scroller = h('div', { class: 'pr-scroll', tabindex: '0', 'aria-label': 'Audio waveform. Drag to select.' }, this.spacer);
    this.opsGroup = h('span', { class: 'ae-group' },
        op('Normalize', 'Normalize selection (or region) to -0.1 dBFS', () => this.process('normalize')),
        op('Gain −3', 'Lower selection by 3 dB', () => this.process('gain', -3)),
        op('Gain +3', 'Raise selection by 3 dB', () => this.process('gain', 3)),
        op('Fade In', 'Fade in across the selection', () => this.process('fadein')),
        op('Fade Out', 'Fade out across the selection', () => this.process('fadeout')),
        op('Reverse', 'Reverse selection (or region)', () => this.process('reverse')),
        op('Silence', 'Silence the selection', () => this.process('silence')),
        h('span', { class: 'lm-div' }),
        this.flexBtn = h('button', { class: 'tool-btn', title: 'Flex Time: drag transients to move audio in time', onClick: () => this.toggleFlex() }, '⇿ Flex'),
        this.followBtn = h('button', { class: 'tool-btn', title: 'Stretch this audio to follow tempo changes', onClick: () => this.toggleFollow() }, 'Follow Tempo'),
        this.quantBtn = h('button', { class: 'tool-btn', title: 'Move every transient onto the 1/16 grid (Grid value from the Piano Roll)', onClick: () => this.quantize() }, 'Quantize'),
        this.resetBtn = h('button', { class: 'tool-btn', title: 'Remove all flex markers', onClick: () => this.resetFlex() }, 'Reset'));
    this.takesGroup = h('span', { class: 'ae-group' },
        h('span', { class: 'lm-label' }, 'Swipe across a take to comp it · click a take name to use all of it'),
        op('Flatten', 'Turn the comp into plain regions', () => { const r = this.region; if (r) cmd.flattenTakeFolder(r); }));
    this.el = h('section', { class: 'editor', 'aria-label': 'Audio Editor', hidden: true },
      h('div', { class: 'lm-bar' },
        h('span', { class: 'pr-badge ae-badge' }, icon('wave', 14), 'Audio Editor'), this.title, h('span', { class: 'grow' }), this.info,
        this.opsGroup, this.takesGroup,
        h('span', { class: 'lm-div' }),
        h('button', { class: 'tool-btn', 'aria-label': 'Zoom out', onClick: () => this.zoom(1 / 1.3) }, icon('zoomOut', 16)),
        h('button', { class: 'tool-btn', 'aria-label': 'Zoom in', onClick: () => this.zoom(1.3) }, icon('zoomIn', 16)),
        h('button', { class: 'tool-btn', 'aria-label': 'Close Audio Editor', title: 'Close (E)', onClick: cmd.toggleEditor }, '×')),
      h('div', { class: 'pr-body' }, this.canvas, this.scroller));

    this.scroller.addEventListener('scroll', () => { this.dirty = true; });
    // two-finger pinch = horizontal zoom
    const tp = new Map<number, number>(); let lastD = 0;
    this.scroller.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') { tp.set(e.pointerId, e.clientX); if (tp.size === 2) { const [a, b] = [...tp.values()]; lastD = Math.max(10, Math.abs(a - b)); this.drag = null; } } }, true);
    this.scroller.addEventListener('pointermove', e => { if (!tp.has(e.pointerId)) return; tp.set(e.pointerId, e.clientX); if (tp.size === 2) { const [a, b] = [...tp.values()]; const d = Math.max(10, Math.abs(a - b)); this.zoom(d / lastD); lastD = d; e.stopImmediatePropagation(); } }, true);
    const tpEnd = (e: PointerEvent) => tp.delete(e.pointerId);
    this.scroller.addEventListener('pointerup', tpEnd, true); this.scroller.addEventListener('pointercancel', tpEnd, true);
    this.scroller.addEventListener('pointerdown', e => { if (tp.size < 2) this.onDown(e); });
    this.scroller.addEventListener('pointermove', e => this.onMove(e));
    this.scroller.addEventListener('pointerup', () => { const d = this.drag; this.drag = null; if (d?.kind === 'swipe' || d?.kind === 'flex') this.commit(); this.renderInfo(); });
    this.scroller.addEventListener('dblclick', e => {
      const r = this.region; if (!r?.flex?.on) return;
      const hit = this.flexHit(e.clientX - this.scroller.getBoundingClientRect().left);
      if (hit?.m) { this.cmd.store.checkpoint(); r.flex.markers = r.flex.markers.filter(m => m !== hit.m); this.commit(); }
    });
    this.scroller.addEventListener('pointercancel', () => { this.drag = null; });
    this.scroller.addEventListener('wheel', e => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    new ResizeObserver(() => { this.dirty = true; }).observe(this.el);
    store.on(() => { this.sync(); this.dirty = true; });
  }

  get region(): Region | undefined {
    const { ui } = this.cmd.store;
    const r = ui.editorRegionId ? this.cmd.store.region(ui.editorRegionId) : undefined;
    return r && r.kind !== 'midi' ? r : undefined;
  }

  private sync() {
    const { ui } = this.cmd.store;
    const r = this.region;
    this.el.hidden = !(ui.showEditor && r);
    this.el.classList.toggle('focused', ui.focus === 'editor');
    if (!r) return;
    this.title.textContent = `${r.name}  ·  ${this.cmd.store.track(r.trackId)?.name ?? ''}`;
    const folder = isFolder(r);
    this.opsGroup.hidden = folder; this.takesGroup.hidden = !folder;
    const fl = !!r.flex?.on;
    this.flexBtn.classList.toggle('on', fl); this.flexBtn.setAttribute('aria-pressed', String(fl));
    this.followBtn.classList.toggle('on', !!r.flex?.follow); this.followBtn.setAttribute('aria-pressed', String(!!r.flex?.follow));
    this.quantBtn.hidden = !fl; this.resetBtn.hidden = !fl; this.followBtn.hidden = !fl;
    if (this.shown !== r.id) {
      this.shown = r.id; this.sel = null;
      requestAnimationFrame(() => this.fit());
    }
    this.renderInfo();
  }

  private fit() {
    const r = this.region; if (!r) return;
    const w = Math.max(200, this.scroller.clientWidth - 40 - (isFolder(r) ? GW : 0));
    this.ppb = Math.max(8, Math.min(600, w / Math.max(0.25, r.length)));
    this.syncSize();
    this.scroller.scrollLeft = Math.max(0, r.start * this.ppb - (isFolder(r) ? 10 : 20));
    this.dirty = true;
  }

  private renderInfo() {
    const r = this.region;
    if (!r) return;
    const s = this.sel;
    const secs = s ? this.cmd.store.secs(s[0], s[1]) : this.cmd.store.secs(r.start, r.start + r.length);
    this.info.textContent = isFolder(r) ? `${r.takes!.length} takes · ${compOf(r).length} comp segment${compOf(r).length === 1 ? '' : 's'}` : `${s ? 'Selection' : 'Region'} ${secs.toFixed(3)} s`;
  }

  private zoom(f: number) {
    const c = (this.scroller.scrollLeft + this.scroller.clientWidth / 2) / this.ppb;
    this.ppb = Math.max(4, Math.min(2000, this.ppb * f));
    this.syncSize();
    this.scroller.scrollLeft = Math.max(0, c * this.ppb - this.scroller.clientWidth / 2);
    this.dirty = true;
  }

  private get gw() { const r = this.region; return r && isFolder(r) ? GW : 0; }
  private beatAt(clientX: number) { return (clientX - this.scroller.getBoundingClientRect().left - this.gw + this.scroller.scrollLeft) / this.ppb; }
  private takeLayout() {
    const r = this.region!, H = this.scroller.clientHeight;
    const n = r.takes!.length;
    const laneH = Math.max(26, Math.min(70, (H - RH - COMP_H - 6) / n));
    return { n, laneH, top: RH + COMP_H + 4 };
  }
  private takeRowAt(y: number) { const { n, laneH, top } = this.takeLayout(); const i = Math.floor((y - top) / laneH); return i >= 0 && i < n ? i : -1; }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const ui = this.cmd.store.ui;
    if (ui.focus !== 'editor') { ui.focus = 'editor'; this.cmd.store.emit('view'); }
    const r = this.region; if (!r) return;
    this.scroller.setPointerCapture(e.pointerId);
    const y = e.clientY - this.scroller.getBoundingClientRect().top;
    if (y < RH) { this.drag = { kind: 'scrub' }; this.cmd.locate(this.cmd.store.snapBeat(this.beatAt(e.clientX))); return; }
    if (isFolder(r)) {
      const x = e.clientX - this.scroller.getBoundingClientRect().left;
      const i = this.takeRowAt(y);
      if (i < 0) { if (e.pointerType === 'touch') this.drag = { kind: 'pan', x: e.clientX, sl: this.scroller.scrollLeft }; return; }
      const take = r.takes![i];
      if (x < GW) {
        const { laneH, top } = this.takeLayout();
        const delHit = x > GW - 22 && y < top + i * laneH + 20;
        this.cmd.store.checkpoint();
        if (delHit) this.deleteTake(take.id);
        else { r.comp = [{ s: 0, e: r.length, take: take.id }]; this.commit(); }
        return;
      }
      this.cmd.store.checkpoint();
      const b0 = this.snapB(this.beatAt(e.clientX), e.shiftKey);
      this.drag = { kind: 'swipe', take: take.id, b0 };
      return;
    }
    if (r.flex?.on) {
      const x = e.clientX - this.scroller.getBoundingClientRect().left;
      const hit = this.flexHit(x);
      if (hit) {
        let m = hit.m;
        if (!m) { this.cmd.store.checkpoint(); m = { id: uid('fm'), src: hit.src!, b: hit.b }; r.flex.markers.push(m); }
        this.drag = { kind: 'flex', m, started: !hit.m };
        this.dirty = true;
        return;
      }
    }
    if (e.pointerType === 'touch' && !this.sel) { this.drag = { kind: 'pan', x: e.clientX, sl: this.scroller.scrollLeft }; return; }
    const b = this.clamp(this.beatAt(e.clientX));
    this.drag = { kind: 'sel', b0: b };
    this.sel = null; this.dirty = true;
  }

  private onMove(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    if (d.kind === 'pan') { this.scroller.scrollLeft = d.sl - (e.clientX - d.x); return; }
    if (d.kind === 'scrub') { this.cmd.store.ui.playhead = Math.max(0, this.cmd.store.snapBeat(this.beatAt(e.clientX))); this.cmd.store.emit('transport'); return; }
    if (d.kind === 'flex') {
      const r = this.region!; const { store } = this.cmd;
      if (!d.started) { store.checkpoint(); d.started = true; }
      const u = e.shiftKey ? 0 : store.snapUnit();
      let b = this.beatAt(e.clientX) - r.start; if (u) b = Math.round((r.start + b) / u) * u - r.start;
      const others = r.flex!.markers.filter(m => m !== d.m);
      const lo = Math.max(0.01, ...others.filter(m => m.src < d.m.src).map(m => m.b + 0.01));
      const hi = Math.min(r.length - 0.01, ...others.filter(m => m.src > d.m.src).map(m => m.b - 0.01));
      d.m.b = Math.max(lo, Math.min(hi, b));
      this.dirty = true;
      return;
    }
    if (d.kind === 'swipe') {
      const r = this.region!; const b = this.snapB(this.beatAt(e.clientX), e.shiftKey);
      if (Math.abs(b - d.b0) * this.ppb < 2) return;
      setComp(r, Math.min(b, d.b0) - r.start, Math.max(b, d.b0) - r.start, d.take);
      this.renderInfo(); this.dirty = true; this.cmd.engine.resync();
      return;
    }
    const b = this.clamp(this.beatAt(e.clientX));
    this.sel = Math.abs(b - d.b0) * this.ppb < 3 ? null : [Math.min(b, d.b0), Math.max(b, d.b0)];
    this.renderInfo(); this.dirty = true;
  }

  private snapB(b: number, free: boolean) { const r = this.region!; const u = free ? 0 : (this.cmd.store.snapUnit() || 0); const v = u ? Math.round(b / u) * u : b; return Math.max(r.start, Math.min(r.start + r.length, v)); }
  private commit() { this.cmd.store.emit('structure'); this.cmd.engine.resync(); this.dirty = true; }
  private deleteTake(id: string) {
    const r = this.region!; if (r.takes!.length <= 1) { toast('A take folder needs at least one take'); return; }
    r.takes = r.takes!.filter(t => t.id !== id);
    const fallback = r.takes[r.takes.length - 1].id;
    r.comp = compOf(r).map(sg => (sg.take === id ? { ...sg, take: fallback } : sg));
    setComp(r, 0, 0, fallback); // re-merges neighbours
    this.commit();
  }

  private flexEdit(fn: (r: import('../model').Region) => void) {
    const r = this.region; if (!r || isFolder(r)) return;
    this.cmd.store.checkpoint(); fn(r); this.commit(); this.sync();
  }
  toggleFlex() { this.flexEdit(r => { enableFlex(this.cmd.store, r, !r.flex?.on); toast(r.flex!.on ? 'Flex on: drag a transient (thin line) to move it' : 'Flex off'); }); }
  toggleFollow() { this.flexEdit(r => setFollowTempo(this.cmd.store, r, !r.flex?.follow)); }
  quantize() {
    const u = this.cmd.store.ui.prSnap || 0.25; // the Grid value shared with the Piano Roll (1/16 by default)
    this.flexEdit(r => { const n = quantizeFlex(this.cmd.store, r, u); toast(n ? `Quantized ${n} transients to the ${u >= 1 ? `${u}-beat` : `1/${Math.round(4 / u)}`} grid` : 'No transients found'); });
  }
  resetFlex() { this.flexEdit(r => { if (r.flex) r.flex.markers = []; }); }
  private flexHit(x: number) {
    const r = this.region!; const { store } = this.cmd;
    const an = anchors(store, r); const X = (b: number) => (r.start + b) * this.ppb - this.scroller.scrollLeft;
    let best: { m?: FlexMarker; src?: number; b: number } | null = null, bd = 7;
    for (const m of r.flex?.markers ?? []) { const d = Math.abs(X(m.b) - x); if (d < bd) { bd = d; best = { m, b: m.b }; } }
    if (best) return best;
    const buf = store.buffers.get(r.bufferId); if (!buf) return null;
    const s0 = an[0].src, s1 = an[an.length - 1].src;
    for (const t of transients(buf)) {
      if (t < s0 || t > s1) continue;
      const b = beatOfSrc(an, t); if (b == null) continue;
      const d = Math.abs(X(b) - x); if (d < bd) { bd = d; best = { src: t, b }; }
    }
    return best;
  }

  private clamp(b: number) { const r = this.region!; return Math.max(r.start, Math.min(r.start + r.length, b)); }

  selectAll() { const r = this.region; if (!r) return; this.sel = [r.start, r.start + r.length]; this.renderInfo(); this.dirty = true; }
  clearSelection() { this.sel = null; this.renderInfo(); this.dirty = true; }

  process(op: 'normalize' | 'reverse' | 'silence' | 'fadein' | 'fadeout' | 'gain', db = 0) {
    const r = this.region; if (!r) { toast('Open an audio region first'); return; }
    const { store, engine } = this.cmd;
    if (isFolder(r)) { toast('Flatten the take folder first, then process the audio'); return; }
    const src = store.buffers.get(r.bufferId); if (!src) return;
    const [s0, s1] = this.sel ?? [r.start, r.start + r.length];
    const sr = src.sampleRate;
    const an = r.flex?.on ? anchors(store, r) : null;
    const srcOf = (b: number) => (an ? srcAt(an, b - r.start) : r.offset + store.secs(r.start, b));
    const i0 = Math.max(0, Math.round(srcOf(s0) * sr));
    const i1 = Math.min(src.length, Math.round(srcOf(s1) * sr));
    if (i1 - i0 < 2) { toast('Select a longer part of the audio'); return; }
    const out = engine.ctx.createBuffer(src.numberOfChannels, src.length, sr);
    const chans: Float32Array<ArrayBuffer>[] = [];
    for (let c = 0; c < src.numberOfChannels; c++) { const d = new Float32Array(src.getChannelData(c)); chans.push(d); }
    const n = i1 - i0;
    if (isFolder(r)) { toast('Flatten the take folder first, then process the audio'); return; }
    if (op === 'normalize') {
      let peak = 0;
      for (const d of chans) for (let i = i0; i < i1; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
      if (peak < 1e-6) { toast('The selection is silent'); return; }
      const g = Math.pow(10, -0.1 / 20) / peak;
      for (const d of chans) for (let i = i0; i < i1; i++) d[i] *= g;
      toast(`Normalized: ${g >= 1 ? '+' : ''}${(20 * Math.log10(g)).toFixed(1)} dB`);
    } else if (op === 'gain') {
      const g = Math.pow(10, db / 20);
      for (const d of chans) for (let i = i0; i < i1; i++) d[i] *= g;
    } else if (op === 'reverse') {
      for (const d of chans) d.subarray(i0, i1).reverse();
    } else if (op === 'silence') {
      for (const d of chans) d.fill(0, i0, i1);
    } else {
      for (const d of chans) for (let i = 0; i < n; i++) d[i0 + i] *= op === 'fadein' ? i / n : 1 - i / n;
    }
    chans.forEach((d, c) => out.copyToChannel(d, c));
    store.checkpoint();
    r.bufferId = store.addBuffer(out);
    store.emit('structure');
    engine.resync();
  }

  private syncSize() {
    const { store } = this.cmd;
    const total = Math.max(store.songEndBeats() + 16 * store.beatsPerBar, 64 * store.beatsPerBar);
    this.spacer.style.width = `${total * this.ppb}px`;
    this.spacer.style.height = '1px';
  }

  private playLine?: PlayLine;
  frame(playhead: number) {
    if (this.el.hidden) return;
    const st = this.cmd.store, takes = !!this.region && isFolder(this.region), W0 = this.scroller.clientWidth;
    let px = playhead * this.ppb - this.scroller.scrollLeft;
    if (!takes && st.ui.playing && this.region && (px > W0 - 20 || px < 0)) { this.scroller.scrollLeft = Math.max(0, playhead * this.ppb - 40); px = playhead * this.ppb - this.scroller.scrollLeft; this.dirty = true; }
    this.playLine ??= new PlayLine(this.canvas.parentElement!);
    this.playLine.set(!takes && this.region && px >= 0 && px <= W0 ? px : null, st.ui.recording);
    if (!this.dirty && !this.drag && !(takes && st.ui.playing)) return;
    this.dirty = false;
    this.syncSize();
    const { store } = this.cmd;
    const c = this.canvas, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16171a'; g.fillRect(0, 0, W, H);
    if (this.region && isFolder(this.region)) { this.drawTakes(g, W, H, playhead); return; }
    const r = this.region, t = r && store.track(r.trackId), buf = r && store.buffers.get(r.bufferId);
    if (!r || !t || !buf) return;
    const sl = this.scroller.scrollLeft, ppb = this.ppb, bpb = store.beatsPerBar;
    const X = (b: number) => b * ppb - sl;
    // ruler
    g.fillStyle = '#25262a'; g.fillRect(0, 0, W, RH); g.fillStyle = '#0f1012'; g.fillRect(0, RH - 1, W, 1);
    g.font = '11px "JetBrains Mono", monospace'; g.textBaseline = 'top';
    let step = 1; while (ppb * bpb * step < 40) step *= 2;
    const b0 = Math.floor(sl / ppb), b1 = Math.ceil((sl + W) / ppb);
    for (let b = Math.floor(b0 / bpb) * bpb; b <= b1; b += bpb) {
      if (b < 0 || (b / bpb) % step) continue;
      const x = Math.round(X(b)) + 0.5;
      g.fillStyle = '#5a5d65'; g.fillRect(x, 8, 1, RH - 8); g.fillStyle = '#c4c6cc'; g.fillText(String(b / bpb + 1), x + 4, 8);
    }
    if (r.flex?.on) { this.drawFlex(g, W, H, X, r, t.color, buf); }
    else {
    // the whole audio file, placed where the region puts it
    const fileStart = store.beatAfter(r.start, -r.offset);
    const top = RH + 4, laneH = (H - RH - 8) / buf.numberOfChannels;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch), mid = top + laneH * ch + laneH / 2, amp = laneH / 2 - 3;
      g.fillStyle = '#1f2024'; g.fillRect(0, top + laneH * ch + 1, W, laneH - 2);
      g.fillStyle = '#2e3036'; g.fillRect(0, Math.round(mid), W, 1);
      const x0 = Math.max(0, Math.floor(X(fileStart))), x1 = Math.min(W, Math.ceil(X(store.beatAfter(fileStart, buf.duration))));
      for (let x = x0; x < x1; x++) {
        const ta = store.secs(fileStart, (x + sl) / ppb), tb = store.secs(fileStart, (x + 1 + sl) / ppb);
        let ia = Math.max(0, Math.floor(ta * buf.sampleRate)); const ib = Math.min(d.length, Math.max(ia + 1, Math.ceil(tb * buf.sampleRate)));
        let lo = 0, hi = 0; const stride = Math.max(1, Math.floor((ib - ia) / 256));
        for (; ia < ib; ia += stride) { const v = d[ia]; if (v < lo) lo = v; if (v > hi) hi = v; }
        const inRegion = (x + sl) / ppb >= r.start && (x + sl) / ppb < r.start + r.length;
        g.fillStyle = inRegion ? t.color : '#4a4d55';
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    }
    // region bounds
    const rx0 = X(r.start), rx1 = X(r.start + r.length);
    g.fillStyle = '#00000066'; g.fillRect(0, RH, Math.max(0, rx0), H - RH); g.fillRect(rx1, RH, Math.max(0, W - rx1), H - RH);
    g.fillStyle = t.color; g.fillRect(rx0, RH, 1, H - RH); g.fillRect(rx1, RH, 1, H - RH);
    g.fillStyle = t.color + '55'; g.fillRect(Math.max(0, rx0), 0, Math.max(0, Math.min(W, rx1) - Math.max(0, rx0)), 4);
    // selection
    if (this.sel) { const sx0 = X(this.sel[0]), sx1 = X(this.sel[1]); g.fillStyle = '#4c9aff33'; g.fillRect(sx0, RH, sx1 - sx0, H - RH); g.fillStyle = '#4c9aff'; g.fillRect(sx0, RH, 1, H - RH); g.fillRect(sx1, RH, 1, H - RH); }
  }

  private drawTakes(g: CanvasRenderingContext2D, W: number, H: number, playhead: number) {
    const { store } = this.cmd;
    const r = this.region!, t = store.track(r.trackId)!;
    const sl = this.scroller.scrollLeft, ppb = this.ppb, bpb = store.beatsPerBar;
    const X = (b: number) => GW + b * ppb - sl;
    const comp = compOf(r);
    // ruler
    g.fillStyle = '#25262a'; g.fillRect(0, 0, W, RH); g.fillStyle = '#0f1012'; g.fillRect(0, RH - 1, W, 1);
    g.font = '11px "JetBrains Mono", monospace'; g.textBaseline = 'top';
    let step = 1; while (ppb * bpb * step < 40) step *= 2;
    const b0 = Math.floor(sl / ppb), b1 = Math.ceil((sl + W) / ppb);
    for (let b = Math.floor(b0 / bpb) * bpb; b <= b1; b += bpb) {
      if (b < 0 || (b / bpb) % step) continue;
      const x = Math.round(X(b)) + 0.5; if (x < GW) continue;
      g.fillStyle = '#5a5d65'; g.fillRect(x, 8, 1, RH - 8); g.fillStyle = '#c4c6cc'; g.fillText(String(b / bpb + 1), x + 4, 8);
    }
    const lane = (y: number, hh: number, buf: AudioBuffer | undefined, offset: number, active: (b: number) => boolean, col: string) => {
      if (!buf) return;
      const d = buf.getChannelData(0), mid = y + hh / 2, amp = hh / 2 - 3;
      const x0 = Math.max(GW, Math.floor(X(r.start))), x1 = Math.min(W, Math.ceil(X(r.start + r.length)));
      for (let x = x0; x < x1; x++) {
        const ba = (x + sl - GW) / ppb, bb = (x + 1 + sl - GW) / ppb;
        const ta = offset + store.secs(r.start, ba), tb = offset + store.secs(r.start, bb);
        let ia = Math.floor(ta * buf.sampleRate); const ib = Math.min(d.length, Math.ceil(tb * buf.sampleRate));
        if (ib <= 0 || ia >= d.length) continue;
        ia = Math.max(0, ia);
        let lo = 0, hi = 0; const stride = Math.max(1, Math.floor((ib - ia) / 128));
        for (; ia < ib; ia += stride) { const v = d[ia]; if (v < lo) lo = v; if (v > hi) hi = v; }
        g.fillStyle = active(ba) ? col : '#4a4d55';
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    };
    // comp lane (what plays)
    g.fillStyle = '#1b1c20'; g.fillRect(0, RH, W, COMP_H);
    for (const vr of expandRegion(store, r)) {
      const tk = r.takes!.find(x => x.bufferId === vr.bufferId && Math.abs((x.offset + store.secs(r.start, vr.start)) - vr.offset) < 1e-3);
      lane(RH + 2, COMP_H - 4, store.buffers.get(vr.bufferId), vr.offset - store.secs(r.start, vr.start), b => b >= vr.start && b < vr.start + vr.length, t.color);
      if (tk) { const x = X(vr.start); if (x > GW) { g.fillStyle = '#ffffffcc'; g.fillRect(x, RH, 1, COMP_H); } }
    }
    // take lanes
    const { laneH, top } = this.takeLayout();
    r.takes!.forEach((tk, i) => {
      const y = top + i * laneH;
      g.fillStyle = i % 2 ? '#1f2024' : '#222327'; g.fillRect(GW, y, W - GW, laneH - 1);
      const segs = comp.filter(sg => sg.take === tk.id);
      for (const sg of segs) { g.fillStyle = t.color + '26'; g.fillRect(X(r.start + sg.s), y, (sg.e - sg.s) * ppb, laneH - 1); }
      lane(y, laneH - 1, store.buffers.get(tk.bufferId), tk.offset, b => segs.some(sg => b - r.start >= sg.s && b - r.start < sg.e), t.color);
    });
    // region bounds + swipe hint
    const rx0 = X(r.start), rx1 = X(r.start + r.length);
    g.fillStyle = t.color; g.fillRect(rx0, RH, 1, H - RH); g.fillRect(rx1, RH, 1, H - RH);
    // gutter
    g.fillStyle = '#25262a'; g.fillRect(0, RH, GW, H - RH);
    g.fillStyle = '#0f1012'; g.fillRect(GW - 1, RH, 1, H - RH);
    g.font = '600 11px Inter, sans-serif'; g.textBaseline = 'middle';
    g.fillStyle = '#e6e7ea'; g.fillText('Comp', 10, RH + COMP_H / 2);
    r.takes!.forEach((tk, i) => {
      const y = top + i * laneH;
      const used = comp.some(sg => sg.take === tk.id);
      g.fillStyle = used ? t.color : '#3a3c42'; g.fillRect(6, y + 6, 4, laneH - 13);
      g.fillStyle = used ? '#e6e7ea' : '#9a9da5'; g.fillText(tk.name, 16, y + Math.min(14, laneH / 2));
      g.fillStyle = '#8b8e96'; g.font = '13px Inter, sans-serif'; g.fillText('×', GW - 16, y + 11); g.font = '600 11px Inter, sans-serif';
      g.fillStyle = '#0f1012'; g.fillRect(0, y + laneH - 1, W, 1);
    });
    const px = X(playhead);
    if (px >= GW && px <= W) { g.fillStyle = store.ui.recording ? '#ff4d4f' : '#ffffff'; g.fillRect(Math.round(px), 0, 1, H); }
    if (store.ui.playing && (px > W - 20 || px < GW)) this.scroller.scrollLeft = Math.max(0, playhead * ppb - 40);
  }

  /** Flexed view: the region's audio drawn through the flex map, transients and markers on top. */
  private drawFlex(g: CanvasRenderingContext2D, W: number, H: number, X: (b: number) => number, r: import('../model').Region, color: string, buf: AudioBuffer) {
    const { store } = this.cmd;
    const an = anchors(store, r), sl = this.scroller.scrollLeft, ppb = this.ppb, sr = buf.sampleRate;
    const top = RH + 4, laneH = (H - RH - 8) / buf.numberOfChannels;
    const x0 = Math.max(0, Math.floor(X(r.start))), x1 = Math.min(W, Math.ceil(X(r.start + r.length)));
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch), mid = top + laneH * ch + laneH / 2, amp = laneH / 2 - 3;
      g.fillStyle = '#1f2024'; g.fillRect(0, top + laneH * ch + 1, W, laneH - 2);
      g.fillStyle = '#2e3036'; g.fillRect(0, Math.round(mid), W, 1);
      g.fillStyle = color;
      for (let x = x0; x < x1; x++) {
        const ba = (x + sl) / ppb - r.start, bb = (x + 1 + sl) / ppb - r.start;
        let ia = Math.max(0, Math.floor(srcAt(an, ba) * sr)); const ib = Math.min(d.length, Math.max(ia + 1, Math.ceil(srcAt(an, bb) * sr)));
        let lo = 0, hi = 0; const stride = Math.max(1, Math.floor((ib - ia) / 256));
        for (; ia < ib; ia += stride) { const v = d[ia]; if (v < lo) lo = v; if (v > hi) hi = v; }
        g.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      }
    }
    // transients (thin) and flex markers (orange, with handle)
    const s0 = an[0].src, s1 = an[an.length - 1].src;
    const marked = new Set((r.flex?.markers ?? []).map(m => m.src.toFixed(4)));
    g.fillStyle = '#ffffff70';
    for (const t of transients(buf)) {
      if (t < s0 || t > s1 || marked.has(t.toFixed(4))) continue;
      const b = beatOfSrc(an, t); if (b == null) continue;
      const x = Math.round(X(r.start + b)); if (x >= 0 && x <= W) { g.fillRect(x, RH, 1, H - RH); g.fillRect(x - 2, RH, 5, 3); }
    }
    for (const m of r.flex?.markers ?? []) {
      const x = Math.round(X(r.start + m.b)); if (x < -6 || x > W + 6) continue;
      const active = this.drag?.kind === 'flex' && this.drag.m === m;
      g.fillStyle = active ? '#ffffff' : '#ff9f43'; g.fillRect(x, RH, 1.5, H - RH);
      g.beginPath(); g.moveTo(x - 5, RH); g.lineTo(x + 6, RH); g.lineTo(x + 0.5, RH + 8); g.closePath(); g.fill();
    }
  }
}
