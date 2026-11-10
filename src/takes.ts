// Take folders and comping. A take folder is an audio region with `takes` (all aligned to the region start)
// and a `comp`: non-overlapping segments that say which take plays where.
import { Store, Region, Take, CompSeg, uid } from './model';
import { flexBuffer } from './flex';

export const isFolder = (r: Region) => !!r.takes?.length;

/** Comp, defaulting to the last take over the whole region. */
export function compOf(r: Region): CompSeg[] {
  if (r.comp?.length) return r.comp;
  const last = r.takes![r.takes!.length - 1];
  return [{ s: 0, e: r.length, take: last.id }];
}

/**
 * The plain audio regions a take folder plays (one per comp segment). Plain regions return themselves.
 * Used for playback, bounce and drawing, so everything that knows audio regions also knows take folders.
 */
export function expandRegion(store: Store, r: Region): Region[] {
  if (!isFolder(r)) {
    if (r.flex?.on && r.kind !== 'midi') { const id = flexBuffer(store, r); if (id) return [{ ...r, bufferId: id, offset: 0, flex: undefined }]; }
    return [r];
  }
  const out: Region[] = [];
  compOf(r).forEach((seg, i) => {
    const take = r.takes!.find(t => t.id === seg.take); if (!take) return;
    const buf = store.buffers.get(take.bufferId); if (!buf) return;
    const s = Math.max(0, seg.s), e = Math.min(r.length, seg.e); if (e <= s) return;
    let start = r.start + s;
    let off = take.offset + store.secs(r.start, start);
    if (off < 0) { start = store.beatAfter(start, -off); off = 0; }
    let end = Math.min(r.start + e, store.beatAfter(start, buf.duration - off));
    if (end - start < 1e-4) return;
    out.push({
      ...r, id: `${r.id}:${i}`, takes: undefined, comp: undefined, notes: undefined,
      bufferId: take.bufferId, start, length: end - start, offset: off,
      fadeIn: s <= 1e-6 ? r.fadeIn : 0, fadeOut: e >= r.length - 1e-6 ? r.fadeOut : 0,
    });
  });
  return out;
}

/** Puts `takeId` into the comp between `from` and `to` (beats relative to the region), merging neighbours. */
export function setComp(r: Region, from: number, to: number, takeId: string) {
  from = Math.max(0, Math.min(r.length, from)); to = Math.max(0, Math.min(r.length, to));
  if (to - from < 1e-4) return;
  const out: CompSeg[] = [];
  for (const sg of compOf(r)) {
    if (sg.e <= from || sg.s >= to) { out.push({ ...sg }); continue; }
    if (sg.s < from) out.push({ ...sg, e: from });
    if (sg.e > to) out.push({ ...sg, s: to });
  }
  out.push({ s: from, e: to, take: takeId });
  out.sort((a, b) => a.s - b.s);
  const merged: CompSeg[] = [];
  for (const sg of out) {
    const last = merged[merged.length - 1];
    if (last && last.take === sg.take && Math.abs(last.e - sg.s) < 1e-6) last.e = sg.e; else merged.push(sg);
  }
  r.comp = merged;
}

/** Builds a take folder from plain audio regions (already on one track). */
export function packTakes(store: Store, regions: Region[]): Region {
  const start = Math.min(...regions.map(r => r.start));
  const end = Math.max(...regions.map(r => r.start + r.length));
  const takes: Take[] = [];
  regions.forEach((r, i) => {
    if (isFolder(r)) for (const t of r.takes!) takes.push({ ...t, id: uid('tk'), offset: t.offset - store.secs(start, r.start) });
    else takes.push({ id: uid('tk'), bufferId: r.bufferId, offset: r.offset - store.secs(start, r.start), name: `Take ${i + 1}` });
  });
  takes.forEach((t, i) => (t.name = `Take ${i + 1}`));
  const base = regions[0];
  return { ...base, id: uid('r'), notes: undefined, start, length: end - start, offset: 0, bufferId: '', fadeIn: 0, fadeOut: 0, takes, comp: undefined, name: `${store.track(base.trackId)?.name ?? 'Audio'}: Take Folder` };
}

/** Split support: the right half keeps every take, shifted, and the comp after the cut. */
export function splitFolder(store: Store, r: Region, right: Region, cut: number) {
  const comp = compOf(r);
  const dt = store.secs(r.start, r.start + cut);
  right.takes = r.takes!.map(t => ({ ...t, offset: t.offset + dt }));
  right.comp = comp.filter(s => s.e > cut).map(s => ({ ...s, s: Math.max(0, s.s - cut), e: s.e - cut }));
  r.comp = comp.filter(s => s.s < cut).map(s => ({ ...s, e: Math.min(s.e, cut) }));
}

/** Left-edge trim: takes shift with the new start; comp positions shift the other way. */
export function trimFolderStart(store: Store, r: Region, origStart: number, origTakes: Take[], origComp: CompSeg[], newStart: number) {
  const dt = store.secs(origStart, newStart), db = newStart - origStart;
  r.takes = origTakes.map(t => ({ ...t, offset: t.offset + dt }));
  r.comp = origComp.map(s => ({ ...s, s: Math.max(0, s.s - db), e: s.e - db })).filter(s => s.e > 0);
}

/** Longest a folder can be: as long as its longest take. */
export function folderMaxEnd(store: Store, r: Region) {
  let end = r.start;
  for (const t of r.takes ?? []) { const b = store.buffers.get(t.bufferId); if (b) end = Math.max(end, store.beatAfter(r.start, b.duration - t.offset)); }
  return end;
}
