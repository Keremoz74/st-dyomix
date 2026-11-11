// Automatic crossfades (Cubase / Pro Tools style): where two audio regions on a track overlap, the earlier
// one fades out and the later one fades in across the overlap, so edits never click or jump in level.
import type { Region, Store } from './model';

const MAX_XF = 8; // beats

/** Crossfade lengths (beats) at a region's start (`in`) and end (`out`) from overlapping neighbours. */
export function crossfadeOf(store: Store, r: Region): { in: number; out: number } {
  if (r.kind === 'midi' || r.muted) return { in: 0, out: 0 };
  const id = r.id.split(':')[0];
  const end = r.start + r.length;
  let xin = 0, xout = 0;
  for (const o of store.project.regions) {
    if (o.trackId !== r.trackId || o.id === id || o.kind === 'midi' || o.muted) continue;
    const oEnd = o.start + o.length;
    // o starts before r and runs into it: r fades in
    if (o.start < r.start && oEnd > r.start && oEnd < end) xin = Math.max(xin, oEnd - r.start);
    // o starts inside r and runs past its end: r fades out
    if (o.start > r.start && o.start < end && oEnd > end) xout = Math.max(xout, end - o.start);
  }
  return { in: Math.min(xin, r.length / 2, MAX_XF), out: Math.min(xout, r.length / 2, MAX_XF) };
}

/** The region with crossfades folded into its fades (for playback / bounce). `parent` = the project region a comp segment comes from. */
export function withCrossfades(store: Store, vr: Region): Region {
  const base = vr.id.includes(':') ? store.region(vr.id.split(':')[0]) : vr;
  if (!base) return vr;
  const xf = crossfadeOf(store, base);
  if (!xf.in && !xf.out) return vr;
  const atStart = Math.abs(vr.start - base.start) < 1e-4, atEnd = Math.abs(vr.start + vr.length - (base.start + base.length)) < 1e-4;
  return { ...vr, fadeIn: atStart ? Math.max(vr.fadeIn ?? 0, xf.in) : vr.fadeIn, fadeOut: atEnd ? Math.max(vr.fadeOut ?? 0, xf.out) : vr.fadeOut };
}
