// Step Sequencer editor (Logic-style): rows of sounds/pitches × steps, Note / Velocity / Gate edit modes,
// per-row mute, solo, length and gate, pattern presets, swing, and a running step indicator.
import { Region } from '../model';
import { isDrumKit } from '../audio/instruments';
import { Commands } from '../commands';
import { DRUM_NAMES } from '../audio/instruments';
import {
  PatternState, PatternRow, RATES, STEP_COUNTS, MAX_STEPS, DRUM_PRESETS, MELODIC_PRESETS,
  applyPreset, generatePattern, rowName, patternBeats,
} from '../pattern';
import { h, icon, openMenu, MenuItem, toast } from './dom';

type Mode = 'note' | 'velocity' | 'gate';

export class StepSequencer {
  el: HTMLElement;
  private bar: HTMLElement;
  private body: HTMLElement;
  private cells: HTMLElement[][] = [];
  private lit: HTMLElement[] = [];
  private mode: Mode = 'note';
  private lastVel = 100;
  private drag: { val: number; touched: Set<string>; y0: number; v0: number } | null = null;
  private shownSig = '';

  constructor(private cmd: Commands) {
    this.bar = h('div', { class: 'lm-bar ss-bar' });
    this.body = h('div', { class: 'ss-body' });
    this.el = h('section', { class: 'editor ss', 'aria-label': 'Step Sequencer', hidden: true }, this.bar, this.body);
    this.body.addEventListener('pointerdown', e => this.onDown(e));
    this.body.addEventListener('pointermove', e => this.onMove(e));
    this.body.addEventListener('pointerup', () => this.onUp());
    this.body.addEventListener('pointercancel', () => this.onUp());
    this.body.addEventListener('contextmenu', e => e.preventDefault());
    cmd.store.on(k => { if (k === 'structure' || k === 'view') this.sync(); });
  }

  get region(): Region | undefined {
    const { ui } = this.cmd.store;
    const r = ui.editorRegionId ? this.cmd.store.region(ui.editorRegionId) : undefined;
    return r?.pattern ? r : undefined;
  }
  get visible() { return !this.el.hidden; }
  private get drums() { const r = this.region; return !!r && isDrumKit(this.cmd.store.track(r.trackId)?.instrument); }

  private sync() {
    const r = this.region, ui = this.cmd.store.ui;
    this.el.hidden = !(ui.showEditor && r);
    this.el.classList.toggle('focused', ui.focus === 'editor');
    if (!r || this.drag) return;
    const sig = JSON.stringify([r.id, r.name, r.pattern, this.mode, this.cmd.store.track(r.trackId)?.name, this.cmd.store.track(r.trackId)?.instrument?.type]);
    if (sig === this.shownSig) return;
    this.shownSig = sig;
    this.renderBar(r);
    this.renderGrid(r);
  }

  /** Applies a pattern change as one undo step. */
  private change(fn: (p: PatternState, r: Region) => void, checkpoint = true) {
    const r = this.region; if (!r?.pattern) return;
    if (checkpoint) this.cmd.store.checkpoint();
    fn(r.pattern, r);
    generatePattern(r);
    this.cmd.store.emit('structure');
    this.cmd.engine.resync();
  }

  // ---------------- header ----------------
  private renderBar(r: Region) {
    const pat = r.pattern!, drums = this.drums;
    const seg = (m: Mode, label: string, title: string) => h('button', { class: 'ss-seg' + (this.mode === m ? ' on' : ''), 'aria-pressed': String(this.mode === m), title, onClick: () => { this.mode = m; this.shownSig = ''; this.sync(); } }, label);
    const menuBtn = (label: string, title: string, items: () => MenuItem[]) => { const b: HTMLButtonElement = h('button', { class: 'sel-btn', title, 'aria-haspopup': 'menu', onClick: () => openMenu(b, items()) }, label, icon('chevron', 12)); return b; };
    const rateName = RATES.find(x => x[0] === pat.rate)?.[1] ?? '1/16';
    const swing = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(pat.swing * 100)), 'aria-label': 'Swing', title: 'Swing (straight rates only)', disabled: pat.rate % 3 === 0 || undefined }) as HTMLInputElement;
    swing.addEventListener('pointerdown', () => this.cmd.store.checkpoint());
    swing.addEventListener('keydown', e => { e.stopPropagation(); this.cmd.store.checkpoint(); });
    swing.addEventListener('input', () => { const v = parseInt(swing.value) / 100; this.change(p => (p.swing = v), false); });
    const presets = drums ? DRUM_PRESETS : MELODIC_PRESETS;
    this.bar.replaceChildren(
      h('span', { class: 'pr-badge ss-badge' }, icon(drums ? 'drum' : 'keys', 14), 'Step Sequencer'),
      h('span', { class: 'lm-title' }, `${r.name}  ·  ${this.cmd.store.track(r.trackId)?.name ?? ''}`),
      h('span', { class: 'grow' }),
      h('div', { class: 'ss-segs', role: 'group', 'aria-label': 'Edit mode' }, seg('note', 'Note', 'Click or drag to switch steps on/off'), seg('velocity', 'Velocity', 'Drag up/down on steps to set velocity'), seg('gate', 'Gate', 'Drag up/down to set a row’s note length')),
      menuBtn(`${pat.steps} Steps`, 'Pattern length', () => STEP_COUNTS.map(n => [`${n} steps`, '', () => this.change(p => { p.steps = n; for (const row of p.rows) if (row.len && row.len > n) row.len = undefined; this.fitRegion(); }), pat.steps === n] as MenuItem)),
      menuBtn(rateName, 'Step rate', () => RATES.map(([v, n]) => [n, '', () => this.change(p => { p.rate = v; this.fitRegion(); }), pat.rate === v] as MenuItem)),
      h('label', { class: 'ss-swing' }, 'Swing', swing),
      menuBtn('Patterns', 'Load a built-in pattern', () => presets.map(n => [n, '', () => this.change(p => applyPreset(p, n, drums))] as MenuItem)),
      h('button', { class: 'tool-btn', title: 'Randomize the pattern', onClick: () => this.change(p => this.randomize(p, drums)) }, '⚄ Random'),
      h('button', { class: 'tool-btn', title: 'Clear all steps', onClick: () => this.change(p => { for (const row of p.rows) row.cells.fill(0); }) }, 'Clear'),
      h('button', { class: 'tool-btn', title: 'Convert to a plain MIDI region and open the Piano Roll', onClick: () => { const rr = this.region; if (rr) this.cmd.patternToMidi(rr); } }, 'Edit as MIDI'),
      h('button', { class: 'tool-btn', 'aria-label': 'Close', title: 'Close', onClick: this.cmd.toggleEditor }, '×'));
  }

  /** When the pattern gets longer than the region, lengthen the region to one full pass. */
  private fitRegion() {
    const r = this.region; if (!r?.pattern) return;
    const len = patternBeats(r.pattern), bpb = this.cmd.store.beatsPerBar;
    if (r.length < len) r.length = Math.ceil(len / bpb) * bpb;
  }

  private randomize(p: PatternState, drums: boolean) {
    const dens: Record<number, number> = { 36: 0.28, 38: 0.18, 39: 0.1, 42: 0.6, 46: 0.08, 49: 0.03, 51: 0.15 };
    p.rows.forEach((row, ri) => {
      for (let i = 0; i < MAX_STEPS; i++) {
        const strong = i % p.rate === 0;
        const d = drums ? (dens[row.p] ?? 0.06) * (strong ? 1.6 : 0.8) : (0.22 / Math.max(1, p.rows.length / 6)) * (strong ? 1.5 : 0.9) * (ri === p.rows.length - 1 ? 1.6 : 1);
        row.cells[i] = i < p.steps && Math.random() < d ? Math.round(64 + Math.random() * 60 + (strong ? 6 : 0)) : 0;
      }
    });
    if (drums) { const kick = p.rows.find(x => x.p === 36); if (kick) kick.cells[0] = 115; }
  }

  // ---------------- grid ----------------
  private renderGrid(r: Region) {
    const pat = r.pattern!, drums = this.drums;
    const scroll = { x: this.body.scrollLeft, y: this.body.scrollTop };
    this.cells = []; this.lit = [];
    const ruler = h('div', { class: 'ss-row ss-ruler' }, h('div', { class: 'ss-head' }, h('span', { class: 'ss-hint' }, this.mode === 'note' ? 'Click steps to toggle' : this.mode === 'velocity' ? 'Drag steps up/down' : 'Drag a row up/down')));
    for (let i = 0; i < pat.steps; i++) ruler.appendChild(h('div', { class: 'ss-num' + (i % pat.rate === 0 ? ' beat' : '') }, i % pat.rate === 0 ? String(i / pat.rate + 1) : '·'));
    const rows = pat.rows.map((row, ri) => {
      const L = Math.min(pat.steps, row.len ?? pat.steps);
      const nameBtn: HTMLButtonElement = h('button', { class: 'ss-name', title: 'Row options', 'aria-haspopup': 'menu', onClick: () => openMenu(nameBtn, this.rowMenu(ri, nameBtn)) }, rowName(row.p, drums), row.len ? h('span', { class: 'ss-len' }, `${row.len}`) : null);
      const tog = (k: 'mute' | 'solo', label: string) => h('button', { class: `ss-ms ${k}` + (row[k] ? ' on' : ''), 'aria-pressed': String(!!row[k]), title: k === 'mute' ? 'Mute row' : 'Solo row', onClick: () => this.change(p => { p.rows[ri][k] = !p.rows[ri][k]; }) }, label);
      const cells: HTMLElement[] = [];
      const el = h('div', { class: 'ss-row' + (row.mute ? ' muted' : '') }, h('div', { class: 'ss-head' }, nameBtn, tog('mute', 'M'), tog('solo', 'S')));
      for (let i = 0; i < pat.steps; i++) {
        const v = row.cells[i] ?? 0;
        const c = h('div', { class: 'ss-cell' + (v > 0 ? ' on' : '') + (Math.floor(i / pat.rate) % 2 ? ' alt' : '') + (i >= L ? ' out' : ''), 'data-r': String(ri), 'data-i': String(i), role: 'switch', 'aria-checked': String(v > 0), 'aria-label': `${rowName(row.p, drums)} step ${i + 1}` });
        c.appendChild(h('div', { class: 'ss-v' }));
        this.paintCell(c, v, row);
        cells.push(c); el.appendChild(c);
      }
      this.cells.push(cells);
      return el;
    });
    const add: HTMLButtonElement = h('button', { class: 'tool-btn ss-add', title: 'Add a row', onClick: () => openMenu(add, this.addMenu()) }, '+ Row');
    this.body.replaceChildren(h('div', { class: 'ss-grid', style: { '--steps': String(pat.steps) } }, ruler, ...rows, h('div', { class: 'ss-row ss-foot' }, h('div', { class: 'ss-head' }, add))));
    this.body.scrollLeft = scroll.x; this.body.scrollTop = scroll.y;
  }

  private paintCell(c: HTMLElement, v: number, row: PatternRow) {
    c.classList.toggle('on', v > 0); c.setAttribute('aria-checked', String(v > 0));
    const bar = c.firstElementChild as HTMLElement;
    if (this.mode === 'gate') { bar.style.height = v > 0 ? `${Math.round(row.gate * 100)}%` : '0'; c.title = v > 0 ? `Gate ${Math.round(row.gate * 100)}%` : ''; }
    else { bar.style.height = v > 0 ? `${Math.round((v / 127) * 100)}%` : '0'; c.title = v > 0 ? `Velocity ${v}` : ''; }
  }

  private rowMenu(ri: number, anchor: HTMLElement): MenuItem[] {
    const r = this.region!, pat = r.pattern!, row = pat.rows[ri], drums = this.drums;
    const L = Math.min(pat.steps, row.len ?? pat.steps);
    const rot = (d: number) => this.change(p => { const rr = p.rows[ri]; const seg = rr.cells.slice(0, L); const out = seg.map((_, i) => seg[(i - d + L) % L]); rr.cells.splice(0, L, ...out); });
    const fill = (k: number) => this.change(p => { const rr = p.rows[ri]; for (let i = 0; i < L; i++) rr.cells[i] = i % k === 0 ? (rr.cells[i] || this.lastVel) : 0; });
    const pitch = (d: number) => this.change(p => { const rr = p.rows[ri]; rr.p = Math.max(0, Math.min(127, rr.p + d)); });
    const sub = (items: MenuItem[]) => () => setTimeout(() => openMenu(anchor, items), 0);
    return [
      ...(drums
        ? [['Sound…', '', sub(Object.entries(DRUM_NAMES).map(([p, n]) => [n, '', () => this.change(q => { q.rows[ri].p = +p; }), row.p === +p] as MenuItem))] as MenuItem]
        : [['Pitch Up', '', () => pitch(1)] as MenuItem, ['Pitch Down', '', () => pitch(-1)] as MenuItem, ['Octave Up', '', () => pitch(12)] as MenuItem, ['Octave Down', '', () => pitch(-12)] as MenuItem]),
      '-',
      ['Row Length…', '', sub([['Same as Pattern', '', () => this.change(p => { p.rows[ri].len = undefined; }), !row.len] as MenuItem, ...[3, 4, 5, 6, 7, 8, 10, 12, 16, 24, 32].filter(n => n < pat.steps).map(n => [`${n} steps`, '', () => this.change(p => { p.rows[ri].len = n; }), row.len === n] as MenuItem)])],
      ['Gate…', '', sub([0.1, 0.25, 0.5, 0.75, 1].map(g => [`${Math.round(g * 100)}%`, '', () => this.change(p => { p.rows[ri].gate = g; }), Math.abs(row.gate - g) < 0.01] as MenuItem))],
      '-',
      ['Fill Every Step', '', () => fill(1)], ['Fill Every 2 Steps', '', () => fill(2)], ['Fill Every 4 Steps', '', () => fill(4)],
      ['Shift Left', '', () => rot(-1)], ['Shift Right', '', () => rot(1)],
      ['Randomize Row', '', () => this.change(p => { const rr = p.rows[ri]; for (let i = 0; i < MAX_STEPS; i++) rr.cells[i] = i < L && Math.random() < 0.3 ? Math.round(70 + Math.random() * 50) : 0; })],
      ['Clear Row', '', () => this.change(p => { p.rows[ri].cells.fill(0); })],
      '-',
      ['Delete Row', '', () => { if (pat.rows.length <= 1) { toast('A pattern needs at least one row'); return; } this.change(p => { p.rows.splice(ri, 1); }); }],
    ];
  }

  private addMenu(): MenuItem[] {
    const pat = this.region!.pattern!, drums = this.drums;
    const add = (p: number, top: boolean) => this.change(q => { const row = { p, cells: new Array(MAX_STEPS).fill(0), gate: drums ? 0.5 : 0.8 }; if (top) q.rows.unshift(row); else q.rows.push(row); });
    if (drums) {
      const used = new Set(pat.rows.map(x => x.p));
      const free = Object.entries(DRUM_NAMES).filter(([p]) => !used.has(+p));
      return free.length ? free.map(([p, n]) => [n, '', () => add(+p, false)] as MenuItem) : [['All drum sounds are in use', '', () => {}]];
    }
    const hi = Math.max(...pat.rows.map(x => x.p)), lo = Math.min(...pat.rows.map(x => x.p));
    return [[`Above (${rowName(Math.min(127, hi + 1), false)})`, '', () => add(Math.min(127, hi + 1), true)], [`Below (${rowName(Math.max(0, lo - 1), false)})`, '', () => add(Math.max(0, lo - 1), false)]];
  }

  // ---------------- editing ----------------
  private cellAt(x: number, y: number) {
    const el = (document.elementFromPoint(x, y) as Element | null)?.closest('.ss-cell') as HTMLElement | null;
    if (!el || !this.body.contains(el)) return null;
    return { el, ri: +el.dataset.r!, i: +el.dataset.i! };
  }

  private onDown(e: PointerEvent) {
    const ui = this.cmd.store.ui;
    if (ui.focus !== 'editor') { ui.focus = 'editor'; this.el.classList.add('focused'); }
    const c = this.cellAt(e.clientX, e.clientY); const r = this.region;
    if (!c || !r?.pattern || e.button > 0) return;
    e.preventDefault();
    this.body.setPointerCapture(e.pointerId);
    this.cmd.store.checkpoint();
    const row = r.pattern.rows[c.ri], cur = row.cells[c.i] ?? 0;
    if (this.mode === 'note') {
      const val = cur > 0 ? 0 : (e.shiftKey ? 127 : this.lastVel);
      this.drag = { val, touched: new Set(), y0: e.clientY, v0: 0 };
    } else if (this.mode === 'velocity') {
      this.drag = { val: 0, touched: new Set(), y0: e.clientY, v0: cur > 0 ? cur : this.lastVel };
    } else {
      this.drag = { val: 0, touched: new Set(), y0: e.clientY, v0: row.gate };
    }
    this.apply(c);
  }

  private onMove(e: PointerEvent) {
    if (!this.drag) return;
    const r = this.region; if (!r?.pattern) return;
    if (this.mode === 'note') { const c = this.cellAt(e.clientX, e.clientY); if (c) this.apply(c); return; }
    const dy = this.drag.y0 - e.clientY;
    if (this.mode === 'velocity') {
      const v = Math.max(1, Math.min(127, Math.round(this.drag.v0 + dy * 1.2)));
      const c = this.cellAt(e.clientX, e.clientY); if (c) this.drag.touched.add(`${c.ri}:${c.i}`);
      for (const k of this.drag.touched) { const [ri, i] = k.split(':').map(Number); r.pattern.rows[ri].cells[i] = v; this.paintCell(this.cells[ri][i], v, r.pattern.rows[ri]); }
      this.lastVel = v;
    } else {
      const g = Math.max(0.05, Math.min(1, Math.round((this.drag.v0 + dy / 120) * 20) / 20));
      for (const k of this.drag.touched) { const ri = +k.split(':')[0]; const row = r.pattern.rows[ri]; row.gate = g; row.cells.forEach((v, i) => this.cells[ri][i] && this.paintCell(this.cells[ri][i], v, row)); }
    }
  }

  private apply(c: { el: HTMLElement; ri: number; i: number }) {
    const d = this.drag!, r = this.region!, row = r.pattern!.rows[c.ri], key = `${c.ri}:${c.i}`;
    if (this.mode === 'gate') { d.touched.add(`${c.ri}:0`); return; }
    if (d.touched.has(key)) return;
    d.touched.add(key);
    if (this.mode === 'note') {
      row.cells[c.i] = d.val;
      this.paintCell(c.el, d.val, row);
      if (d.val > 0) this.cmd.engine.audition(r.trackId, row.p, d.val, 0.2);
    } else {
      row.cells[c.i] = d.v0; this.paintCell(c.el, d.v0, row);
    }
  }

  private onUp() {
    if (!this.drag) return;
    this.drag = null;
    const r = this.region; if (!r) return;
    generatePattern(r);
    this.cmd.store.emit('structure');
    this.cmd.engine.resync();
  }

  // ---------------- playback indicator ----------------
  frame(beat: number) {
    if (this.el.hidden) return;
    const r = this.region; if (!r?.pattern) return;
    for (const c of this.lit) c.classList.remove('now');
    this.lit = [];
    const rel = beat - r.start;
    if (rel < 0 || rel >= r.length || !this.cmd.store.ui.playing) return;
    const pat = r.pattern, idx = Math.floor(rel * pat.rate + 1e-6);
    pat.rows.forEach((row, ri) => {
      const L = Math.min(pat.steps, row.len ?? pat.steps);
      const c = this.cells[ri]?.[idx % L];
      if (c) { c.classList.add('now'); this.lit.push(c); }
    });
  }
}
