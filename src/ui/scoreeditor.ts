// Score editor: standard notation for a MIDI region (grand staff, or a percussion staff for drum kits),
// with a duration palette for inserting notes, drag to change pitch/time, and a key signature.
import { Note, Region } from '../model';
import { isDrumKit } from '../audio/instruments';
import { Commands } from '../commands';
import { spell, stepToMidi, keyAlters, KEY_NAMES, DRUM_POS, drumAtPos, layoutBars, beamGroups, Piece } from '../notation';
import { h, openMenu, toast, MenuItem } from './dom';

const S = 8; // staff space in px
const INK = '#1d1d1f', SEL = '#2f6fdc', PAPER = '#f5f2ea', FAINT = '#9a958a';
const GLYPH_FONT = `'DAW Music', 'Noto Music', 'Bravura', 'Apple Symbols', 'Segoe UI Symbol', 'Noto Sans Symbols 2', serif`;
const TREBLE_BOTTOM = 30, BASS_BOTTOM = 18; // diatonic steps of E4 and G2

interface BarBox { abs: number; x: number; w: number; sys: number; top: number; staffTops: number[] }
interface Head { key: string; x: number; y: number; note: Note; pieceKey: string }

export function midiTabs(cmd: Commands) {
  const ui = cmd.store.ui;
  const tab = (v: 'roll' | 'score', label: string, key: string) =>
    h('button', { class: 'ed-tab' + (ui.midiView === v ? ' on' : ''), 'aria-pressed': String(ui.midiView === v), title: `${label} (${key})`, onClick: () => { ui.midiView = v; cmd.store.emit('view'); } }, label);
  return h('span', { class: 'ed-tabs' }, tab('roll', 'Piano Roll', 'P'), tab('score', 'Score', 'N'));
}

export class ScoreEditor {
  el: HTMLElement;
  private host: HTMLElement;
  private cursor: HTMLElement;
  private bar: HTMLElement;
  private title: HTMLElement;
  private keyBtn!: HTMLButtonElement;
  private bars: BarBox[] = [];
  private heads: Head[] = [];
  private sysH = 0;
  sel = new Set<Note>();
  private dur = 4; // palette value in 16ths
  private dotted = false;
  private insert = true;
  private drag: { anchor: Note; orig: Map<Note, { s: number; p: number }>; x0: number; y0: number; started: boolean; px16: number } | null = null;
  private dirty = true;
  private lastW = 0;
  private renderSig = '';

  constructor(private cmd: Commands) {
    this.title = h('span', { class: 'lm-title' });
    this.bar = h('div', { class: 'lm-bar sc-bar' });
    this.cursor = h('div', { class: 'sc-cursor', 'aria-hidden': 'true' });
    this.host = h('div', { class: 'sc-host', tabindex: '0', 'aria-label': 'Score. Click the staff to add a note with the selected length.' });
    this.el = h('section', { class: 'editor', 'aria-label': 'Score', hidden: true }, this.bar, h('div', { class: 'sc-wrap' }, this.host));
    this.host.appendChild(this.cursor);
    this.host.addEventListener('pointerdown', e => this.onDown(e));
    this.host.addEventListener('pointermove', e => this.onMove(e));
    this.host.addEventListener('pointerup', () => this.onUp());
    new ResizeObserver(() => { if (this.host.clientWidth !== this.lastW) this.dirty = true; }).observe(this.host);
    cmd.store.on(k => { if (k === 'structure' || k === 'view') { this.sync(); this.dirty = true; } });
    document.fonts?.ready.then(() => { this.dirty = true; });
  }

  get region(): Region | undefined {
    const { ui } = this.cmd.store;
    const r = ui.editorRegionId ? this.cmd.store.region(ui.editorRegionId) : undefined;
    return r?.kind === 'midi' && !r.session && !r.pattern ? r : undefined;
  }
  get visible() { return !this.el.hidden; }
  private get isDrums() { const r = this.region; return !!r && isDrumKit(this.cmd.store.track(r.trackId)?.instrument); }
  private get key() { return this.isDrums ? 0 : this.cmd.store.project.key ?? 0; }
  private get value() { return this.dotted ? Math.min(16, Math.round(this.dur * 1.5)) : this.dur; }

  private sync() {
    const { ui } = this.cmd.store;
    const r = this.region;
    this.el.hidden = !(ui.showEditor && r && ui.midiView === 'score');
    this.el.classList.toggle('focused', ui.focus === 'editor');
    if (!r) { this.sel.clear(); return; }
    const live = new Set(r.notes ?? []); for (const n of [...this.sel]) if (!live.has(n)) this.sel.delete(n);
    this.renderBar(r);
  }

  private renderBar(r: Region) {
    const pal = (v: number, label: string, title: string) => h('button', { class: 'sc-pal' + (this.dur === v ? ' on' : ''), 'aria-pressed': String(this.dur === v), title, onClick: () => { this.dur = v; this.sync(); } }, label);
    this.title.textContent = `${r.name}  ·  ${this.cmd.store.track(r.trackId)?.name ?? ''}`;
    this.keyBtn = h('button', { class: 'sel-btn', title: 'Key signature', disabled: this.isDrums || undefined, onClick: () => openMenu(this.keyBtn, Object.entries(KEY_NAMES).sort((a, b) => +a[0] - +b[0]).map(([k, n]) => [n, '', () => { this.cmd.store.checkpoint(); this.cmd.store.project.key = +k; this.cmd.store.emit('structure'); }, (this.cmd.store.project.key ?? 0) === +k] as MenuItem)) }, this.isDrums ? 'Percussion' : `Key: ${KEY_NAMES[this.key].split(' / ')[0]}`);
    this.bar.replaceChildren(
      midiTabs(this.cmd), this.title, h('span', { class: 'grow' }),
      h('span', { class: 'lm-label' }, 'Insert'),
      h('button', { class: 'tool-btn' + (this.insert ? ' on' : ''), 'aria-pressed': String(this.insert), title: 'Click the staff to add notes', onClick: () => { this.insert = !this.insert; this.sync(); } }, '✎'),
      pal(16, '1', 'Whole note'), pal(8, '½', 'Half note'), pal(4, '¼', 'Quarter note'), pal(2, '⅛', 'Eighth note'), pal(1, '1/16', 'Sixteenth note'),
      h('button', { class: 'sc-pal' + (this.dotted ? ' on' : ''), 'aria-pressed': String(this.dotted), title: 'Dotted', onClick: () => { this.dotted = !this.dotted; this.sync(); } }, '•'),
      h('span', { class: 'lm-div' }), this.keyBtn,
      h('button', { class: 'tool-btn', 'aria-label': 'Close', title: 'Close', onClick: this.cmd.toggleEditor }, '×'));
  }

  // ---------------- editing ----------------
  private commit() { this.cmd.store.emit('structure'); this.cmd.engine.resync(); this.dirty = true; }
  private audition(p: number, v = 100) { const r = this.region; if (r) this.cmd.engine.audition(r.trackId, p, v); }
  deleteSelected() {
    const r = this.region; if (!r?.notes || !this.sel.size) return;
    this.cmd.store.checkpoint(); r.notes = r.notes.filter(n => !this.sel.has(n)); this.sel.clear(); this.commit();
  }
  selectAll() { const r = this.region; if (r?.notes) { this.sel = new Set(r.notes); this.dirty = true; } }
  transpose(d: number) {
    if (!this.sel.size) return;
    this.cmd.store.checkpoint(); for (const n of this.sel) n.p = Math.max(0, Math.min(127, n.p + d));
    this.audition([...this.sel][0].p); this.commit();
  }

  private boxAt(x: number, y: number) {
    return this.bars.find(b => x >= b.x && x < b.x + b.w && y >= b.top && y < b.top + this.sysH) ?? null;
  }
  private local(e: { clientX: number; clientY: number }) { const r = this.host.getBoundingClientRect(); return { x: e.clientX - r.left + this.host.scrollLeft, y: e.clientY - r.top + this.host.scrollTop }; }

  private lastTap: { note: Note; t: number } | null = null;
  private onDown(e: PointerEvent) {
    const ui = this.cmd.store.ui;
    if (ui.focus !== 'editor') { ui.focus = 'editor'; this.cmd.store.emit('view'); }
    const r = this.region; if (!r || e.button !== 0) return;
    const { x, y } = this.local(e);
    const k = (e.target as Element).closest('[data-h]')?.getAttribute('data-h');
    const hd = this.heads.find(q => q.key === k);
    if (hd) {
      const now = performance.now(), dbl = this.lastTap && this.lastTap.note === hd.note && now - this.lastTap.t < 350;
      this.lastTap = { note: hd.note, t: now };
      if (dbl && !e.shiftKey) { this.lastTap = null; this.sel = new Set([hd.note]); this.deleteSelected(); return; }
      if (e.shiftKey) { this.sel.has(hd.note) ? this.sel.delete(hd.note) : this.sel.add(hd.note); }
      else if (!this.sel.has(hd.note)) this.sel = new Set([hd.note]);
      this.audition(hd.note.p, hd.note.v);
      const box = this.bars[0];
      const px16 = box ? (box.w - 26) / (this.cmd.store.beatsPerBar * 4) : 10;
      this.host.setPointerCapture(e.pointerId);
      this.drag = { anchor: hd.note, orig: new Map([...this.sel].map(n => [n, { s: n.s, p: n.p }])), x0: e.clientX, y0: e.clientY, started: false, px16 };
      this.dirty = true;
      return;
    }
    const box = this.boxAt(x, y);
    if (!box || !this.insert) { if (this.sel.size) { this.sel.clear(); this.dirty = true; } return; }
    // insert a note: time from x (snapped to the chosen value), pitch from the nearest staff line/space
    const bpb = this.cmd.store.beatsPerBar, barLen = bpb * 4;
    const grid = Math.min(this.value, 4);
    let t16 = Math.floor(((x - box.x - 18) / (box.w - 26)) * barLen / grid) * grid;
    t16 = Math.max(0, Math.min(barLen - 1, t16));
    let staff = 0; let best = Infinity;
    box.staffTops.forEach((top, i) => { const d = Math.abs(y - (top + 2 * S)); if (d < best) { best = d; staff = i; } });
    const top = box.staffTops[staff];
    const pos = Math.round((top + 4 * S - y) / (S / 2));
    const pitch = this.isDrums ? drumAtPos(pos) : stepToMidi((staff === 0 ? TREBLE_BOTTOM : BASS_BOTTOM) + pos, this.key);
    const s = box.abs * bpb + t16 / 4 - r.start;
    if (s < 0) { toast('Add notes inside the region'); return; }
    this.cmd.store.checkpoint();
    const n: Note = { p: pitch, s, l: this.value / 4, v: this.cmd.store.ui.typingVel };
    r.notes = [...(r.notes ?? []), n];
    const bpbN = this.cmd.store.beatsPerBar;
    if (n.s + n.l > r.length) r.length = Math.ceil((n.s + n.l) / bpbN) * bpbN;
    this.sel = new Set([n]);
    this.audition(pitch);
    this.commit();
  }

  private onMove(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    if (!d.started) { if (Math.abs(e.clientX - d.x0) < 4 && Math.abs(e.clientY - d.y0) < 4) return; this.cmd.store.checkpoint(); d.started = true; }
    const r = this.region!;
    const grid = Math.min(this.value, 4);
    const dt = Math.round((e.clientX - d.x0) / d.px16 / grid) * grid / 4;
    const dsteps = -Math.round((e.clientY - d.y0) / (S / 2));
    const minS = Math.min(...[...d.orig.values()].map(o => o.s));
    const shift = Math.max(-minS, dt);
    let lastP = d.anchor.p;
    for (const [n, o] of d.orig) {
      n.s = o.s + shift;
      if (this.isDrums) { const pos = (DRUM_POS[o.p]?.pos ?? 5) + dsteps; n.p = drumAtPos(pos); }
      else n.p = Math.max(0, Math.min(127, stepToMidi(spell(o.p, this.key).step + dsteps, this.key) + (o.p - stepToMidi(spell(o.p, this.key).step, this.key))));
    }
    if (d.anchor.p !== lastP) { lastP = d.anchor.p; }
    const end = Math.max(...r.notes!.map(n => n.s + n.l)), bpb = this.cmd.store.beatsPerBar;
    if (end > r.length) r.length = Math.ceil(end / bpb) * bpb;
    this.dirty = true;
  }
  private onUp() {
    const d = this.drag; this.drag = null;
    if (d?.started) { this.audition(d.anchor.p, d.anchor.v); this.commit(); }
  }

  // ---------------- drawing ----------------
  frame(playhead: number) {
    if (this.el.hidden) return;
    const r = this.region; if (!r) return;
    const sig = JSON.stringify([r.id, r.start, r.length, r.notes?.length, this.key, this.host.clientWidth]);
    if (this.dirty || sig !== this.renderSig) { this.render(r); this.renderSig = sig; this.dirty = false; }
    // playback cursor
    const bpb = this.cmd.store.beatsPerBar, abs = Math.floor(playhead / bpb);
    const box = this.bars.find(b => b.abs === abs);
    if (!box) { this.cursor.style.display = 'none'; return; }
    const t = (playhead - abs * bpb) / bpb;
    this.cursor.style.display = 'block';
    this.cursor.style.left = `${box.x + 18 + t * (box.w - 26)}px`;
    this.cursor.style.top = `${box.top}px`; this.cursor.style.height = `${this.sysH}px`;
    if (this.cmd.store.ui.playing) {
      const top = box.top, vh = this.host.clientHeight;
      if (top < this.host.scrollTop || top + this.sysH > this.host.scrollTop + vh) this.host.scrollTop = Math.max(0, top - 10);
    }
  }

  private render(r: Region) {
    const store = this.cmd.store, bpb = store.beatsPerBar, barLen = bpb * 4;
    const drums = this.isDrums, key = this.key, ka = keyAlters(key);
    const W = Math.max(280, this.host.clientWidth - 4); this.lastW = this.host.clientWidth;
    const firstBar = Math.floor(r.start / bpb + 1e-6), lastBar = Math.ceil((r.start + r.length) / bpb - 1e-6);
    const nBars = Math.max(1, lastBar - firstBar);
    const notes = (r.notes ?? []).filter(n => n.s >= 0 && n.s < r.length);
    const start16 = (n: Note) => Math.round((r.start + n.s) * 4), len16 = (n: Note) => Math.max(1, Math.round(n.l * 4));
    const staves: Note[][] = drums ? [notes] : [notes.filter(n => n.p >= 60), notes.filter(n => n.p < 60)];
    const laid = staves.map(ns => layoutBars(ns, start16, len16, firstBar, nBars, barLen));

    const nStaff = staves.length, padT = 6 * S, gap = 8 * S, padB = 6 * S;
    this.sysH = padT + nStaff * 4 * S + (nStaff - 1) * gap + padB;
    const keyW = Math.abs(key) * 7, tsX = 46 + keyW + 8, left = tsX + 14;
    const perSys = Math.max(1, Math.floor((W - left - 10) / (barLen > 16 ? 240 : 210)));
    const sysCount = Math.ceil(nBars / perSys);
    const bw = (W - left - 10) / perSys;
    const out: string[] = [];
    const heads: Head[] = [];
    this.bars = [];
    const ties: { from: { x: number; y: number; sys: number }; key: string; sys: number; up: boolean }[] = [];
    const headPos = new Map<string, { x: number; y: number; sys: number }>();

    for (let sy = 0; sy < sysCount; sy++) {
      const top = 10 + sy * (this.sysH + 10);
      const staffTops = Array.from({ length: nStaff }, (_, i) => top + padT + i * (4 * S + gap));
      const barsHere = Math.min(perSys, nBars - sy * perSys);
      const xEnd = left + barsHere * bw;
      // staves, clefs, key signature, time signature
      staffTops.forEach((st, i) => {
        for (let l = 0; l < 5; l++) out.push(`<line x1="12" x2="${xEnd}" y1="${st + l * S}" y2="${st + l * S}" stroke="${INK}" stroke-width="1"/>`);
        const clef = drums ? '𝄥' : i === 0 ? '𝄞' : '𝄢';
        const cy = drums ? st + 2 * S : i === 0 ? st + 3 * S : st + S;
        out.push(`<text x="16" y="${cy + (drums ? 0 : i === 0 ? 0.5 * S : 0.5 * S)}" font-family="${GLYPH_FONT}" font-size="${i === 0 && !drums ? 4.4 * S : 3.2 * S}" fill="${INK}" dominant-baseline="${i === 0 && !drums ? 'alphabetic' : 'middle'}">${clef}</text>`);
        if (!drums) {
          const order = key > 0 ? [3, 0, 4, 1, 5, 2, 6] : [6, 2, 5, 1, 4, 0, 3];
          for (let k = 0; k < Math.abs(key); k++) {
            const L = order[k];
            // classic key-signature heights (treble), shifted down a 6th for the bass staff
            const trebleSteps = key > 0 ? [38, 35, 39, 36, 33, 37, 34] : [34, 37, 33, 36, 32, 35, 31];
            const pos = trebleSteps[k] - TREBLE_BOTTOM - (i === 1 ? 2 : 0);
            void L;
            out.push(`<text x="${46 + k * 7}" y="${st + 4 * S - pos * S / 2}" font-family="${GLYPH_FONT}" font-size="${2.4 * S}" fill="${INK}" dominant-baseline="middle" text-anchor="middle">${key > 0 ? '♯' : '♭'}</text>`);
          }
        }
        if (sy === 0) {
          out.push(`<text x="${tsX}" y="${st + 1.05 * S}" font-family="Georgia, serif" font-weight="700" font-size="${2.3 * S}" fill="${INK}" text-anchor="middle" dominant-baseline="middle">${bpb}</text>`);
          out.push(`<text x="${tsX}" y="${st + 3.05 * S}" font-family="Georgia, serif" font-weight="700" font-size="${2.3 * S}" fill="${INK}" text-anchor="middle" dominant-baseline="middle">4</text>`);
        }
      });
      if (nStaff > 1) out.push(`<line x1="12" x2="12" y1="${staffTops[0]}" y2="${staffTops[nStaff - 1] + 4 * S}" stroke="${INK}" stroke-width="1.5"/>`);

      for (let bi = 0; bi < barsHere; bi++) {
        const barIdx = sy * perSys + bi, abs = firstBar + barIdx;
        const bx = left + bi * bw;
        this.bars.push({ abs, x: bx, w: bw, sys: sy, top, staffTops });
        out.push(`<text x="${bx + 2}" y="${top + padT - 2.2 * S}" font-family="Inter, sans-serif" font-size="10" fill="${FAINT}">${abs + 1}</text>`);
        const isLast = barIdx === nBars - 1;
        out.push(`<line x1="${bx + bw}" x2="${bx + bw}" y1="${staffTops[0]}" y2="${staffTops[nStaff - 1] + 4 * S}" stroke="${INK}" stroke-width="${isLast ? 1 : 1}"/>`);
        if (isLast) out.push(`<rect x="${bx + bw - 1}" y="${staffTops[0]}" width="4" height="${staffTops[nStaff - 1] + 4 * S - staffTops[0]}" fill="${INK}"/>`);
        const xOf = (t: number) => bx + 18 + (t / barLen) * (bw - 26);

        laid.forEach((bars, si) => {
          const pieces = bars[barIdx] ?? [];
          const st = staffTops[si];
          const yOfPos = (pos: number) => st + 4 * S - pos * S / 2;
          const posOf = (p: number) => drums ? (DRUM_POS[p]?.pos ?? 5) : spell(p, key).step - (si === 0 ? TREBLE_BOTTOM : BASS_BOTTOM);
          const accState = new Map<string, number>();
          const groups = beamGroups(pieces);
          const inGroup = new Map<number, number[]>(); groups.forEach(g => g.forEach(i => inGroup.set(i, g)));
          const stemUp = (ps: number[]) => drums ? true : (ps.reduce((a, b) => a + b, 0) / ps.length) < 4;
          const stemInfo = new Map<number, { x: number; yTip: number; up: boolean }>();

          pieces.forEach((pc, pi) => {
            const x = xOf(pc.t);
            if (pc.rest) { out.push(this.rest(pc.d, x, st)); return; }
            const poses = pc.pitches.map(posOf);
            const group = inGroup.get(pi);
            const up = stemUp(group ? group.flatMap(i => pieces[i].pitches.map(posOf)) : poses);
            const filled = pc.d < 8;
            // ledger lines
            const lo = Math.min(...poses), hi = Math.max(...poses);
            for (let lp = -2; lp >= lo; lp -= 2) out.push(`<line x1="${x - 7}" x2="${x + 7}" y1="${yOfPos(lp)}" y2="${yOfPos(lp)}" stroke="${INK}" stroke-width="1"/>`);
            for (let lp = 10; lp <= hi; lp += 2) out.push(`<line x1="${x - 7}" x2="${x + 7}" y1="${yOfPos(lp)}" y2="${yOfPos(lp)}" stroke="${INK}" stroke-width="1"/>`);
            const sorted = pc.pitches.map((p, i) => ({ p, pos: poses[i] })).sort((a, b) => a.pos - b.pos);
            sorted.forEach((q, i) => {
              const second = i > 0 && q.pos - sorted[i - 1].pos === 1;
              const hx = x + (second ? (up ? 1 : -1) * 1.15 * S : 0), hy = yOfPos(q.pos);
              const note = pc.notes.find(n => n.p === q.p)!;
              const selected = this.sel.has(note);
              const col = selected ? SEL : INK;
              // accidental
              if (!drums && !pc.cont) {
                const sp = spell(q.p, key), k2 = `${sp.letter}:${sp.oct}`;
                const cur = accState.has(k2) ? accState.get(k2)! : ka[sp.letter];
                if (sp.acc !== cur) { out.push(`<text x="${x - 1.6 * S}" y="${hy}" font-family="${GLYPH_FONT}" font-size="${2.2 * S}" fill="${col}" dominant-baseline="middle" text-anchor="middle">${sp.acc > 0 ? '♯' : sp.acc < 0 ? '♭' : '♮'}</text>`); }
                accState.set(k2, sp.acc);
              }
              const hk = `${si}:${barIdx}:${pi}:${q.p}`;
              const xHead = drums && DRUM_POS[q.p]?.x;
              if (xHead) out.push(`<g data-h="${hk}" class="sc-head"><rect x="${hx - 6}" y="${hy - 5}" width="12" height="10" fill="transparent"/><path d="M${hx - 4} ${hy - 4}L${hx + 4} ${hy + 4}M${hx - 4} ${hy + 4}L${hx + 4} ${hy - 4}" stroke="${col}" stroke-width="1.6"/></g>`);
              else out.push(`<ellipse data-h="${hk}" class="sc-head" cx="${hx}" cy="${hy}" rx="${0.62 * S}" ry="${0.44 * S}" transform="rotate(-20 ${hx} ${hy})" fill="${filled ? col : PAPER}" stroke="${col}" stroke-width="${filled ? 0.5 : 1.4}"/>`);
              heads.push({ key: hk, x: hx, y: hy, note, pieceKey: `${si}:${barIdx}:${pi}` });
              if ([12, 6, 3].includes(pc.d)) out.push(`<circle cx="${hx + 1.2 * S}" cy="${hy - (q.pos % 2 === 0 ? S / 2 : 0)}" r="1.6" fill="${col}"/>`);
              const tk = `${si}:${q.p}`;
              if (pc.cont) { const from = headPos.get(tk); if (from) ties.push({ from, key: `${hx},${hy}`, sys: sy, up: !up }); }
              headPos.set(tk, { x: hx, y: hy, sys: sy });
            });
            if (pc.d < 16) {
              const yLo = yOfPos(lo), yHi = yOfPos(hi);
              const sx = up ? x + 0.58 * S : x - 0.58 * S;
              const yTip = up ? yHi - 3.5 * S : yLo + 3.5 * S;
              stemInfo.set(pi, { x: sx, yTip, up });
              if (!group) {
                out.push(`<line x1="${sx}" x2="${sx}" y1="${up ? yLo : yHi}" y2="${yTip}" stroke="${INK}" stroke-width="1.2"/>`);
                const flags = pc.d <= 1 ? 2 : pc.d <= 3 ? 1 : 0;
                for (let f = 0; f < flags; f++) {
                  const fy = yTip + (up ? f * 0.9 * S : -f * 0.9 * S);
                  out.push(`<path d="M${sx} ${fy} q ${0.9 * S} ${up ? 0.8 * S : -0.8 * S} ${0.7 * S} ${up ? 2.2 * S : -2.2 * S}" fill="none" stroke="${INK}" stroke-width="1.4"/>`);
                }
              } else {
                // beamed: stems drawn to the beam line below
                stemInfo.get(pi)!.yTip = yTip;
                (stemInfo.get(pi) as any).yBase = up ? yLo : yHi;
              }
            }
          });
          // beams
          for (const g of groups) {
            const sts = g.map(i => stemInfo.get(i)!).filter(Boolean); if (sts.length < 2) continue;
            const up = sts[0].up;
            const tipY = up ? Math.min(...sts.map(s2 => s2.yTip)) : Math.max(...sts.map(s2 => s2.yTip));
            for (const s2 of sts) out.push(`<line x1="${s2.x}" x2="${s2.x}" y1="${(s2 as any).yBase}" y2="${tipY}" stroke="${INK}" stroke-width="1.2"/>`);
            const x1 = sts[0].x, x2 = sts[sts.length - 1].x, th = 0.5 * S;
            out.push(`<rect x="${x1}" y="${up ? tipY : tipY - th}" width="${x2 - x1 + 1}" height="${th}" fill="${INK}"/>`);
            // secondary beams for 16ths
            g.forEach((pi2, k) => {
              if (pieces[pi2].d !== 1) return;
              const s2 = stemInfo.get(pi2)!; const yy = up ? tipY + 0.85 * S : tipY - 0.85 * S - th;
              const nextIs16 = k < g.length - 1 && pieces[g[k + 1]].d === 1;
              const prevIs16 = k > 0 && pieces[g[k - 1]].d === 1;
              if (nextIs16) { const s3 = stemInfo.get(g[k + 1])!; out.push(`<rect x="${s2.x}" y="${yy}" width="${s3.x - s2.x + 1}" height="${th}" fill="${INK}"/>`); }
              else if (!prevIs16) { const dir = k === g.length - 1 ? -1 : 1; out.push(`<rect x="${dir > 0 ? s2.x : s2.x - 0.9 * S}" y="${yy}" width="${0.9 * S}" height="${th}" fill="${INK}"/>`); }
            });
          }
        });
      }
    }
    // ties
    for (const t of ties) {
      const [tx, ty] = t.key.split(',').map(Number);
      const fx = t.from.sys === t.sys ? t.from.x : tx - 18;
      const dy = t.up ? -0.9 * S : 0.9 * S, yb = t.from.y + (t.up ? -0.5 * S : 0.5 * S);
      out.push(`<path d="M${fx + 0.6 * S} ${yb} Q ${(fx + tx) / 2} ${yb + dy} ${tx - 0.6 * S} ${ty + (t.up ? -0.5 * S : 0.5 * S)}" fill="none" stroke="${INK}" stroke-width="1.2"/>`);
    }
    this.heads = heads;
    const H = 10 + sysCount * (this.sysH + 10);
    const svg = `<svg class="sc-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Score of ${r.name.replace(/[<&"]/g, '')}"><rect width="${W}" height="${H}" fill="${PAPER}"/>${out.join('')}</svg>`;
    const old = this.host.querySelector('svg');
    const tmp = document.createElement('div'); tmp.innerHTML = svg;
    if (old) old.replaceWith(tmp.firstChild!); else this.host.insertBefore(tmp.firstChild!, this.cursor);
  }

  private rest(d: number, x: number, st: number) {
    const mid = st + 2 * S;
    const c = INK;
    switch (d) {
      case 16: return `<rect x="${x - 5}" y="${st + S}" width="10" height="${0.5 * S}" fill="${c}"/>`;
      case 12: return `<rect x="${x - 5}" y="${mid - 0.5 * S}" width="10" height="${0.5 * S}" fill="${c}"/><circle cx="${x + 9}" cy="${mid - 0.6 * S}" r="1.6" fill="${c}"/>`;
      case 8: return `<rect x="${x - 5}" y="${mid - 0.5 * S}" width="10" height="${0.5 * S}" fill="${c}"/>`;
      case 6: case 4: return `<path d="M${x - 1} ${mid - 1.6 * S} l ${0.7 * S} ${0.9 * S} l -${0.7 * S} ${0.7 * S} l ${0.8 * S} ${0.9 * S} q -${S} -${0.3 * S} -${0.4 * S} ${0.9 * S}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>${d === 6 ? `<circle cx="${x + 9}" cy="${mid - 0.5 * S}" r="1.6" fill="${c}"/>` : ''}`;
      case 3: case 2: return `<circle cx="${x - 2}" cy="${mid - 0.5 * S}" r="2.2" fill="${c}"/><path d="M${x - 2} ${mid - 0.4 * S} q ${0.5 * S} 0.2 ${0.9 * S} -${0.4 * S} L ${x - 0.5} ${mid + 1.4 * S}" fill="none" stroke="${c}" stroke-width="1.4"/>${d === 3 ? `<circle cx="${x + 9}" cy="${mid - 0.5 * S}" r="1.6" fill="${c}"/>` : ''}`;
      default: return `<circle cx="${x - 2}" cy="${mid - 0.5 * S}" r="2" fill="${c}"/><circle cx="${x - 3}" cy="${mid + 0.5 * S}" r="2" fill="${c}"/><path d="M${x - 2} ${mid - 0.4 * S} q ${0.5 * S} 0.2 ${0.9 * S} -${0.4 * S} L ${x - 1.5} ${mid + 1.9 * S}" fill="none" stroke="${c}" stroke-width="1.4"/>`;
    }
  }
}
