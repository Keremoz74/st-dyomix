// Tiny DOM helpers + icon set.

type Attrs = Record<string, any>;
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

const P: Record<string, string> = {
  inspector: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 11v6M12 7h.01',
  mixer: 'M6 4v16M12 4v16M18 4v16M4 14h4M10 8h4M16 16h4',
  rewind: 'M11 6v12L3 12zM21 6v12l-8-6z',
  tostart: 'M5 6h2.5v12H5zM18.5 6v12L9 12z',
  tuner: 'M9 3v7a3 3 0 0 0 6 0V3M12 13v8M9.5 21h5',
  forward: 'M3 6v12l8-6zM13 6v12l8-6z',
  stop: 'M6 6h12v12H6z',
  play: 'M7 5v14l12-7z',
  record: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  cycle: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  metronome: 'M9 3h6l4 18H5zM12 15l5-8M7 15h10',
  import: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  bounce: 'M12 21V9M7 14l5-5 5 5M4 5h16',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M6 9l6 6 6-6',
  pointer: 'M5 3l14 8-6 2-3 6z',
  eraser: 'M8 20h12M5 14l8-8 6 6-6 6H9z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
  join: 'M10 7H6a5 5 0 0 0 0 10h4M14 7h4a5 5 0 0 1 0 10h-4M8 12h8',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  wave: 'M3 12h2l2-6 3 12 3-9 2 6 2-3h4',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6M11 8v6',
  power: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7',
  folder: 'M3 6h7l2 2h9v11H3z',
  keys: 'M3 5h18v14H3zM8 5v8M12 5v8M16 5v8M8 13v6M12 13v6M16 13v6',
  drum: 'M4 8c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 8v8c0 1.7 3.6 3 8 3s8-1.3 8-3V8',
  piano: 'M3 4h18v16H3zM3 9h18M7 4v5M11 4v5M15 4v5M19 4v5',
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  pencil: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  fade: 'M3 20L21 4M3 20h18',
  punch: 'M3 12h4M17 12h4M7 6v12M17 6v12M10 12h4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
};
const FILLED = new Set(['tostart', 'rewind', 'forward', 'stop', 'play', 'record', 'pointer']);

export function icon(name: string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(size)); svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', P[name] ?? '');
  if (FILLED.has(name)) p.setAttribute('fill', 'currentColor');
  else { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.8'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); }
  svg.appendChild(p);
  return svg;
}

export function iconBtn(name: string, label: string, onClick: (e: MouseEvent) => void, cls = 'cb-btn'): HTMLButtonElement {
  return h('button', { class: cls, 'aria-label': label, title: label, onClick }, icon(name));
}

let toastTimer: number | undefined;
export function toast(msg: string) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), 2800);
}
window.addEventListener('daw-toast', e => toast((e as CustomEvent).detail));

/** Popup menu anchored to an element. Items: [label, shortcut, action] or '-' */
export type MenuItem = [string, string, () => void, boolean?] | '-' | { label: string; sub: MenuItem[]; checked?: boolean } | { header: string };
export function openMenu(anchor: HTMLElement, items: MenuItem[], level = 0) {
  if (level === 0) closeMenus(); else document.querySelectorAll('.menu').forEach(m => { if (+((m as HTMLElement).dataset.level ?? 0) >= level) { (m as any)._cleanup?.(); m.remove(); } });
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu', role: 'menu', 'data-level': String(level) },
    items.map(it => {
      if (it === '-') return h('div', { class: 'menu-sep' });
      if ('header' in it) return h('div', { class: 'menu-header' }, it.header);
      if ('sub' in it) {
        const b: HTMLButtonElement = h('button', { class: 'menu-item menu-parent' + (it.checked ? ' checked' : ''), role: 'menuitem', 'aria-haspopup': 'menu',
          onClick: () => openMenu(b, it.sub, level + 1) },
          h('span', { class: 'menu-check' }, it.checked ? '✓' : ''), h('span', { class: 'menu-label' }, it.label), h('span', { class: 'menu-key' }, '›'));
        b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') openMenu(b, it.sub, level + 1); });
        return b;
      }
      const b = h('button', { class: 'menu-item' + (it[3] ? ' checked' : ''), role: 'menuitem', onClick: () => { closeMenus(); it[2](); } },
        h('span', { class: 'menu-check' }, it[3] ? '✓' : ''), h('span', { class: 'menu-label' }, it[0]), h('span', { class: 'menu-key' }, it[1]));
      if (level === 0) b.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') document.querySelectorAll('.menu').forEach(m => { if (+((m as HTMLElement).dataset.level ?? 0) > level) { (m as any)._cleanup?.(); m.remove(); } }); });
      return b;
    }));
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = Math.min(menu.offsetHeight, innerHeight - 8);
  if (level > 0) {
    const left = r.right + mw + 2 > innerWidth ? r.left - mw - 2 : r.right + 2;
    menu.style.left = Math.max(4, left) + 'px';
    menu.style.top = Math.max(4, Math.min(r.top - 4, innerHeight - mh - 4)) + 'px';
  } else {
    menu.style.left = Math.max(4, Math.min(r.left, innerWidth - mw - 4)) + 'px';
    menu.style.top = (r.bottom + mh + 4 > innerHeight ? Math.max(4, r.top - mh - 4) : r.bottom + 4) + 'px';
  }
  if (level === 0) setTimeout(() => document.addEventListener('pointerdown', outside, true));
  function outside(e: Event) { if (!(e.target as Element).closest?.('.menu')) { closeMenus(); swallowGesture(e); } }
  (menu as any)._cleanup = () => document.removeEventListener('pointerdown', outside, true);
  return menu;
}
/**
 * Like on a Mac: a tap/click outside an open menu only closes the menu. This swallows the rest of that
 * gesture (release, click) so nothing underneath reacts, and tapping the menu's own button closes it.
 */
export function swallowGesture(e: Event) {
  e.preventDefault(); e.stopPropagation(); (e as any).stopImmediatePropagation?.();
  const types = ['pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'];
  let timer = 0;
  const done = () => { clearTimeout(timer); types.forEach(t => removeEventListener(t, block, true)); };
  const block = (ev: Event) => {
    ev.stopPropagation(); (ev as any).stopImmediatePropagation?.();
    if (ev.cancelable && ev.type !== 'pointerup' && ev.type !== 'pointercancel') ev.preventDefault();
    if (ev.type === 'click' || ev.type === 'contextmenu') done();
    else if (ev.type === 'pointerup' || ev.type === 'pointercancel') { clearTimeout(timer); timer = window.setTimeout(done, 350); }
  };
  types.forEach(t => addEventListener(t, block, true));
  timer = window.setTimeout(done, 8000);
}

export function closeMenus() {
  document.querySelectorAll('.menu').forEach(m => { (m as any)._cleanup?.(); m.remove(); });
}

/** Small floating text field (rename a marker, type a tempo). Enter/blur commits, Esc cancels. */
export function inlineEdit(x: number, y: number, value: string, onCommit: (v: string) => void, width = 140, numeric = false) {
  document.querySelectorAll('.inline-edit').forEach(e => e.remove());
  const inp = h('input', { class: 'inline-edit', value, inputmode: numeric ? 'decimal' : 'text', 'aria-label': numeric ? 'Tempo (BPM)' : 'Name' }) as HTMLInputElement;
  inp.style.left = `${Math.max(4, Math.min(x, innerWidth - width - 4))}px`;
  inp.style.top = `${Math.max(4, Math.min(y, innerHeight - 34))}px`;
  inp.style.width = `${width}px`;
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = (ok: boolean) => { if (done) return; done = true; const v = inp.value; inp.remove(); if (ok) onCommit(v); };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
}
