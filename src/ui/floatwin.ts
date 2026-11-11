// Small floating windows (Groups & VCA, Memory Locations, Tuner, Strip Silence…), styled like plug-in windows.
import { h } from './dom';

export class FloatWin {
  el: HTMLDivElement | null = null;
  private body = h('div', { class: 'fw-body' });
  private pos: { x: number; y: number } | null = null;
  onClose: () => void = () => {};
  constructor(private title: string, private width = 380) {}

  get isOpen() { return !!this.el; }

  open(content: HTMLElement | HTMLElement[]) {
    this.body.replaceChildren(...(Array.isArray(content) ? content : [content]));
    if (this.el) return;
    const head = h('div', { class: 'pw-head' }, h('span', { class: 'pw-title' }, this.title), h('span', { class: 'grow' }),
      h('button', { class: 'pw-btn', 'aria-label': `Close ${this.title}`, onClick: () => this.close() }, '✕'));
    const win = h('div', { class: 'plugin-win float-win', role: 'dialog', 'aria-label': this.title, style: { width: `${this.width}px` } }, head, this.body);
    document.body.appendChild(win);
    this.el = win;
    if (this.pos && innerWidth > 700) { win.style.left = `${this.pos.x}px`; win.style.top = `${this.pos.y}px`; }
    head.addEventListener('pointerdown', e => {
      if ((e.target as HTMLElement).closest('button') || innerWidth <= 700) return;
      const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.pos = { x: Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)), y: Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) };
        win.style.left = `${this.pos.x}px`; win.style.top = `${this.pos.y}px`;
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
    });
  }

  close() { if (!this.el) return; this.el.remove(); this.el = null; this.onClose(); }
}

/** A labelled row: label on the left, control(s) on the right. */
export const fwRow = (label: string, ...ctl: (HTMLElement | string | null)[]) => h('div', { class: 'fw-row' }, h('span', { class: 'fw-label' }, label), ...ctl);
export function fwNumber(value: number, min: number, max: number, step: number, onChange: (v: number) => void, aria: string) {
  const i = h('input', { type: 'number', class: 'fw-num', value: String(value), min: String(min), max: String(max), step: String(step), 'aria-label': aria, inputmode: 'decimal' }) as HTMLInputElement;
  i.addEventListener('keydown', e => e.stopPropagation());
  i.addEventListener('change', () => { const v = parseFloat(i.value); if (isFinite(v)) onChange(Math.max(min, Math.min(max, v))); });
  return i;
}
