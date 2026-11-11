// Fits the top bars to the screen: when the Control Bar or a toolbar is wider than the window
// (tablets, large system font sizes), it is scaled down as a whole instead of running off the right edge.
const BARS = '.control-bar, .lm-bar';
const MIN = 0.62;

function fit(el: HTMLElement) {
  // phones and portrait tablets wrap the bar onto two rows instead (bigger touch targets)
  if (innerWidth <= 760 || (el.classList.contains('control-bar') && matchMedia('(pointer: coarse) and (orientation: portrait)').matches)) { el.style.zoom = ''; el.classList.remove('fit'); return; } 
  el.classList.add('fit');
  el.classList.remove('compact');
  el.style.zoom = '1';
  let need = el.scrollWidth;
  const avail = el.clientWidth;
  if (need <= avail + 1) return;
  // first drop the text labels (icons stay), then scale what is left; whatever still doesn't fit can be scrolled
  el.classList.add('compact');
  need = el.scrollWidth;
  if (need > avail + 1) el.style.zoom = String(Math.max(MIN, Math.floor((avail / need) * 1000) / 1000));
}

let queued = false;
const watched = new WeakSet<HTMLElement>();
const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => fitBars()) : null;
const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fitBars()) : null;
export function fitBars() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.querySelectorAll<HTMLElement>(BARS).forEach(el => {
      // a bar's own buttons change when it re-renders (direct children only: the LCD's ticking digits don't count)
      if (!watched.has(el)) { watched.add(el); mo?.observe(el, { childList: true }); ro?.observe(el); }
      fit(el);
    });
  });
}

export function installFit(onChange: (f: () => void) => void) {
  addEventListener('resize', fitBars);
  onChange(fitBars);
  fitBars();
}
