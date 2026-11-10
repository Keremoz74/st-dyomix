// Track automation: which parameters can be automated, how values map to the lane, and curve evaluation.
import { Store, Track, AutoPoint, dbToFader, faderToDb, fmtDb } from './model';
import { PLUGINS, toNorm, fromNorm, fmtParam } from './audio/plugins';

export interface AutoParam {
  key: string;
  label: string;
  def: number;
  norm(v: number): number; // value -> 0..1 (lane height)
  denorm(n: number): number; // 0..1 -> value
  fmt(v: number): string;
  get(): number;
  set(v: number): void;
  kind: 'mix' | 'fx';
}

const volNorm = (db: number) => dbToFader(db);
const volDenorm = (n: number) => { const d = faderToDb(n); return !isFinite(d) || d < -60 ? -60 : Math.round(d * 10) / 10; };

/** Every automatable parameter of a track (volume, pan, sends, plug-in parameters). */
export function autoParams(store: Store, t: Track): AutoParam[] {
  const list: AutoParam[] = [
    { key: 'volume', label: 'Volume', def: 0, norm: volNorm, denorm: volDenorm, fmt: v => `${fmtDb(v)} dB`, get: () => t.volume, set: v => (t.volume = v), kind: 'mix' },
    { key: 'pan', label: 'Pan', def: 0, norm: v => (v + 1) / 2, denorm: n => Math.round((n * 2 - 1) * 64) / 64, fmt: v => (Math.abs(v) < 0.01 ? 'C' : `${Math.round(Math.abs(v) * 64)}${v < 0 ? 'L' : 'R'}`), get: () => t.pan, set: v => (t.pan = v), kind: 'mix' },
  ];
  for (const sd of t.sends ?? []) {
    const aux = store.auxForBus(sd.bus);
    list.push({ key: `send:${sd.id}`, label: `Send → ${aux?.name ?? `Bus ${sd.bus}`}`, def: -6, norm: volNorm, denorm: volDenorm, fmt: v => `${fmtDb(v)} dB`, get: () => sd.level, set: v => (sd.level = v), kind: 'mix' });
  }
  for (const ins of t.inserts) {
    const def = PLUGINS[ins.type];
    for (const p of def.params) {
      list.push({ key: `fx:${ins.id}:${p.id}`, label: `${def.short} · ${p.label}`, def: p.def, norm: v => toNorm(p, v), denorm: n => fromNorm(p, n), fmt: v => fmtParam(p, v), get: () => ins.params[p.id], set: v => (ins.params[p.id] = v), kind: 'fx' });
    }
  }
  return list;
}

export function findParam(store: Store, t: Track, key: string) { return autoParams(store, t).find(p => p.key === key); }

/** Linear interpolation; holds the first/last value outside the points. */
export function valueAt(pts: AutoPoint[], beat: number): number | undefined {
  if (!pts.length) return undefined;
  if (beat <= pts[0].b) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (beat <= b.b) return b.b === a.b ? b.v : a.v + (b.v - a.v) * (beat - a.b) / (b.b - a.b);
  }
  return pts[pts.length - 1].v;
}

export const sortPoints = (pts: AutoPoint[]) => pts.sort((a, b) => a.b - b.b);

export const autoActive = (t: Track) => t.kind !== 'aux' && (t.autoMode === 'read' || t.autoMode === 'touch') && !!t.auto;

/**
 * Applies automation at `beat` to the model. `skip` = keys being touched right now.
 * Returns which kinds changed so the caller can emit 'mix' / 'fx'.
 */
export function applyAutomation(store: Store, beat: number, skip?: Set<string>) {
  let mix = false, fx = false;
  for (const t of store.project.tracks) {
    if (!autoActive(t)) continue;
    const params = autoParams(store, t);
    for (const [key, pts] of Object.entries(t.auto!)) {
      if (!pts.length || skip?.has(`${t.id}|${key}`)) continue;
      const p = params.find(x => x.key === key); if (!p) continue;
      const v = valueAt(pts, beat)!;
      if (Math.abs(p.get() - v) > 1e-4) { p.set(v); if (p.kind === 'fx') fx = true; else mix = true; }
    }
  }
  return { mix, fx };
}
