// Plug-in Manager data kept per device: user presets, favorites, hidden plug-ins, the person's Web Audio Modules.
import type { WamRef } from './audio/wam';

interface PluginPrefs {
  presets: Record<string, Record<string, Record<string, number>>>; // plugin type -> preset name -> params
  favorites: string[];   // plugin types (built-in) or WAM URLs
  hidden: string[];      // built-in types hidden from menus
  wams: WamRef[];        // Web Audio Modules added from the browser or by URL (without state)
}
const KEY = 'daw.plugins';
const load = (): PluginPrefs => {
  try { const p = JSON.parse(localStorage.getItem(KEY) || '{}'); return { presets: p.presets ?? {}, favorites: p.favorites ?? [], hidden: p.hidden ?? [], wams: p.wams ?? [] }; }
  catch { return { presets: {}, favorites: [], hidden: [], wams: [] }; }
};
let cache = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage off */ } };
const listeners = new Set<() => void>();
const changed = () => { save(); listeners.forEach(f => f()); };

export const pluginPrefs = {
  onChange(f: () => void) { listeners.add(f); },
  userPresets: (type: string) => cache.presets[type] ?? {},
  savePreset(type: string, name: string, params: Record<string, number>) { (cache.presets[type] ??= {})[name] = { ...params }; changed(); },
  deletePreset(type: string, name: string) { delete cache.presets[type]?.[name]; changed(); },
  isFavorite: (id: string) => cache.favorites.includes(id),
  toggleFavorite(id: string) { cache.favorites = cache.favorites.includes(id) ? cache.favorites.filter(x => x !== id) : [...cache.favorites, id]; changed(); },
  get favorites() { return cache.favorites; },
  isHidden: (type: string) => cache.hidden.includes(type),
  setHidden(type: string, hide: boolean) { cache.hidden = hide ? [...new Set([...cache.hidden, type])] : cache.hidden.filter(x => x !== type); changed(); },
  get wams() { return cache.wams; },
  addWam(ref: WamRef) { const r = { url: ref.url, name: ref.name, vendor: ref.vendor, isInstrument: ref.isInstrument }; cache.wams = [...cache.wams.filter(w => w.url !== r.url), r]; changed(); },
  removeWam(url: string) { cache.wams = cache.wams.filter(w => w.url !== url); cache.favorites = cache.favorites.filter(f => f !== url); changed(); },
  exportAll: () => JSON.stringify(cache, null, 2),
  importAll(json: string) { const p = JSON.parse(json); cache = { presets: p.presets ?? {}, favorites: p.favorites ?? [], hidden: p.hidden ?? [], wams: p.wams ?? [] }; changed(); },
  reset() { cache = { presets: {}, favorites: [], hidden: [], wams: [] }; changed(); },
};
