// Piano Roll editor for MIDI regions (bottom editor area, opened with P or a double-click).
import { Note, Region } from '../model';
import { Commands } from '../commands';
import { DRUM_NAMES, noteName } from '../audio/instruments';
import { h, icon, openMenu, toast, MenuItem } from './dom';
import { midiTabs } from './scoreeditor';

const RH = 24, VH = 64, EDGE = 6;
const BLACK = new Set([1, 3, 6, 8, 10]);
const SNAPS: [number, string][] = [[1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32'], [0, 'Off']];

type Drag =
  | { kind: 'move'; anchor: Note; orig: Map<Note, { s: number; p: number }>; x0: number; y0: number; copy: boolean; started: boolean; lastP: number }
  | { kind: 'resize'; orig: Map<Note, number>; anchor: Note; x0: number; started: boolean }
  | { kind: 'marquee'; x0: number; y0: number; x: number; y: number; base: Set<Note> }
  | { kind: 'vel'; started: boolean }
  | { kind: 'key'; p: number }
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; y: number; sl: number; st: number };

export class PianoRoll {
  el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private title: HTMLElement;
  private snapBtn: HTMLButtonElement;
  private info: HTMLElement;
  sel = new Set<Note>();
  private drag: Drag | null = null;
  private dirty = true;
  private lastLen = 1;
  private shownRegion: string | null = null;
  private row = 14;
  private tabsSlot = h('span', {});

  constructor(private cmd: Commands) {
    const { store } = cmd;
    this.title = h('span', { class: 'lm-title' });
    this.info = h('span', { class: 'pr-info' });
    this.snapBtn = h('button', { class: 'sel-btn', title: 'Grid / quantize value', onClick: () => openMenu(this.snapBtn, SNAPS.map(([v, l]) => [l, '', () => { store.ui.prSnap = v; this.renderBar(); this.dirty = true; }, store.ui.prSnap === v] as MenuItem)) });
    this.canvas = h('canvas', { class: 'pr-canvas' });
    this.spacer = h('div', { class: 'spacer' });
    this.scroller = h('div', { class: 'pr-scroll', tabindex: '0', 'aria-label': 'Piano Roll notes. Double-click to add a note.' }, this.spacer);
    this.el = h('section', { class: 'editor', 'aria-label': 'Piano Roll', hidden: true },
      h('div', { class: 'lm-bar' },
        this.tabsSlot, this.title, h('span', { class: 'grow' }), this.info,
        h('span', { class: 'lm-label' }, 'Grid'), this.snapBtn,
        h('button', { class: 'tool-btn', title: 'Quantize selected notes (Q)', onClick: () => this.quantize() }, 'Q', h('span', {}, 'Quantize')),
        (() => { const b: HTMLButtonElement = h('button', { class: 'tool-btn', 'aria-haspopup': 'menu', title: 'Note functions (selected notes, or all)', onClick: () => openMenu(b, this.fnMenu()) }, 'Functions', icon('chevron', 12)); return b; })(),
        h('span', { class: 'lm-div' }),
        h('button', { class: 'tool-btn', 'aria-label': 'Zoom out', onClick: () => this.zoom(1 / 1.3) }, icon('zoomOut', 16)),
        h('button', { class: 'tool-btn', 'aria-label': 'Zoom in', onClick: () => this.zoom(1.3) }, icon('zoomIn', 16)),
        h('button', { class: 'tool-btn', 'aria-label': 'Close Piano Roll', title: 'Close (P)', onClick: cmd.toggleEditor }, '×')),
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
    this.scroller.addEventListener('pointerup', () => this.onUp());
    this.scroller.addEventListener('pointercancel', () => this.onUp());
    this.scroller.addEventListener('dblclick', e => this.onDbl(e));
    this.scroller.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    new ResizeObserver(() => { this.dirty = true; }).observe(this.el);

    store.on(k => {
      if (k === 'view' || k === 'structure') this.sync();
      this.dirty = true;
    });
  }

  // ---------- state ----------
  get region(): Region | undefined { const id = this.cmd.store.ui.editorRegionId; const r = id ? this.cmd.store.region(id) : undefined; return r?.kind === 'midi' && !r.session && !r.pattern ? r : undefined; }
  private get track() { const r = this.region; return r ? this.cmd.store.track(r.trackId) : undefined; }
  private get isDrums() { return this.track?.instrument?.type === 'drums'; }
  private get KW() { return this.isDrums ? 104 : 56; }
  private get ppb() { return this.cmd.store.ui.prPpb; }

  private sync() {
    const { ui } = this.cmd.store;
    const sel = ui.editorRegionId ? this.cmd.store.region(ui.editorRegionId) : undefined;
    this.el.hidden = !ui.showEditor || ui.midiView === 'score' || (!!sel && (sel.kind !== 'midi' || !!sel.session || !!sel.pattern));
    this.tabsSlot.replaceChildren(midiTabs(this.cmd));
    this.el.classList.toggle('focused', ui.focus === 'editor');
    const r = this.region;
    if (r) {
      const live = new Set(r.notes ?? []);
      for (const n of [...this.sel]) if (!live.has(n)) this.sel.delete(n);
    } else this.sel.clear();
    this.renderBar();
    if (ui.showEditor && r && this.shownRegion !== r.id) { this.shownRegion = r.id; this.sel.clear(); requestAnimationFrame(() => this.scrollToRegion()); }
  }

  private renderBar() {
    const r = this.region, t = this.track;
    this.title.textContent = r ? `${r.name}  ·  ${t?.name ?? ''}` : 'No MIDI region selected';
    this.snapBtn.replaceChildren(h('span', {}, SNAPS.find(s => s[0] === this.cmd.store.ui.prSnap)?.[1] ?? '1/16'), icon('chevron', 10));
    this.info.textContent = this.sel.size ? `${this.sel.size} selected · vel ${Math.round([...this.sel].reduce((a, n) => a + n.v, 0) / this.sel.size)}` : '';
  }

  private scrollToRegion() {
    const r = this.region; if (!r) return;
    this.syncSize();
    this.scroller.scrollLeft = Math.max(0, (r.start - 0.5) * this.ppb);
    const notes = r.notes ?? [];
    const mid = notes.length ? notes.reduce((a, n) => a + n.p, 0) / notes.length : (this.isDrums ? 42 : 60);
    const areaH = this.scroller.clientHeight - RH - VH;
    this.scroller.scrollTop = Math.max(0, (127 - mid) * this.row - areaH / 2);
    this.dirty = true;
  }

  private zoom(f: number) {
    const ui = this.cmd.store.ui;
    const centerBeat = (this.scroller.scrollLeft + (this.scroller.clientWidth - this.KW) / 2) / this.ppb;
    ui.prPpb = Math.max(12, Math.min(480, ui.prPpb * f));
    this.syncSize();
    this.scroller.scrollLeft = Math.max(0, centerBeat * this.ppb - (this.scroller.clientWidth - this.KW) / 2);
    this.dirty = true;
  }

  private snap(b: number) { const u = this.cmd.store.ui.prSnap; return u ? Math.round(b / u) * u : b; }
  private snapFloor(b: number) { const u = this.cmd.store.ui.prSnap; return u ? Math.floor(b / u + 1e-6) * u : b; }

  // ---------- geometry ----------
  private local(e: { clientX: number; clientY: number }) { const r = this.scroller.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; }
  private beatAtX(x: number) { return (x - this.KW + this.scroller.scrollLeft) / this.ppb; }
  private pitchAtY(y: number) { return Math.max(0, Math.min(127, 127 - Math.floor((y - RH + this.scroller.scrollTop) / this.row))); }
  private noteRect(r: Region, n: Note) {
    return { x: this.KW + (r.start + n.s) * this.ppb - this.scroller.scrollLeft, y: RH + (127 - n.p) * this.row - this.scroller.scrollTop, w: Math.max(3, n.l * this.ppb), h: this.row };
  }
  private hitNote(x: number, y: number): { n: Note; edge: boolean } | null {
    const r = this.region; if (!r?.notes) return null;
    for (let i = r.notes.length - 1; i >= 0; i--) {
      const n = r.notes[i], q = this.noteRect(r, n);
      if (x >= q.x && x <= q.x + q.w && y >= q.y && y < q.y + q.h) return { n, edge: q.x + q.w - x < Math.min(EDGE, q.w / 3) };
    }
    return null;
  }

  // ---------- editing helpers ----------
  private touch(started: boolean) { if (!started) this.cmd.store.checkpoint(); }
  private fitRegion() {
    const r = this.region; if (!r?.notes) return;
    const bpb = this.cmd.store.beatsPerBar;
    const end = Math.max(0, ...r.notes.map(n => n.s + n.l));
    if (end > r.length) r.length = Math.ceil(end / bpb) * bpb;
  }
  private commit() { this.fitRegion(); this.cmd.store.emit('structure'); this.cmd.engine.resync(); }
  private audition(p: number, v = 100) { const t = this.track; if (t) this.cmd.engine.audition(t.id, p, v); }

  /** Logic's MIDI Functions: work on the selected notes, or all notes when none are selected. */
  private fnMenu(): MenuItem[] {
    const run = (name: string, fn: (ns: Note[], all: Note[]) => void) => () => {
      const r = this.region; if (!r?.notes?.length) return;
      const ns = this.sel.size ? [...this.sel] : r.notes;
      this.cmd.store.checkpoint(); fn(ns, r.notes); this.commit(); toast(`${name}: ${ns.length} note${ns.length === 1 ? '' : 's'}`);
    };
    const vel = (d: number) => run(`Velocity ${d > 0 ? '+' : ''}${d}`, ns => ns.forEach(n => { n.v = Math.max(1, Math.min(127, n.v + d)); }));
    return [
      ['Legato', '', run('Legato', ns => {
        const sorted = [...ns].sort((a, b) => a.s - b.s);
        for (const n of sorted) { const next = sorted.find(m => m.s > n.s + 1e-6); if (next) n.l = Math.max(0.0625, next.s - n.s); }
      })],
      ['Humanize', '', run('Humanize', ns => ns.forEach(n => { n.s = Math.max(0, n.s + (Math.random() - 0.5) * 0.04); n.v = Math.max(1, Math.min(127, Math.round(n.v + (Math.random() - 0.5) * 16))); }))],
      '-',
      ['Velocity +10', '', vel(10)], ['Velocity −10', '', vel(-10)],
      ['Fixed Velocity 100', '', run('Fixed velocity', ns => ns.forEach(n => { n.v = 100; }))],
      ['Velocity Ramp Up', '', run('Velocity ramp', ns => { const s = [...ns].sort((a, b) => a.s - b.s); s.forEach((n, i) => { n.v = Math.round(40 + (87 * i) / Math.max(1, s.length - 1)); }); })],
      '-',
      ['Double Speed', '', run('Double speed', ns => { const o = Math.min(...ns.map(n => n.s)); ns.forEach(n => { n.s = o + (n.s - o) / 2; n.l = Math.max(0.03125, n.l / 2); }); })],
      ['Half Speed', '', run('Half speed', ns => { const o = Math.min(...ns.map(n => n.s)); ns.forEach(n => { n.s = o + (n.s - o) * 2; n.l *= 2; }); })],
      ['Reverse Order', '', run('Reverse', ns => { const a = Math.min(...ns.map(n => n.s)), b = Math.max(...ns.map(n => n.s + n.l)); ns.forEach(n => { n.s = a + (b - (n.s + n.l) - a); }); })],
      '-',
      ['Transpose +12', '', run('Octave up', ns => ns.forEach(n => { n.p = Math.min(127, n.p + 12); }))],
      ['Transpose −12', '', run('Octave down', ns => ns.forEach(n => { n.p = Math.max(0, n.p - 12); }))],
    ];
  }

  deleteSelected() {
    const r = this.region; if (!r?.notes || !this.sel.size) return;
    this.cmd.store.checkpoint();
    r.notes = r.notes.filter(n => !this.sel.has(n)); this.sel.clear(); this.commit();
  }
  selectAll() { const r = this.region; if (!r?.notes) return; this.sel = new Set(r.notes); this.renderBar(); this.dirty = true; }
  quantize() {
    const r = this.region; if (!r?.notes?.length) return;
    const u = this.cmd.store.ui.prSnap || 0.25;
    const targets = this.sel.size ? [...this.sel] : r.notes;
    this.cmd.store.checkpoint();
    for (const n of targets) { n.s = Math.max(0, Math.round(n.s / u) * u); n.l = Math.max(u, Math.round(n.l / u) * u); }
    toast(`Quantized ${targets.length} note${targets.length === 1 ? '' : 's'} to ${SNAPS.find(s => s[0] === u)?.[1]}`);
    this.commit();
  }
  transpose(d: number) {
    if (!this.sel.size) return;
    this.cmd.store.checkpoint();
    for (const n of this.sel) n.p = Math.max(0, Math.min(127, n.p + d));
    const first = [...this.sel][0]; this.audition(first.p, first.v);
    this.commit();
  }
  nudge(d: number) {
    if (!this.sel.size) return;
    const u = this.cmd.store.ui.prSnap || 0.25;
    this.cmd.store.checkpoint();
    for (const n of this.sel) n.s = Math.max(0, n.s + d * u);
    this.commit();
  }

  // ---------- pointer ----------
  private setFocus() { const ui = this.cmd.store.ui; if (ui.focus !== 'editor') { ui.focus = 'editor'; this.cmd.store.emit('view'); } }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.setFocus();
    const r = this.region; if (!r) return;
    const { x, y, h: H } = this.local(e);
    this.scroller.setPointerCapture(e.pointerId);
    if (y < RH) { this.drag = { kind: 'scrub' }; this.cmd.locate(Math.max(0, this.snap(this.beatAtX(x)))); return; }
    if (y > H - VH) { this.drag = { kind: 'vel', started: false }; this.paintVel(x, y, H); return; }
    if (x < this.KW) { const p = this.pitchAtY(y); this.drag = { kind: 'key', p }; if (this.track) this.cmd.engine.noteOn(this.track.id, p, 100); return; }
    const hit = this.hitNote(x, y);
    const tool = e.metaKey || e.ctrlKey ? this.cmd.store.ui.cmdTool : this.cmd.store.ui.tool;
    if (hit && tool === 'eraser') { this.cmd.store.checkpoint(); r.notes = r.notes!.filter(n => n !== hit.n); this.sel.delete(hit.n); this.commit(); return; }
    if (hit) {
      if (e.shiftKey) { this.sel.has(hit.n) ? this.sel.delete(hit.n) : this.sel.add(hit.n); }
      else if (!this.sel.has(hit.n)) this.sel = new Set([hit.n]);
      this.audition(hit.n.p, hit.n.v);
      this.lastLen = hit.n.l;
      if (hit.edge) this.drag = { kind: 'resize', anchor: hit.n, orig: new Map([...this.sel].map(n => [n, n.l])), x0: e.clientX, started: false };
      else this.drag = { kind: 'move', anchor: hit.n, orig: new Map([...this.sel].map(n => [n, { s: n.s, p: n.p }])), x0: e.clientX, y0: e.clientY, copy: e.altKey, started: false, lastP: hit.n.p };
      this.renderBar(); this.dirty = true;
      return;
    }
    if (tool === 'pencil') { this.createAt(x, y, e.clientX); return; }
    if (e.pointerType === 'touch') { this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop }; return; }
    const base = e.shiftKey ? new Set(this.sel) : new Set<Note>();
    if (!e.shiftKey) this.sel.clear();
    this.drag = { kind: 'marquee', x0: x, y0: y, x, y, base };
    this.renderBar(); this.dirty = true;
  }

  private createAt(x: number, y: number, clientX: number) {
    const r = this.region; if (!r) return;
    const s = this.snapFloor(this.beatAtX(x)) - r.start;
    if (s < 0) { toast('Add notes inside the region, or move the region first'); return; }
    const p = this.pitchAtY(y);
    this.cmd.store.checkpoint();
    const n: Note = { p, s, l: this.lastLen || this.cmd.store.ui.prSnap || 0.25, v: this.cmd.store.ui.typingVel };
    r.notes = [...(r.notes ?? []), n];
    this.sel = new Set([n]);
    this.audition(p, n.v);
    this.drag = { kind: 'resize', anchor: n, orig: new Map([[n, n.l]]), x0: clientX, started: true };
    this.fitRegion(); this.cmd.store.emit('structure'); this.dirty = true;
  }

  private onDbl(e: MouseEvent) {
    const { x, y, h: H } = this.local(e);
    if (y < RH || y > H - VH || x < this.KW) return;
    const hit = this.hitNote(x, y);
    const r = this.region; if (!r) return;
    if (hit) { this.cmd.store.checkpoint(); r.notes = r.notes!.filter(n => n !== hit.n); this.sel.delete(hit.n); this.commit(); return; }
    this.createAt(x, y, e.clientX);
    this.drag = null; this.commit();
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    const { x, y, h: H } = this.local(e);
    if (!d) {
      let c = 'default';
      if (y > RH && y < H - VH && x > this.KW) { const hit = this.hitNote(x, y); if (hit?.edge) c = 'ew-resize'; else if (this.cmd.store.ui.tool === 'pencil') c = 'crosshair'; }
      this.scroller.style.cursor = c;
      return;
    }
    const r = this.region; if (!r) return;
    if (d.kind === 'pan') { this.scroller.scrollLeft = d.sl - (e.clientX - d.x); this.scroller.scrollTop = d.st - (e.clientY - d.y); return; }
    if (d.kind === 'scrub') { this.cmd.store.ui.playhead = Math.max(0, this.snap(this.beatAtX(x))); this.cmd.store.emit('transport'); return; }
    if (d.kind === 'vel') { this.paintVel(x, y, H); return; }
    if (d.kind === 'key') {
      const p = this.pitchAtY(y);
      if (p !== d.p && this.track) { this.cmd.engine.noteOff(this.track.id, d.p); this.cmd.engine.noteOn(this.track.id, p, 100); d.p = p; }
      return;
    }
    if (d.kind === 'move') {
      if (!d.started) {
        if (Math.abs(e.clientX - d.x0) < 3 && Math.abs(e.clientY - d.y0) < 3) return;
        this.touch(false); d.started = true;
        if (d.copy) {
          const copies = new Map<Note, { s: number; p: number }>();
          for (const [n, o] of d.orig) { const c = { ...n }; r.notes!.push(c); copies.set(c, o); if (n === d.anchor) d.anchor = c; }
          d.orig = copies; this.sel = new Set(copies.keys());
        }
      }
      const ao = d.orig.get(d.anchor)!;
      let ds = this.snap(ao.s + (e.clientX - d.x0) / this.ppb) - ao.s;
      const minS = Math.min(...[...d.orig.values()].map(o => o.s));
      if (minS + ds < 0) ds = -minS;
      let dp = -Math.round((e.clientY - d.y0) / this.row);
      const ps = [...d.orig.values()].map(o => o.p);
      dp = Math.max(-Math.min(...ps), Math.min(127 - Math.max(...ps), dp));
      for (const [n, o] of d.orig) { n.s = o.s + ds; n.p = o.p + dp; }
      if (d.anchor.p !== d.lastP) { d.lastP = d.anchor.p; this.audition(d.anchor.p, d.anchor.v); }
      this.dirty = true;
    } else if (d.kind === 'resize') {
      if (!d.started) { if (Math.abs(e.clientX - d.x0) < 2) return; this.touch(false); d.started = true; }
      const u = this.cmd.store.ui.prSnap;
      const ol = d.orig.get(d.anchor)!;
      const end = this.snap(d.anchor.s + ol + (e.clientX - d.x0) / this.ppb);
      const dl = end - (d.anchor.s + ol);
      for (const [n, l] of d.orig) n.l = Math.max(u || 0.05, l + dl);
      this.lastLen = d.anchor.l;
      this.dirty = true;
    } else if (d.kind === 'marquee') {
      d.x = x; d.y = y;
      const x0 = Math.min(d.x0, x), x1 = Math.max(d.x0, x), y0 = Math.min(d.y0, y), y1 = Math.max(d.y0, y);
      this.sel = new Set(d.base);
      for (const n of r.notes ?? []) { const q = this.noteRect(r, n); if (q.x < x1 && q.x + q.w > x0 && q.y < y1 && q.y + q.h > y0) this.sel.add(n); }
      this.renderBar(); this.dirty = true;
    }
  }

  private onUp() {
    const d = this.drag; this.drag = null;
    if (!d) return;
    if (d.kind === 'key' && this.track) this.cmd.engine.noteOff(this.track.id, d.p);
    if ((d.kind === 'move' || d.kind === 'resize' || d.kind === 'vel') && d.started) this.commit();
    if (d.kind === 'scrub' && this.cmd.engine.playing) this.cmd.locate(this.cmd.store.ui.playhead);
    this.renderBar(); this.dirty = true;
  }

  /** Velocity lane: drag across stems to draw velocities (selected notes only, if any are selected). */
  private paintVel(x: number, y: number, H: number) {
    const d = this.drag; const r = this.region;
    if (!r?.notes || !d || d.kind !== 'vel') return;
    const v = Math.max(1, Math.min(127, Math.round((1 - (y - (H - VH) - 6) / (VH - 12)) * 127)));
    let changed = false;
    for (const n of r.notes) {
      if (this.sel.size && !this.sel.has(n)) continue;
      const nx = this.noteRect(r, n).x;
      if (Math.abs(nx - x) <= 5) {
        if (!d.started) { this.cmd.store.checkpoint(); d.started = true; }
        n.v = v; changed = true;
      }
    }
    if (changed) { this.renderBar(); this.dirty = true; }
  }

  // ---------- drawing ----------
  private syncSize() {
    const { store } = this.cmd;
    const total = Math.max(store.songEndBeats() + 16 * store.beatsPerBar, 64 * store.beatsPerBar);
    this.spacer.style.width = `${this.KW + total * this.ppb}px`;
    this.spacer.style.height = `${RH + 128 * this.row + VH}px`;
  }

  frame(playhead: number) {
    if (this.el.hidden) return;
    if (!this.dirty && !this.cmd.store.ui.playing && !this.drag) return;
    this.dirty = false;
    this.syncSize();
    const c = this.canvas, dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = this.region, t = this.track;
    g.fillStyle = '#1a1b1e'; g.fillRect(0, 0, W, H);
    if (!r || !t) {
      g.fillStyle = '#9a9da5'; g.font = '13px Inter, sans-serif'; g.textAlign = 'center';
      g.fillText('Select a MIDI region and press P, or double-click one.', W / 2, H / 2); g.textAlign = 'left';
      return;
    }
    const KW = this.KW, sl = this.scroller.scrollLeft, st = this.scroller.scrollTop, ppb = this.ppb, ROW = this.row;
    const bpb = this.cmd.store.beatsPerBar;
    const top = RH, bottom = H - VH;
    // rows
    const p0 = Math.min(127, 127 - Math.floor(st / ROW) + 1), p1 = Math.max(0, 127 - Math.floor((st + bottom - top) / ROW) - 1);
    g.save(); g.beginPath(); g.rect(KW, top, W - KW, bottom - top); g.clip();
    for (let p = p0; p >= p1; p--) {
      const y = top + (127 - p) * ROW - st;
      g.fillStyle = BLACK.has(p % 12) ? '#1d1e22' : '#24252a'; g.fillRect(KW, y, W - KW, ROW);
      g.fillStyle = p % 12 === 0 ? '#34363d' : '#1a1b1e'; g.fillRect(KW, y + ROW - 1, W - KW, 1);
    }
    // grid
    const b0 = Math.floor(sl / ppb), b1 = Math.ceil((sl + W - KW) / ppb);
    const u = this.cmd.store.ui.prSnap;
    const sub = u && u * ppb >= 8 ? u : 1;
    for (let b = b0; b <= b1; b += sub) {
      const x = Math.round(KW + b * ppb - sl);
      const isBar = Math.abs(b % bpb) < 1e-6, isBeat = Math.abs(b % 1) < 1e-6;
      g.fillStyle = isBar ? '#3a3c43' : isBeat ? '#2a2c31' : '#212226';
      g.fillRect(x, top, 1, bottom - top);
    }
    // outside region dim
    const rx0 = KW + r.start * ppb - sl, rx1 = KW + (r.start + r.length) * ppb - sl;
    g.fillStyle = '#0000005a'; g.fillRect(KW, top, Math.max(0, rx0 - KW), bottom - top); g.fillRect(rx1, top, Math.max(0, W - rx1), bottom - top);
    g.fillStyle = t.color; g.fillRect(rx0, top, 1, bottom - top); g.fillRect(rx1, top, 1, bottom - top);
    // notes
    g.font = '600 10px Inter, sans-serif'; g.textBaseline = 'middle';
    for (const n of r.notes ?? []) {
      const q = this.noteRect(r, n);
      if (q.x > W || q.x + q.w < KW || q.y > bottom || q.y + q.h < top) continue;
      const sel = this.sel.has(n);
      const outside = n.s >= r.length || n.s < 0;
      g.globalAlpha = outside ? 0.35 : 0.55 + 0.45 * (n.v / 127);
      g.fillStyle = sel ? '#ffffff' : t.color;
      g.beginPath(); g.roundRect(q.x + 0.5, q.y + 1, Math.max(2, q.w - 1), q.h - 2, 2); g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = sel ? t.color : '#00000066'; g.lineWidth = 1; g.stroke();
      if (q.w > 34 && ROW >= 12) { g.fillStyle = '#111214'; g.fillText(this.isDrums ? (DRUM_NAMES[n.p] ?? noteName(n.p)) : noteName(n.p), q.x + 4, q.y + ROW / 2 + 0.5); }
    }
    // marquee
    const d = this.drag;
    if (d?.kind === 'marquee') { g.fillStyle = '#4c9aff22'; g.strokeStyle = '#4c9aff'; g.fillRect(Math.min(d.x0, d.x), Math.min(d.y0, d.y), Math.abs(d.x - d.x0), Math.abs(d.y - d.y0)); g.strokeRect(Math.min(d.x0, d.x) + 0.5, Math.min(d.y0, d.y) + 0.5, Math.abs(d.x - d.x0), Math.abs(d.y - d.y0)); }
    g.restore();

    // keys column
    g.save(); g.beginPath(); g.rect(0, top, KW, bottom - top); g.clip();
    const held = this.drag?.kind === 'key' ? this.drag.p : -1;
    g.font = '10px Inter, sans-serif'; g.textBaseline = 'middle';
    for (let p = p0; p >= p1; p--) {
      const y = top + (127 - p) * ROW - st, blk = BLACK.has(p % 12);
      g.fillStyle = p === held ? '#4c9aff' : blk ? '#2a2b2f' : '#d9dadf'; g.fillRect(0, y, KW - 1, ROW);
      g.fillStyle = '#0f1012'; g.fillRect(0, y + ROW - 1, KW, 1);
      const label = this.isDrums ? DRUM_NAMES[p] : p % 12 === 0 ? noteName(p) : '';
      if (label && ROW >= 10) { g.fillStyle = blk ? '#d9dadf' : '#1a1b1e'; g.textAlign = 'right'; g.fillText(label, KW - 5, y + ROW / 2); g.textAlign = 'left'; }
    }
    g.restore();

    // ruler
    g.fillStyle = '#25262a'; g.fillRect(0, 0, W, RH);
    g.fillStyle = '#0f1012'; g.fillRect(0, RH - 1, W, 1);
    g.fillStyle = t.color + '55'; g.fillRect(Math.max(KW, rx0), 0, Math.max(0, Math.min(W, rx1) - Math.max(KW, rx0)), 4);
    g.font = '11px "JetBrains Mono", monospace'; g.textBaseline = 'top';
    let step = 1; while (ppb * bpb * step < 40) step *= 2;
    for (let b = Math.floor(b0 / bpb) * bpb; b <= b1; b += bpb) {
      if (b < 0) continue;
      const x = Math.round(KW + b * ppb - sl) + 0.5; if (x < KW) continue;
      const bar = b / bpb;
      if (bar % step) continue;
      g.fillStyle = '#5a5d65'; g.fillRect(x, 8, 1, RH - 8);
      g.fillStyle = '#c4c6cc'; g.fillText(String(bar + 1), x + 4, 8);
    }
    g.fillStyle = '#1f2023'; g.fillRect(0, 0, KW, RH);

    // velocity lane
    g.fillStyle = '#17181b'; g.fillRect(0, bottom, W, VH);
    g.fillStyle = '#0f1012'; g.fillRect(0, bottom, W, 1);
    g.fillStyle = '#9a9da5'; g.font = '10px Inter, sans-serif'; g.textBaseline = 'top'; g.fillText('Velocity', 6, bottom + 6);
    g.save(); g.beginPath(); g.rect(KW, bottom, W - KW, VH); g.clip();
    for (const n of r.notes ?? []) {
      const x = this.noteRect(r, n).x; if (x < KW - 4 || x > W) continue;
      const hh = (n.v / 127) * (VH - 12);
      const sel = this.sel.has(n);
      g.fillStyle = sel ? '#ffffff' : t.color;
      g.fillRect(x, bottom + VH - 6 - hh, 2, hh);
      g.beginPath(); g.arc(x + 1, bottom + VH - 6 - hh, 3, 0, Math.PI * 2); g.fill();
    }
    g.restore();

    // playhead
    const px = KW + playhead * ppb - sl;
    if (px >= KW && px <= W) { g.fillStyle = this.cmd.store.ui.recording ? '#ff4d4f' : '#ffffff'; g.fillRect(Math.round(px), 0, 1, H); }
    if (this.cmd.store.ui.playing && (px > W - 20 || px < KW)) { this.scroller.scrollLeft = Math.max(0, playhead * ppb - 40); }
  }
}
