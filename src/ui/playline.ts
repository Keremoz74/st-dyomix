// Playhead drawn as a moved DOM line (GPU transform) instead of repainting whole canvases every frame:
// during playback the timeline canvases only redraw when something actually changes.
export class PlayLine {
  readonly el: HTMLDivElement;
  private x = NaN; private rec = false; private shown = true;
  constructor(parent: HTMLElement, extra = '') {
    this.el = document.createElement('div');
    this.el.className = `playline ${extra}`.trim();
    parent.appendChild(this.el);
  }
  /** x in CSS px relative to the parent; null hides it. */
  set(x: number | null, rec: boolean) {
    const show = x != null && isFinite(x);
    if (show !== this.shown) { this.el.style.display = show ? '' : 'none'; this.shown = show; }
    if (!show) return;
    const rx = Math.round(x!);
    if (rx !== this.x) { this.el.style.transform = `translateX(${rx}px)`; this.x = rx; }
    if (rec !== this.rec) { this.el.classList.toggle('rec', rec); this.rec = rec; }
  }
}
