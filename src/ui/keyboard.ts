// Musical Typing (⌘K): play the selected software instrument from the computer keyboard or by touch.
import { Commands } from '../commands';
import { noteName } from '../audio/instruments';
import { h, toast } from './dom';

// Logic's layout: A row = white keys, Q row = black keys.
const KEYMAP: Record<string, number> = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
const LABEL = Object.fromEntries(Object.entries(KEYMAP).map(([k, v]) => [v, k.toUpperCase()]));
const SPAN = 24; // semitones shown on screen

export class MusicalTyping {
  el: HTMLElement;
  private keysEl: HTMLElement;
  private octEl: HTMLElement;
  private velEl: HTMLElement;
  private targetEl: HTMLElement;
  private down = new Map<string, { trackId: string; pitch: number }>(); // key or pointer id -> note
  private warned = false;

  constructor(private cmd: Commands) {
    this.octEl = h('span', { class: 'mt-val' });
    this.velEl = h('span', { class: 'mt-val' });
    this.targetEl = h('span', { class: 'mt-target' });
    this.keysEl = h('div', { class: 'mt-keys', 'aria-label': 'On-screen keyboard' });
    const btn = (label: string, aria: string, f: () => void) => h('button', { class: 'tool-btn', 'aria-label': aria, onClick: f }, label);
    this.el = h('section', { class: 'mtyping', 'aria-label': 'Musical Typing', hidden: true },
      h('div', { class: 'mt-bar' },
        h('span', { class: 'lm-title' }, 'Musical Typing'), this.targetEl, h('span', { class: 'grow' }),
        h('span', { class: 'lm-label' }, 'Octave'), btn('−', 'Octave down (Z)', () => this.octave(-1)), this.octEl, btn('+', 'Octave up (X)', () => this.octave(1)),
        h('span', { class: 'lm-label' }, 'Velocity'), btn('−', 'Velocity down (C)', () => this.vel(-10)), this.velEl, btn('+', 'Velocity up (V)', () => this.vel(10)),
        btn('×', 'Close Musical Typing', cmd.toggleKeyboard)),
      this.keysEl);
    cmd.store.on(k => { if (k === 'view' || k === 'structure') this.render(); });
    this.render();
  }

  private get base() { return (this.cmd.store.ui.octave + 2) * 12; }

  private target() { return this.cmd.liveTarget(); }

  render() {
    const ui = this.cmd.store.ui;
    this.el.hidden = !ui.showKeyboard;
    if (!ui.showKeyboard) return;
    this.octEl.textContent = `C${ui.octave}`;
    this.velEl.textContent = String(ui.typingVel);
    const t = this.target();
    this.targetEl.textContent = t ? `→ ${t.name}` : 'Select a software instrument track';
    const whites: HTMLElement[] = [], blacks: HTMLElement[] = [];
    let wi = 0;
    for (let i = 0; i <= SPAN; i++) {
      const p = this.base + i, black = [1, 3, 6, 8, 10].includes(p % 12);
      const key = h('div', { class: `mt-key ${black ? 'black' : 'white'}`, 'data-p': String(p) },
        h('span', { class: 'mt-letter' }, LABEL[i] ?? ''), !black && p % 12 === 0 ? h('span', { class: 'mt-name' }, noteName(p)) : null);
      if (black) { key.style.left = `calc(${(wi / 15) * 100}% - 1.6%)`; blacks.push(key); }
      else { whites.push(key); wi++; }
      key.addEventListener('pointerdown', e => { e.preventDefault(); key.setPointerCapture(e.pointerId); this.on(`ptr${e.pointerId}`, p); });
      key.addEventListener('pointerup', e => this.off(`ptr${e.pointerId}`));
      key.addEventListener('pointercancel', e => this.off(`ptr${e.pointerId}`));
    }
    this.keysEl.replaceChildren(...whites, ...blacks);
    this.paintDown();
  }

  private paintDown() {
    const on = new Set([...this.down.values()].map(d => d.pitch));
    this.keysEl.querySelectorAll<HTMLElement>('.mt-key').forEach(k => k.classList.toggle('down', on.has(Number(k.dataset.p))));
  }

  private on(id: string, pitch: number) {
    const t = this.target();
    if (!t) { if (!this.warned) { toast('Add or select a Software Instrument track to play'); this.warned = true; } return; }
    if (this.down.has(id)) return;
    this.down.set(id, { trackId: t.id, pitch });
    this.cmd.engine.noteOn(t.id, pitch, this.cmd.store.ui.typingVel);
    this.paintDown();
  }
  private off(id: string) {
    const d = this.down.get(id); if (!d) return;
    this.down.delete(id);
    this.cmd.engine.noteOff(d.trackId, d.pitch);
    this.paintDown();
  }
  private octave(d: number) { const ui = this.cmd.store.ui; ui.octave = Math.max(-1, Math.min(8, ui.octave + d)); this.render(); }
  private vel(d: number) { const ui = this.cmd.store.ui; ui.typingVel = Math.max(1, Math.min(127, ui.typingVel + d)); this.render(); }

  /** Returns true if the key was consumed. */
  keyDown(e: KeyboardEvent): boolean {
    if (!this.cmd.store.ui.showKeyboard || e.metaKey || e.ctrlKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (k in KEYMAP) { if (!e.repeat) this.on(`key${k}`, this.base + KEYMAP[k]); return true; }
    if (k === 'z') { this.octave(-1); return true; }
    if (k === 'x') { this.octave(1); return true; }
    if (k === 'c') { this.vel(-10); return true; }
    if (k === 'v') { this.vel(10); return true; }
    return false;
  }
  keyUp(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k in KEYMAP) this.off(`key${k}`);
  }
  allOff() { for (const id of [...this.down.keys()]) this.off(id); }
}
