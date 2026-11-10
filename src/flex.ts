// Flex Time: move audio in time with flex markers, quantize transients, and follow tempo changes.
// A flexed region is rendered with WSOLA time-stretching along a piecewise-linear time map; the render is
// cached and played in place of the original (the original file is never changed).
import { Store, Region, FlexMarker, uid } from './model';

// ---------------- time map ----------------
/** Source position (seconds into the file) for region-relative beat `b` without any markers. */
export function baseSrc(store: Store, r: Region, b: number) {
  const f = r.flex;
  return f?.follow && f.srcSpb ? r.offset + b * f.srcSpb : r.offset + store.secs(r.start, r.start + b);
}

export interface Anchor { b: number; src: number }

/** Anchors: region edges plus flex markers, sorted. Markers at the edges replace the edge anchors. */
export function anchors(store: Store, r: Region): Anchor[] {
  const len = r.length;
  const ms = [...(r.flex?.markers ?? [])].sort((a, b) => a.b - b.b);
  const start = ms.find(m => Math.abs(m.b) < 1e-6), end = ms.find(m => Math.abs(m.b - len) < 1e-6);
  const inner = ms.filter(m => m.b > 1e-6 && m.b < len - 1e-6);
  return [start ? { b: 0, src: start.src } : { b: 0, src: baseSrc(store, r, 0) }, ...inner.map(m => ({ b: m.b, src: m.src })), end ? { b: len, src: end.src } : { b: len, src: baseSrc(store, r, len) }];
}

export function srcAt(an: Anchor[], b: number) {
  if (b <= an[0].b) return an[0].src + (b - an[0].b) * slope(an, 0);
  for (let i = 1; i < an.length; i++) if (b <= an[i].b) { const a = an[i - 1], c = an[i]; return c.b === a.b ? c.src : a.src + (c.src - a.src) * (b - a.b) / (c.b - a.b); }
  const l = an[an.length - 1]; return l.src + (b - l.b) * slope(an, an.length - 2);
}
function slope(an: Anchor[], i: number) { const a = an[i], c = an[i + 1]; return !c || c.b === a.b ? 0 : (c.src - a.src) / (c.b - a.b); }

/** Inverse map: where (region-relative beat) source position `src` plays. */
export function beatOfSrc(an: Anchor[], src: number) {
  for (let i = 1; i < an.length; i++) {
    const a = an[i - 1], c = an[i];
    if (src >= Math.min(a.src, c.src) && src <= Math.max(a.src, c.src)) return c.src === a.src ? a.b : a.b + (c.b - a.b) * (src - a.src) / (c.src - a.src);
  }
  return null;
}

// ---------------- transients ----------------
const transientCache = new WeakMap<AudioBuffer, Float32Array>();
/** Onset times (seconds) found from a simple energy-rise detector. */
export function transients(buf: AudioBuffer): Float32Array {
  const hit = transientCache.get(buf); if (hit) return hit;
  const hop = 256, win = 512, sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const n = Math.floor((buf.length - win) / hop);
  const env = new Float32Array(Math.max(0, n));
  for (let i = 0; i < n; i++) {
    let e = 0; const s = i * hop;
    for (const d of chans) for (let j = 0; j < win; j += 2) { const v = d[s + j]; e += v * v; }
    env[i] = Math.sqrt(e / (win / 2) / chans.length);
  }
  let peak = 0; for (const v of env) if (v > peak) peak = v;
  const floor = peak * 0.04, out: number[] = [];
  let last = -1e9;
  for (let i = 3; i < n; i++) {
    const prev = (env[i - 1] + env[i - 2] + env[i - 3]) / 3;
    const rise = env[i] - prev;
    if (env[i] > floor && rise > Math.max(peak * 0.05, prev * 0.6) && env[i] >= env[i + 1] * 0.8) {
      const t = (i * hop) / sr;
      if (t - last > 0.07) { out.push(Math.max(0, t - 0.004)); last = t; }
    }
  }
  const arr = Float32Array.from(out);
  transientCache.set(buf, arr);
  return arr;
}

// ---------------- WSOLA render ----------------
const N = 1024, HO = 512, TOL = 192;
const HANN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/** Renders the flexed region: output starts at the region start and lasts the region's duration. */
export function renderFlex(store: Store, ctx: BaseAudioContext, r: Region): AudioBuffer | null {
  const src = store.buffers.get(r.bufferId); if (!src) return null;
  const sr = src.sampleRate, an = anchors(store, r);
  const t0 = store.secAt(r.start);
  const outLen = Math.max(1, Math.round(store.secs(r.start, r.start + r.length) * sr));
  const out = ctx.createBuffer(src.numberOfChannels, outLen, sr);
  const ins = Array.from({ length: src.numberOfChannels }, (_, c) => src.getChannelData(c));
  const outs = Array.from({ length: src.numberOfChannels }, () => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const mono = ins[0];
  const inPosAt = (outSample: number) => srcAt(an, store.beatAtSec(t0 + outSample / sr) - r.start) * sr;
  let prev = -1;
  for (let op = 0; op < outLen; op += HO) {
    let nominal = Math.round(inPosAt(op + N / 2) - N / 2);
    let chosen = nominal;
    if (prev >= 0) {
      // pick the candidate whose start best continues the previous frame (natural continuation)
      const nat = prev + HO;
      let best = -Infinity;
      for (let d = -TOL; d <= TOL; d += 4) {
        const c = nominal + d; if (c < 0 || c + N / 2 >= mono.length || nat < 0 || nat + N / 2 >= mono.length) continue;
        let s = 0;
        for (let k = 0; k < N / 2; k += 4) s += mono[nat + k] * mono[c + k];
        if (s > best) { best = s; chosen = c; }
      }
    }
    for (let ch = 0; ch < ins.length; ch++) {
      const id = ins[ch], od = outs[ch];
      for (let k = 0; k < N; k++) { const i = chosen + k; if (i >= 0 && i < id.length) od[op + k] += id[i] * HANN[k]; }
    }
    for (let k = 0; k < N; k++) norm[op + k] += HANN[k];
    prev = chosen;
  }
  for (let ch = 0; ch < outs.length; ch++) {
    const od = outs[ch], res = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) res[i] = norm[i] > 1e-3 ? od[i] / norm[i] : 0;
    out.copyToChannel(res, ch);
  }
  return out;
}

// ---------------- cache ----------------
const cache = new Map<string, { sig: string; id: string }>(); // region id -> rendered buffer id

function signature(store: Store, r: Region) {
  return JSON.stringify([r.bufferId, r.offset, r.length, r.flex, r.start, store.project.tempo, store.project.tempoEvents]);
}

/** Rendered buffer id if it is up to date, else null (playback falls back to the original). */
export function flexBuffer(store: Store, r: Region): string | null {
  const c = cache.get(r.id);
  return c && c.sig === signature(store, r) && store.buffers.has(c.id) ? c.id : null;
}

/** (Re)renders every flexed region that is out of date. Returns how many were rendered. */
export function refreshFlex(store: Store, ctx: BaseAudioContext): number {
  let n = 0;
  const live = new Set<string>();
  for (const r of store.project.regions) {
    if (!r.flex?.on || r.kind === 'midi' || r.takes?.length) continue;
    live.add(r.id);
    const sig = signature(store, r);
    const c = cache.get(r.id);
    if (c && c.sig === sig && store.buffers.has(c.id)) continue;
    const buf = renderFlex(store, ctx, r); if (!buf) continue;
    if (c) store.buffers.delete(c.id), store.peaks.delete(c.id);
    cache.set(r.id, { sig, id: store.addBuffer(buf) });
    n++;
  }
  for (const [id, c] of cache) if (!live.has(id)) { store.buffers.delete(c.id); store.peaks.delete(c.id); cache.delete(id); }
  return n;
}

// ---------------- editing helpers ----------------
export function enableFlex(store: Store, r: Region, on: boolean) {
  r.flex = { on, follow: r.flex?.follow ?? false, srcSpb: r.flex?.srcSpb, markers: r.flex?.markers ?? [] };
}
export function setFollowTempo(store: Store, r: Region, follow: boolean) {
  enableFlex(store, r, true);
  r.flex!.follow = follow;
  r.flex!.srcSpb = follow ? store.secs(r.start, r.start + r.length) / r.length : undefined;
}

/** Moves every transient in the region onto the grid (`unit` beats). */
export function quantizeFlex(store: Store, r: Region, unit: number) {
  const buf = store.buffers.get(r.bufferId); if (!buf) return 0;
  enableFlex(store, r, true);
  const an = anchors(store, { ...r, flex: { ...r.flex!, markers: [] } });
  const s0 = an[0].src, s1 = an[an.length - 1].src;
  const markers: FlexMarker[] = [];
  let lastB = -1;
  for (const t of transients(buf)) {
    if (t <= s0 + 0.01 || t >= s1 - 0.01) continue;
    const b = beatOfSrc(an, t); if (b == null) continue;
    const q = Math.round(b / unit) * unit;
    if (q <= lastB + 1e-6 || q <= 0 || q >= r.length) continue;
    markers.push({ id: uid('fm'), src: t, b: q }); lastB = q;
  }
  r.flex!.markers = markers;
  return markers.length;
}

/** Split support: both halves get explicit markers at the cut so the audio stays where it was. */
export function splitFlex(store: Store, r: Region, right: Region, cut: number) {
  const an = anchors(store, r);
  const srcCut = srcAt(an, cut), srcEnd = an[an.length - 1].src, srcStart = an[0].src;
  const ms = r.flex!.markers;
  right.flex = { ...r.flex!, markers: [{ id: uid('fm'), b: 0, src: srcCut }, ...ms.filter(m => m.b > cut + 1e-6).map(m => ({ ...m, id: uid('fm'), b: m.b - cut })), { id: uid('fm'), b: r.length - cut, src: srcEnd }] };
  r.flex = { ...r.flex!, markers: [{ id: uid('fm'), b: 0, src: srcStart }, ...ms.filter(m => m.b < cut - 1e-6 && m.b > 1e-6), { id: uid('fm'), b: cut, src: srcCut }] };
}
