// Arranger Track (Cubase style) + the time operations it needs: insert / remove / copy a span of the
// song across every track (regions, automation, markers, tempo changes, chords and arranger sections).
import { Store, Region, ArrSection, cloneRegion, uid, AutoPoint } from './model';

export const ARR_COLORS = ['#5b8def', '#e86ba8', '#e8c547', '#2bb3a3', '#9b7bff', '#e2714b', '#5fc77f', '#7fc6d9'];
export const ARR_NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Breakdown', 'Outro'];

type Split = (r: Region, at: number) => Region | null;
const EPS = 1e-6;

export const sections = (store: Store) => (store.project.arranger ??= []);
export const sectionAt = (store: Store, b: number) => sections(store).find(s => b >= s.b - EPS && b < s.b + s.len - EPS);

/** Cuts every region that crosses `at`, so the song can be cut there cleanly. */
function cutAt(store: Store, split: Split, at: number) {
  for (const r of [...store.project.regions]) if (r.start < at - EPS && r.start + r.length > at + EPS) split(r, at);
}

const shiftPts = (pts: AutoPoint[], from: number, by: number) => { for (const p of pts) if (p.b >= from - EPS) p.b += by; };

/** Opens a gap of `len` beats at `at`: everything at or after `at` moves later. */
export function insertTime(store: Store, split: Split, at: number, len: number) {
  const p = store.project;
  cutAt(store, split, at);
  for (const r of p.regions) if (r.start >= at - EPS) r.start += len;
  for (const m of p.markers) if (m.b >= at - EPS) m.b += len;
  for (const e of p.tempoEvents) if (e.b >= at - EPS) e.b += len;
  for (const c of p.chords ?? []) if (c.b >= at - EPS) c.b += len;
  for (const s of sections(store)) if (s.b >= at - EPS) s.b += len;
  for (const t of p.tracks) for (const pts of Object.values(t.auto ?? {})) shiftPts(pts, at, len);
}

/** Removes the span [s, e) and closes the gap. */
export function removeTime(store: Store, split: Split, s: number, e: number) {
  const p = store.project, len = e - s;
  cutAt(store, split, s); cutAt(store, split, e);
  p.regions = p.regions.filter(r => !(r.start >= s - EPS && r.start < e - EPS));
  for (const r of p.regions) if (r.start >= e - EPS) r.start -= len;
  const inSpan = (b: number) => b >= s - EPS && b < e - EPS;
  p.markers = p.markers.filter(m => !inSpan(m.b)); for (const m of p.markers) if (m.b >= e - EPS) m.b -= len;
  p.tempoEvents = p.tempoEvents.filter(x => !inSpan(x.b)); for (const x of p.tempoEvents) if (x.b >= e - EPS) x.b -= len;
  p.chords = (p.chords ?? []).filter(c => !inSpan(c.b)); for (const c of p.chords) if (c.b >= e - EPS) c.b -= len;
  p.arranger = sections(store).filter(x => !inSpan(x.b)); for (const x of p.arranger) if (x.b >= e - EPS) x.b -= len;
  for (const t of p.tracks) for (const [k, pts] of Object.entries(t.auto ?? {})) {
    const keep = pts.filter(pt => !inSpan(pt.b)); shiftPts(keep, e, -len); t.auto![k] = keep;
  }
}

/** What lies in [s, e), copied, with positions relative to s. */
export function grabTime(store: Store, split: Split, s: number, e: number) {
  const p = store.project;
  cutAt(store, split, s); cutAt(store, split, e);
  const inSpan = (b: number) => b >= s - EPS && b < e - EPS;
  return {
    regions: p.regions.filter(r => inSpan(r.start)).map(r => cloneRegion(r, { id: uid('r'), start: r.start - s })),
    chords: (p.chords ?? []).filter(c => inSpan(c.b)).map(c => ({ ...c, id: uid('c'), b: c.b - s })),
    auto: p.tracks.map(t => ({ t, pts: Object.fromEntries(Object.entries(t.auto ?? {}).map(([k, pts]) => [k, pts.filter(pt => inSpan(pt.b)).map(pt => ({ ...pt, b: pt.b - s }))])) })),
  };
}
type Grab = ReturnType<typeof grabTime>;
export function pasteTime(store: Store, g: Grab, at: number) {
  const p = store.project;
  for (const r of g.regions) p.regions.push({ ...r, id: uid('r'), start: r.start + at });
  for (const c of g.chords) (p.chords ??= []).push({ ...c, id: uid('c'), b: c.b + at });
  for (const { t, pts } of g.auto) for (const [k, list] of Object.entries(pts)) {
    if (!list.length || !t.auto?.[k]) continue;
    t.auto[k].push(...list.map(pt => ({ ...pt, b: pt.b + at }))); t.auto[k].sort((a, b) => a.b - b.b);
  }
  (p.chords ?? []).sort((a, b) => a.b - b.b);
}

export function duplicateSection(store: Store, split: Split, sec: ArrSection) {
  const end = sec.b + sec.len;
  const g = grabTime(store, split, sec.b, end);
  insertTime(store, split, end, sec.len);
  pasteTime(store, g, end);
  const copy: ArrSection = { ...sec, id: uid('a'), b: end };
  sections(store).push(copy); sortSections(store);
  return copy;
}

export function deleteSection(store: Store, split: Split, sec: ArrSection) {
  removeTime(store, split, sec.b, sec.b + sec.len);
  store.project.arranger = sections(store).filter(x => x.id !== sec.id);
}

/** Moves a section (with all its content) so it starts at `to`; the song closes up behind it. */
export function moveSection(store: Store, split: Split, sec: ArrSection, to: number) {
  const s = sec.b, e = s + sec.len, len = sec.len;
  if (to > s - EPS && to < e + EPS) return false;
  const g = grabTime(store, split, s, e);
  const meta = { ...sec };
  removeTime(store, split, s, e);
  const at = to > s ? to - len : to;
  insertTime(store, split, at, len);
  pasteTime(store, g, at);
  sections(store).push({ ...meta, b: at }); sortSections(store);
  return true;
}

export const sortSections = (store: Store) => sections(store).sort((a, b) => a.b - b.b);

/** A new section at bar `b`: 8 bars, or up to the next section. */
export function addSection(store: Store, b: number): ArrSection | null {
  const bpb = store.beatsPerBar, list = sections(store);
  const start = Math.floor(b / bpb + EPS) * bpb;
  if (sectionAt(store, start)) return null;
  const next = list.filter(s => s.b > start).sort((x, y) => x.b - y.b)[0];
  const len = Math.max(bpb, Math.min(8 * bpb, (next?.b ?? Infinity) - start));
  const i = list.length;
  const sec: ArrSection = { id: uid('a'), name: ARR_NAMES[Math.min(i, ARR_NAMES.length - 1)], b: start, len, color: ARR_COLORS[i % ARR_COLORS.length] };
  list.push(sec); sortSections(store);
  return sec;
}
