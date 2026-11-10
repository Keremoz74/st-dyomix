// Settings › General: app-wide preferences kept per device.
export interface GeneralPrefs {
  uiScale: number;          // % (80–140)
  accent: string;           // accent color
  autosave: boolean;
  autosaveDelay: number;    // seconds after the last change
  undoSteps: number;
  newTempo: number;         // defaults for File › New Project
  newSigNum: number;
  newKey: number;
  clickLevel: number;       // metronome level, 0–100 %
  clickSound: 'beep' | 'wood' | 'hihat';
  followPlayhead: boolean;  // scroll the arrangement with the playhead
  showTooltips: boolean;
}
export const GENERAL_DEFAULTS: GeneralPrefs = { uiScale: 100, accent: '#4c9aff', autosave: true, autosaveDelay: 2.5, undoSteps: 200, newTempo: 120, newSigNum: 4, newKey: 0, clickLevel: 70, clickSound: 'beep', followPlayhead: true, showTooltips: true };

let cache: GeneralPrefs | null = null;
export function generalPrefs(): GeneralPrefs {
  if (!cache) { try { cache = { ...GENERAL_DEFAULTS, ...JSON.parse(localStorage.getItem('daw.general') || '{}') }; } catch { cache = { ...GENERAL_DEFAULTS }; } }
  return cache!;
}
const listeners = new Set<() => void>();
export const onGeneralChange = (f: () => void) => listeners.add(f);
export function saveGeneralPrefs(p: Partial<GeneralPrefs>) {
  cache = { ...generalPrefs(), ...p };
  try { localStorage.setItem('daw.general', JSON.stringify(cache)); } catch { /* storage off */ }
  applyGeneralPrefs();
  listeners.forEach(f => f());
}
/** Applies the visual preferences to the page. */
export function applyGeneralPrefs() {
  const g = generalPrefs(), root = document.documentElement;
  root.style.setProperty('--accent', g.accent);
  (root.style as any).zoom = g.uiScale === 100 ? '' : String(g.uiScale / 100);
  root.classList.toggle('no-tooltips', !g.showTooltips);
}
