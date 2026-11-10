// Autosave + recent projects, kept in this browser's IndexedDB.
// Project JSON is saved often (cheap); audio files are saved once each, keyed by id, and shared between projects.
// Storage can be missing or refuse writes (private mode, sandboxed viewers): every call fails quietly.
import { Store, Project } from './model';
import { Engine } from './audio/engine';
import { generalPrefs } from './general-prefs';
import { applyProject, uiSnapshot, usedBuffers } from './project-io';

const DB = 'untitled-daw', VERSION = 1;
export interface RecentEntry { id: string; name: string; savedAt: number; tracks: number }

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB, VERSION); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('projects', { keyPath: 'id' }); db.createObjectStore('audio'); };
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  });
}
const tx = <T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void) =>
  new Promise<T | undefined>((res, rej) => { const t = db.transaction(stores, mode); let r: IDBRequest<T> | void; try { r = fn(t); } catch (e) { rej(e); return; } t.oncomplete = () => res(r ? r.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export class Autosave {
  private db: Promise<IDBDatabase | null>;
  private savedAudio = new Set<string>();
  private timer: number | undefined;
  private busy = false;
  lastSaved = 0;
  enabled = true;
  onSaved: () => void = () => {};

  constructor(private store: Store, private engine: Engine) {
    this.db = open().catch(() => null);
    store.on(k => { if (k === 'structure' || k === 'mix' || k === 'fx' || k === 'view') this.schedule(); });
  }

  get available() { return this.db.then(d => !!d); }

  private schedule() {
    const g = generalPrefs();
    if (!this.enabled || !g.autosave) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.save(), g.autosaveDelay * 1000);
  }

  async save() {
    const db = await this.db; if (!db || this.busy) return;
    if (this.store.ui.recording) { this.schedule(); return; }
    this.busy = true;
    try {
      await this.engine.captureWamStates();
      const p = this.store.project;
      // audio first, once per file
      for (const id of usedBuffers(this.store)) {
        if (this.savedAudio.has(id)) continue;
        const b = this.store.buffers.get(id); if (!b) continue;
        const rec = { sr: b.sampleRate, ch: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice()) };
        await tx(db, ['audio'], 'readwrite', t => t.objectStore('audio').put(rec, id));
        this.savedAudio.add(id);
      }
      // the movie file, once per movie (Blobs can be stored in IndexedDB directly)
      const mv = p.movie;
      if (mv && this.store.movieBlob && mv.id === this.store.movieId && !this.savedAudio.has(mv.id)) {
        await tx(db, ['audio'], 'readwrite', t => t.objectStore('audio').put({ movie: this.store.movieBlob }, mv.id));
        this.savedAudio.add(mv.id);
      }
      const entry = { id: p.id, name: p.name, savedAt: Date.now(), tracks: p.tracks.filter(t => t.kind !== 'folder').length, project: JSON.parse(JSON.stringify(p)), ui: uiSnapshot(this.store), audio: [...usedBuffers(this.store), ...(mv && mv.id === this.store.movieId ? [mv.id] : [])] };
      await tx(db, ['projects'], 'readwrite', t => t.objectStore('projects').put(entry));
      this.lastSaved = entry.savedAt;
      this.onSaved();
    } catch { /* quota or blocked: ignore, the zip Save still works */ }
    finally { this.busy = false; }
  }

  async recent(): Promise<RecentEntry[]> {
    const db = await this.db; if (!db) return [];
    try {
      const all = (await tx<any[]>(db, ['projects'], 'readonly', t => t.objectStore('projects').getAll())) ?? [];
      return all.map(e => ({ id: e.id, name: e.name, savedAt: e.savedAt, tracks: e.tracks })).sort((a, b) => b.savedAt - a.savedAt);
    } catch { return []; }
  }

  async load(id: string): Promise<boolean> {
    const db = await this.db; if (!db) return false;
    try {
      const e = await tx<any>(db, ['projects'], 'readonly', t => t.objectStore('projects').get(id));
      if (!e) return false;
      const buffers = new Map<string, AudioBuffer>();
      let movie: Blob | null = null;
      for (const aid of e.audio as string[]) {
        const rec = await tx<any>(db, ['audio'], 'readonly', t => t.objectStore('audio').get(aid));
        if (!rec) continue;
        if (rec.movie) { movie = rec.movie; this.savedAudio.add(aid); continue; }
        const b = this.engine.ctx.createBuffer(rec.ch.length, rec.ch[0].length, rec.sr);
        rec.ch.forEach((d: Float32Array<ArrayBuffer>, c: number) => b.copyToChannel(d, c));
        buffers.set(aid, b); this.savedAudio.add(aid);
      }
      this.enabled = false; // don't autosave the act of loading
      applyProject(this.store, this.engine, e.project as Project, buffers, e.ui ?? {}, movie);
      this.enabled = true;
      return true;
    } catch { this.enabled = true; return false; }
  }

  async clear() {
    const db = await this.db; if (!db) return;
    try { await tx(db, ['projects'], 'readwrite', t => t.objectStore('projects').clear()); await this.gc(db); } catch { /* ignore */ }
  }

  async remove(id: string) {
    const db = await this.db; if (!db) return;
    try { await tx(db, ['projects'], 'readwrite', t => t.objectStore('projects').delete(id)); await this.gc(db); } catch { /* ignore */ }
  }

  /** Deletes stored audio that no saved project uses any more. */
  private async gc(db: IDBDatabase) {
    const all = (await tx<any[]>(db, ['projects'], 'readonly', t => t.objectStore('projects').getAll())) ?? [];
    const keep = new Set(all.flatMap(e => e.audio as string[]));
    for (const id of usedBuffers(this.store)) keep.add(id);
    if (this.store.project.movie) keep.add(this.store.project.movie.id);
    const keys = (await tx<IDBValidKey[]>(db, ['audio'], 'readonly', t => t.objectStore('audio').getAllKeys())) ?? [];
    for (const k of keys) if (!keep.has(String(k))) { await tx(db, ['audio'], 'readwrite', t => t.objectStore('audio').delete(k)); this.savedAudio.delete(String(k)); }
  }
}
