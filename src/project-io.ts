// Save / open projects as a .zip: project.json + one WAV per audio file used.
import { Store, Project, uid } from './model';
import { Engine, encodeWav } from './audio/engine';
import { zipFiles, readZip, ZipEntry } from './audio/zip';
import { PLUGINS } from './audio/plugins';
import { INSTRUMENTS, newInstrument } from './audio/instruments';

const FORMAT = 'untitled-daw-project';

export async function saveProjectZip(store: Store): Promise<Blob> {
  const used = usedBuffers(store);
  const entries: ZipEntry[] = [];
  const files: Record<string, string> = {};
  for (const id of used) {
    const buf = store.buffers.get(id); if (!buf) continue;
    const name = `audio/${id}.wav`;
    entries.push({ name, data: new Uint8Array(await encodeWav(buf).arrayBuffer()) });
    files[id] = name;
  }
  let movieFile: string | undefined;
  const mv = store.project.movie;
  if (mv && store.movieBlob && mv.id === store.movieId) {
    const ext = (mv.type.split('/')[1] || 'mp4').replace('quicktime', 'mov').replace(/[^a-z0-9]/gi, '');
    movieFile = `movie/${mv.id}.${ext}`;
    entries.push({ name: movieFile, data: new Uint8Array(await store.movieBlob.arrayBuffer()) });
  }
  const json = {
    format: FORMAT, version: 1, savedAt: new Date().toISOString(),
    project: store.project, files, movieFile,
    ui: uiSnapshot(store),
  };
  entries.unshift({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(json, null, 1)) as Uint8Array<ArrayBuffer> });
  return zipFiles(entries);
}

export async function openProjectZip(store: Store, engine: Engine, file: File) {
  const zip = await readZip(await file.arrayBuffer());
  const pj = zip.get('project.json');
  if (!pj) throw new Error('This zip has no project.json');
  const json = JSON.parse(new TextDecoder().decode(pj));
  if (json.format !== FORMAT) throw new Error('This is not a project saved by this app');
  const buffers = new Map<string, AudioBuffer>();
  for (const [id, name] of Object.entries(json.files as Record<string, string>)) {
    const data = zip.get(name);
    if (data) buffers.set(id, await engine.ctx.decodeAudioData(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
  }
  let movie: Blob | null = null;
  const md = json.movieFile ? zip.get(json.movieFile) : undefined;
  if (md && json.project?.movie) movie = new Blob([md.slice()], { type: json.project.movie.type || 'video/mp4' });
  applyProject(store, engine, json.project as Project, buffers, json.ui ?? {}, movie);
}

/** Installs a loaded project (from a .zip or the autosave store) into the app. */
export function applyProject(store: Store, engine: Engine, p: Project, buffers: Map<string, AudioBuffer>, ui: any, movie: Blob | null = null) {
  // normalize older/partial files
  p.masterInserts = (p.masterInserts ?? []).filter(i => PLUGINS[i.type]);
  p.auxes = (p.auxes ?? []).map(a => ({ ...a, kind: 'aux' as const, inserts: (a.inserts ?? []).filter(i => PLUGINS[i.type]) }));
  p.tracks = (p.tracks ?? []).map(t => ({ volume: 0, pan: 0, mute: false, solo: false, armed: false, ...(t as any), inserts: (t.inserts ?? []).filter(i => PLUGINS[i.type]) }));
  p.regions = (p.regions ?? []).filter(r => (r.kind === 'midi' ? Array.isArray(r.notes) : r.takes?.length ? (r.takes = r.takes.filter(t => buffers.has(t.bufferId))).length > 0 : buffers.has(r.bufferId)) && p.tracks.some(t => t.id === r.trackId));
  for (const t of p.tracks) { if (!t.kind) t.kind = 'audio'; if (t.kind === 'inst' && (!t.instrument || !INSTRUMENTS[t.instrument.type])) t.instrument = newInstrument('synth'); }
  p.tempoEvents = (p.tempoEvents ?? []).filter(e => e.b > 0 && e.bpm >= 30 && e.bpm <= 300);
  p.markers = (p.markers ?? []).filter(m => m.b >= 0);
  p.key = Math.max(-6, Math.min(6, p.key ?? 0));
  if (p.movie && movie) { store.movieBlob = movie; store.movieId = p.movie.id; } else { p.movie = undefined; store.movieBlob = null; store.movieId = ''; }
  p.tempo = p.tempo || 120; p.sigNum = p.sigNum || 4; p.masterVolume = p.masterVolume ?? 0;

  if (store.ui.playing) engine.stop();
  store.buffers.clear(); store.peaks.clear();
  for (const [id, b] of buffers) store.addBuffer(b, id);
  store.project = p;
  if (!p.id) p.id = uid('p');
  Object.assign(store.ui, {
    cycle: ui.cycle ?? { on: false, start: 0, end: 16 }, metronome: !!ui.metronome,
    pxPerBeat: ui.pxPerBeat ?? store.ui.pxPerBeat, trackH: ui.trackH ?? store.ui.trackH, playhead: ui.playhead ?? 0,
    selectedRegionIds: new Set(), selectedTrackId: p.tracks[0]?.id ?? null, editorRegionId: null, showEditor: false,
  });
  store.clearHistory();
}

export const uiSnapshot = (store: Store) => ({ cycle: store.ui.cycle, metronome: store.ui.metronome, pxPerBeat: store.ui.pxPerBeat, trackH: store.ui.trackH, playhead: store.ui.playhead });
/** Every audio file the project uses (regions, takes, samplers). */
export const usedBuffers = (store: Store) => new Set([...store.project.regions.flatMap(r => [r.bufferId, ...(r.takes ?? []).map(t => t.bufferId)]), ...store.project.tracks.map(t => t.instrument?.bufferId ?? '')].filter(Boolean));
