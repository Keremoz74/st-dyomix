// Session Player editor: style, XY pad (Simple/Complex × Soft/Loud), fills, swing, chords.
import { Region } from '../model';
import { Commands } from '../commands';
import { STYLES, SessionState, generate } from '../session';
import { h, icon } from './dom';

const CHORD_PRESETS = ['Am F C G', 'C G Am F', 'Dm7 G7 Cmaj7 Cmaj7', 'Em C G D', 'F G Em Am'];

export class SessionEditor {
  el: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private badge: HTMLElement;
  private pad!: HTMLCanvasElement;
  private preview!: HTMLCanvasElement;
  private shownSig = '';

  constructor(private cmd: Commands) {
    this.title = h('span', { class: 'lm-title' });
    this.badge = h('span', { class: 'pr-badge se-badge' });
    this.body = h('div', { class: 'se-body' });
    this.el = h('section', { class: 'editor', 'aria-label': 'Session Player', hidden: true },
      h('div', { class: 'lm-bar' }, this.badge, this.title, h('span', { class: 'grow' }),
        h('button', { class: 'tool-btn', title: 'Generate a different variation with the same settings', onClick: () => this.change(s => (s.seed = (s.seed % 9973) + 1)) }, '↻ Variation'),
        h('button', { class: 'tool-btn', title: 'Convert to a plain MIDI region and open the Piano Roll', onClick: () => { const r = this.region; if (r) cmd.sessionToMidi(r); } }, 'Edit as MIDI'),
        h('button', { class: 'tool-btn', 'aria-label': 'Close', title: 'Close', onClick: cmd.toggleEditor }, '×')),
      this.body);
    cmd.store.on(k => { if (k === 'structure' || k === 'view') this.sync(); });
  }

  get region(): Region | undefined {
    const { ui } = this.cmd.store;
    const r = ui.editorRegionId ? this.cmd.store.region(ui.editorRegionId) : undefined;
    return r?.session ? r : undefined;
  }

  private sync() {
    const r = this.region, ui = this.cmd.store.ui;
    this.el.hidden = !(ui.showEditor && r);
    if (!r) return;
    const s = r.session!;
    this.title.textContent = `${r.name}  ·  ${this.cmd.store.track(r.trackId)?.name ?? ''}`;
    this.badge.replaceChildren(icon(s.type === 'drums' ? 'drum' : 'keys', 14), s.type === 'drums' ? 'Drummer' : s.type === 'bass' ? 'Session Bass' : 'Session Keys');
    // rebuild the controls only when their layout changes (not while a slider or the pad is being dragged)
    const sig = JSON.stringify([r.id, s.type, s.style, s.halfTime, s.chords]);
    if (sig !== this.shownSig) { this.shownSig = sig; this.render(r, s); }
    this.drawPad(s); this.drawPreview(r);
  }

  /** Applies a settings change as one undo step and regenerates the part. */
  private change(fn: (s: SessionState) => void, checkpoint = true) {
    const r = this.region; if (!r?.session) return;
    if (checkpoint) this.cmd.store.checkpoint();
    fn(r.session);
    generate(this.cmd.store, r);
    this.cmd.store.emit('structure');
  }

  private render(r: Region, s: SessionState) {
    const chip = (label: string, on: boolean, f: () => void) => h('button', { class: 'se-chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onClick: f }, label);
    const slider = (label: string, value: number, set: (v: number) => void) => {
      const inp = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(value * 100)), 'aria-label': label }) as HTMLInputElement;
      inp.addEventListener('pointerdown', () => this.cmd.store.checkpoint());
      inp.addEventListener('keydown', e => { e.stopPropagation(); this.cmd.store.checkpoint(); });
      inp.addEventListener('input', () => this.change(() => set(parseInt(inp.value) / 100), false));
      return h('label', { class: 'se-slider' }, h('span', {}, label), inp);
    };
    this.pad = h('canvas', { class: 'se-pad', role: 'slider', tabindex: '0', 'aria-label': 'Complexity (left to right) and loudness (bottom to top)' });
    this.preview = h('canvas', { class: 'se-preview', 'aria-hidden': 'true' });
    const setFromPad = (e: PointerEvent, cp: boolean) => {
      const rc = this.pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rc.left) / rc.width)), y = Math.max(0, Math.min(1, 1 - (e.clientY - rc.top) / rc.height));
      this.change(st => { st.complexity = Math.round(x * 100) / 100; st.intensity = Math.round(y * 100) / 100; }, cp);
    };
    this.pad.addEventListener('pointerdown', e => {
      e.preventDefault(); this.pad.setPointerCapture(e.pointerId); setFromPad(e, true);
      const mv = (ev: PointerEvent) => setFromPad(ev, false);
      const up = () => { this.pad.removeEventListener('pointermove', mv); this.pad.removeEventListener('pointerup', up); };
      this.pad.addEventListener('pointermove', mv); this.pad.addEventListener('pointerup', up);
    });
    this.pad.addEventListener('keydown', e => {
      const dx = e.key === 'ArrowRight' ? 0.05 : e.key === 'ArrowLeft' ? -0.05 : 0, dy = e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowDown' ? -0.05 : 0;
      if (!dx && !dy) return; e.preventDefault(); e.stopPropagation();
      this.change(st => { st.complexity = Math.max(0, Math.min(1, st.complexity + dx)); st.intensity = Math.max(0, Math.min(1, st.intensity + dy)); });
    });

    const left = h('div', { class: 'se-col' },
      h('div', { class: 'se-label' }, 'Style'),
      h('div', { class: 'se-chips' }, STYLES[s.type].map(st => chip(st, s.style === st, () => this.change(x => (x.style = st))))),
      s.type === 'drums'
        ? h('div', { class: 'se-row' }, slider('Fills', s.fills, v => this.region!.session!.fills = v), slider('Swing', s.swing, v => this.region!.session!.swing = v),
            h('label', { class: 'se-check' }, (() => { const c = h('input', { type: 'checkbox', checked: s.halfTime }) as HTMLInputElement; c.addEventListener('change', () => this.change(x => (x.halfTime = c.checked))); return c; })(), 'Half-time'))
        : h('div', { class: 'se-row' }, slider('Swing', s.swing, v => this.region!.session!.swing = v)),
      s.type !== 'drums' ? h('div', { class: 'se-label' }, 'Chords (one per bar, repeats)') : null,
      s.type !== 'drums' ? (() => {
        const inp = h('input', { class: 'se-chords', value: s.chords, 'aria-label': 'Chord progression', placeholder: 'Am F C G' }) as HTMLInputElement;
        inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
        inp.addEventListener('change', () => this.change(x => (x.chords = inp.value.trim() || 'Am F C G')));
        return h('div', { class: 'se-row' }, inp, ...CHORD_PRESETS.map(c => chip(c, s.chords === c, () => this.change(x => (x.chords = c)))));
      })() : null);
    const right = h('div', { class: 'se-col se-padcol' },
      h('div', { class: 'se-padwrap' }, h('span', { class: 'se-ax se-ax-t' }, 'Loud'), h('span', { class: 'se-ax se-ax-b' }, 'Soft'), h('span', { class: 'se-ax se-ax-l' }, 'Simple'), h('span', { class: 'se-ax se-ax-r' }, 'Complex'), this.pad),
      this.preview);
    this.body.replaceChildren(left, right);
  }

  private fit(c: HTMLCanvasElement) {
    const dpr = devicePixelRatio || 1, w = c.clientWidth, hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w, h: hh };
  }

  private drawPad(s: SessionState) {
    if (!this.pad?.isConnected) return;
    const { g, w, h: H } = this.fit(this.pad);
    g.fillStyle = '#17181b'; g.fillRect(0, 0, w, H);
    g.strokeStyle = '#2a2c31'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo((w * i) / 4, 0); g.lineTo((w * i) / 4, H); g.stroke(); g.beginPath(); g.moveTo(0, (H * i) / 4); g.lineTo(w, (H * i) / 4); g.stroke(); }
    const x = s.complexity * w, y = (1 - s.intensity) * H;
    g.fillStyle = '#e8c54733'; g.beginPath(); g.arc(x, y, 18, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e8c547'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    this.pad.setAttribute('aria-valuetext', `Complexity ${Math.round(s.complexity * 100)}%, loudness ${Math.round(s.intensity * 100)}%`);
  }

  private drawPreview(r: Region) {
    if (!this.preview?.isConnected) return;
    const { g, w, h: H } = this.fit(this.preview);
    g.fillStyle = '#17181b'; g.fillRect(0, 0, w, H);
    const bpb = this.cmd.store.beatsPerBar, span = Math.min(r.length, 4 * bpb);
    const notes = (r.notes ?? []).filter(n => n.s < span);
    if (!notes.length) return;
    let lo = 127, hi = 0; for (const n of notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    const rows = Math.max(8, hi - lo + 1), rh = (H - 8) / rows;
    for (let b = 0; b <= span; b++) { g.fillStyle = b % bpb ? '#23252a' : '#34363d'; g.fillRect(Math.round((b / span) * w), 0, 1, H); }
    const col = this.cmd.store.track(r.trackId)?.color ?? '#e8c547';
    for (const n of notes) {
      g.globalAlpha = 0.35 + 0.65 * (n.v / 127); g.fillStyle = col;
      g.fillRect((n.s / span) * w, 4 + (hi - n.p) * rh, Math.max(2, (n.l / span) * w - 1), Math.max(2, rh - 1));
    }
    g.globalAlpha = 1;
  }
}
