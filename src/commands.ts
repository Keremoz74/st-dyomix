// All user-facing commands live here so buttons, menus and key commands share them.
import { Store, Region, Track, ToolId, Insert, uid, cloneRegion, isMidi } from './model';
import { isDrumKit } from './audio/instruments';
import { INSTRUMENTS, InstType, newInstrument } from './audio/instruments';
import { PluginType, PLUGINS, MAX_INSERTS, defaultParams } from './audio/plugins';
import { Engine } from './audio/engine';
import { toast } from './ui/dom';
import { zipOne } from './audio/zip';
import { saveProjectZip, openProjectZip } from './project-io';
import type { Autosave, RecentEntry } from './autosave';
import { loadDemo } from './audio/demo';
import { AutoMode } from './model';
import { findParam, sortPoints } from './automation';
import { isFolder, splitFolder, packTakes, expandRegion } from './takes';
import { splitFlex } from './flex';
import { SessionType, newSession, generate } from './session';
import { MovieController, probeMovie } from './movie';
import type { WamRef } from './audio/wam';
import type { NativeRef } from './audio/native';
import { pluginPrefs } from './plugin-prefs';
import { gmName } from './audio/gm';
import { generalPrefs } from './general-prefs';
import { nativeSave, shareFile, isTauri } from './platform';
import { newPattern, generatePattern, patternBeats, clonePattern } from './pattern';

// Inside the Claude viewer, downloads go through the platform's downloads capability (no .wav allowed there, so we zip it).
const downloadsP: Promise<any> = (window as any).claude?.use ? (window as any).claude.use('downloads').catch(() => null) : Promise.resolve(null);

export class Commands {
  /** The project's movie (video) player, synced to the playhead. */
  movie: MovieController;
  constructor(public store: Store, public engine: Engine) { this.movie = new MovieController(store); }

  // ----- movie (File › Movie, like Logic) -----
  openMovie = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'video/*,.mp4,.mov,.webm,.m4v';
    inp.onchange = () => { const f = inp.files?.[0]; if (f) this.loadMovie(f); };
    inp.click();
  };
  loadMovie = async (file: Blob & { name?: string }, start = 0) => {
    toast('Opening movie…');
    let meta;
    try { meta = await probeMovie(file); } catch { toast('This browser can\'t play that movie. Try MP4 (H.264) or WebM.'); return; }
    const id = uid('mv');
    this.store.checkpoint();
    this.store.movieBlob = file; this.store.movieId = id;
    this.store.project.movie = { id, name: (file.name ?? 'Movie').replace(/\.[^.]+$/, ''), type: file.type || 'video/mp4', start, audio: false, volume: 0.8, fps: 25, duration: meta.duration, w: meta.w, h: meta.h };
    this.ui.showMovie = true;
    this.store.emit('structure'); this.store.emit('view');
    toast(`Movie "${this.store.project.movie.name}" opened (${Math.round(meta.duration)} s). Import its audio from the Movie lane menu.`);
  };
  removeMovie = () => { if (!this.store.project.movie) return; this.edit(() => { this.store.project.movie = undefined; }); };
  setMovieStart = (sec: number) => { const m = this.store.project.movie; if (!m) return; this.edit(() => { m.start = Math.max(0, Math.round(sec * 1000) / 1000); }); };
  movieStartAtPlayhead = () => this.setMovieStart(this.store.secAt(this.ui.playhead));
  setMovieFps = (fps: number) => { const m = this.store.project.movie; if (m) { m.fps = fps; this.store.emit('mix'); } };
  toggleMovieAudio = () => { const m = this.store.project.movie; if (m) { m.audio = !m.audio; this.store.emit('mix'); } };
  setMovieVolume = (v: number) => { const m = this.store.project.movie; if (m) { m.volume = v; this.store.emit('mix'); } };
  toggleMovieWindow = () => {
    if (!this.store.project.movie) { this.openMovie(); return; }
    this.ui.showMovie = !this.ui.showMovie; this.store.emit('view');
  };
  /** Logic: File › Movie › Import Audio from Movie. Puts the soundtrack on a new audio track, aligned with the movie. */
  importMovieAudio = async () => {
    const m = this.movie.info, blob = this.store.movieBlob;
    if (!m || !blob) { toast('Open a movie first'); return; }
    let buf: AudioBuffer;
    try { buf = await this.engine.ctx.decodeAudioData(await blob.arrayBuffer()); } catch { toast('This movie has no audio this browser can read'); return; }
    this.edit(() => {
      const st = this.store, t = st.addTrack(`${m.name} Audio`.slice(0, 24));
      const start = st.beatAtSec(m.start);
      const r: Region = { id: uid('r'), trackId: t.id, bufferId: st.addBuffer(buf), name: `${m.name} (audio)`, start, length: st.beatAfter(start, buf.duration) - start, offset: 0, muted: false };
      st.project.regions.push(r);
      this.ui.selectedRegionIds = new Set([r.id]);
      m.audio = false; // the track plays it now
    });
    toast('Movie audio imported to a new track (the movie window\'s own sound is now off)');
  };

  private get ui() { return this.store.ui; }

  // ----- transport -----
  togglePlay = () => { this.engine.playing ? this.stop() : this.engine.play(); };
  stop = () => {
    if (!this.engine.playing) { this.ui.playhead = this.ui.cycle.on ? this.ui.cycle.start : 0; this.store.emit('transport'); return; }
    this.engine.stop();
  };
  record = async () => {
    if (this.ui.recording) { this.engine.stop(); return; }
    const err = await this.engine.startRecording();
    if (err) toast(err);
  };
  goToStart = () => this.locate(this.ui.cycle.on ? this.ui.cycle.start : 0);
  rewind = () => { const b = this.store.beatsPerBar; this.locate(Math.max(0, (Math.ceil(this.engine.currentBeat() / b - 0.05) - 1) * b)); };
  forward = () => { const b = this.store.beatsPerBar; this.locate((Math.floor(this.engine.currentBeat() / b + 0.05) + 1) * b); };
  locate = (beat: number) => {
    this.ui.playhead = Math.max(0, beat);
    if (this.engine.playing) this.engine.play(this.ui.playhead); else { this.engine.automate(this.ui.playhead); this.store.emit('transport'); }
  };
  togglePunch = () => {
    const p = this.ui.punch;
    if (!p.on && (p.end <= p.start || p.end <= this.ui.playhead)) {
      const bpb = this.store.beatsPerBar, bar = Math.floor(this.ui.playhead / bpb) * bpb;
      p.start = bar + bpb; p.end = bar + 3 * bpb;
    }
    p.on = !p.on; this.store.emit('transport');
    if (p.on) toast('Autopunch on: only the red range in the ruler is recorded');
  };
  setCountIn = (bars: number) => { this.ui.countIn = bars; savePrefs(this.ui); this.store.emit('transport'); };
  setLatency = (ms: number) => { if (!isFinite(ms)) return; this.ui.latencyMs = Math.max(-500, Math.min(500, Math.round(ms))); savePrefs(this.ui); toast(`Recording offset: ${this.ui.latencyMs} ms`); };
  setInputDevice = (id: string | null) => { this.ui.inputDeviceId = id; savePrefs(this.ui); this.engine.syncMonitor(); this.store.emit('transport'); };

  /** Logic's "Capture as Recording" (⇧R): turns MIDI you played without recording into a region. */
  captureRecording = () => {
    const t = this.liveTarget();
    const notes = this.engine.capture.filter(c => c.trackId === t?.id);
    if (!t || !notes.length) { toast('Play something on a software instrument (while the song plays), then press ⇧R'); return; }
    const bpb = this.store.beatsPerBar, c = this.ui.cycle;
    const min = Math.min(...notes.map(n => n.b)), max = Math.max(...notes.map(n => n.b + n.l));
    const start = c.on ? c.start : Math.floor(min / bpb) * bpb;
    const end = c.on ? c.end : Math.max(start + bpb, Math.ceil(max / bpb) * bpb);
    const r: Region = { id: uid('r'), kind: 'midi', trackId: t.id, bufferId: '', name: `${t.name} (captured)`, start, length: end - start, offset: 0, muted: false,
      notes: notes.map(n => ({ p: n.p, s: n.b - start, l: n.l, v: n.v })).filter(n => n.s >= 0 && n.s < end - start) };
    this.engine.capture = this.engine.capture.filter(x => x.trackId !== t.id);
    this.edit(() => { this.store.project.regions.push(r); this.ui.selectedRegionIds = new Set([r.id]); });
    toast(`Captured ${r.notes!.length} notes`);
  };

  toggleCycle = () => { this.ui.cycle.on = !this.ui.cycle.on; this.store.emit('transport'); this.engine.resync(); };
  toggleMetronome = () => { this.ui.metronome = !this.ui.metronome; this.store.emit('transport'); this.engine.resync(); };

  // ----- view -----
  toggleInspector = () => { this.ui.showInspector = !this.ui.showInspector; this.store.emit('view'); };
  toggleMixer = () => { this.ui.showMixer = !this.ui.showMixer; if (this.ui.showMixer) this.ui.showEditor = false; this.store.emit('view'); };
  zoom = (f: number) => { this.ui.pxPerBeat = Math.max(4, Math.min(320, this.ui.pxPerBeat * f)); this.store.emit('view'); };
  setTool = (t: ToolId, cmd = false) => { if (cmd) this.ui.cmdTool = t; else this.ui.tool = t; this.store.emit('view'); };

  // ----- edit -----
  private edit(fn: () => void) { this.store.checkpoint(); fn(); this.store.emit('structure'); this.engine.resync(); }
  /** Edits that change the signal chain but not the timeline: no transport restart. */
  private editFx(fn: () => void) { this.store.checkpoint(); fn(); this.store.emit('structure'); }
  undo = () => { if (this.store.undo()) this.engine.resync(); else toast('Nothing to undo'); };
  redo = () => { if (this.store.redo()) this.engine.resync(); else toast('Nothing to redo'); };

  deleteSelected = () => {
    const sel = this.ui.selectedRegionIds;
    if (!sel.size) return;
    this.edit(() => { this.store.project.regions = this.store.project.regions.filter(r => !sel.has(r.id)); sel.clear(); });
  };
  selectAll = () => { this.ui.selectedRegionIds = new Set(this.store.project.regions.map(r => r.id)); this.store.emit('structure'); };

  splitRegion(r: Region, at: number) {
    if (at <= r.start + 1e-6 || at >= r.start + r.length - 1e-6) return null;
    const cut = at - r.start;
    const right: Region = cloneRegion(r, { id: uid('r'), start: at, length: r.length - cut, offset: r.offset + this.store.secs(r.start, at) });
    if (isFolder(r)) splitFolder(this.store, r, right, cut);
    else if (r.flex?.on && !isMidi(r)) splitFlex(this.store, r, right, cut);
    else if (isMidi(r)) {
      right.notes = (r.notes ?? []).filter(n => n.s >= cut).map(n => ({ ...n, s: n.s - cut }));
      r.notes = (r.notes ?? []).filter(n => n.s < cut);
    }
    r.length = cut;
    if (!isMidi(r)) { right.fadeIn = 0; r.fadeOut = 0; }
    this.store.project.regions.push(right);
    return right;
  }
  splitAtPlayhead = () => {
    const at = this.engine.currentBeat();
    let targets = this.store.selectedRegions();
    if (!targets.length) targets = this.store.project.regions.filter(r => r.trackId === this.ui.selectedTrackId);
    targets = targets.filter(r => at > r.start && at < r.start + r.length);
    if (!targets.length) { toast('Put the playhead over a region to split it'); return; }
    this.edit(() => { for (const r of targets) { const nr = this.splitRegion(r, at); if (nr) this.ui.selectedRegionIds.add(nr.id); } });
  };

  /** Joins adjacent pieces of the same audio file on the same track. */
  joinSelected = (regions = this.store.selectedRegions()) => {
    if (regions.length < 2) { toast('Select two or more regions to join'); return; }
    if (regions.some(isFolder)) { toast('Flatten take folders before joining them'); return; }
    const sorted = [...regions].sort((a, b) => a.trackId.localeCompare(b.trackId) || a.start - b.start);
    if (sorted.every(isMidi)) {
      if (!sorted.every(r => r.trackId === sorted[0].trackId)) { toast('Join works on regions of one track'); return; }
      this.edit(() => {
        const first = sorted[0];
        const end = Math.max(...sorted.map(r => r.start + r.length));
        const notes = sorted.flatMap(r => (r.notes ?? []).filter(n => n.s < r.length).map(n => ({ ...n, s: n.s + r.start - first.start })));
        first.notes = notes.sort((a, b) => a.s - b.s); first.length = end - first.start;
        const drop = new Set(sorted.slice(1).map(r => r.id));
        this.store.project.regions = this.store.project.regions.filter(r => !drop.has(r.id));
        this.ui.selectedRegionIds = new Set([first.id]);
      });
      return;
    }
    const ok = sorted.every((r, i) => i === 0 || (r.trackId === sorted[i - 1].trackId && r.bufferId === sorted[i - 1].bufferId &&
      Math.abs(this.store.secs(sorted[i - 1].start, r.start) - (r.offset - sorted[i - 1].offset)) < 1e-3));
    if (!ok) { toast('Only adjacent pieces of the same recording can be joined for now'); return; }
    this.edit(() => {
      const first = sorted[0], last = sorted[sorted.length - 1];
      first.length = last.start + last.length - first.start;
      const drop = new Set(sorted.slice(1).map(r => r.id));
      this.store.project.regions = this.store.project.regions.filter(r => !drop.has(r.id));
      this.ui.selectedRegionIds = new Set([first.id]);
    });
  };

  /** Logic's "Repeat Regions Once" (⌘R): copies the selection right after itself. */
  repeat = () => {
    const sel = this.store.selectedRegions();
    if (!sel.length) return;
    const start = Math.min(...sel.map(r => r.start)), end = Math.max(...sel.map(r => r.start + r.length));
    this.edit(() => {
      this.ui.selectedRegionIds = new Set();
      for (const r of sel) { const c = cloneRegion(r, { id: uid('r'), start: r.start + (end - start) }); this.store.project.regions.push(c); this.ui.selectedRegionIds.add(c.id); }
    });
  };

  // ----- Cut / Copy / Paste, nudge, transpose, quantize, reverse, normalize (arrangement) -----
  private regionClip: { regions: Region[]; base: number; topTrack: number } | null = null;
  copyRegions = () => {
    const sel = this.store.selectedRegions(); if (!sel.length) return;
    const vis = this.store.visibleTracks(), idx = (r: Region) => vis.findIndex(t => t.id === r.trackId);
    this.regionClip = { regions: sel.map(r => cloneRegion(r)), base: Math.min(...sel.map(r => r.start)), topTrack: Math.min(...sel.map(idx)) };
    toast(`${sel.length} region${sel.length === 1 ? '' : 's'} copied`);
  };
  cutRegions = () => { if (!this.store.selectedRegions().length) return; this.copyRegions(); this.deleteSelected(); };
  /** Pastes at the playhead, starting on the selected track (keeps the regions' relative tracks and times). */
  pasteRegions = () => {
    const clip = this.regionClip; if (!clip) { toast('Nothing to paste: copy regions first (⌘C)'); return; }
    const st = this.store, vis = st.visibleTracks();
    const sel = vis.findIndex(t => t.id === this.ui.selectedTrackId);
    const at = st.snapBeat(this.ui.playhead);
    this.edit(() => {
      this.ui.selectedRegionIds = new Set();
      for (const r of clip.regions) {
        const origIdx = vis.findIndex(t => t.id === r.trackId);
        let target = sel >= 0 ? vis[sel + (origIdx - clip.topTrack)] : undefined;
        const fits = (t?: Track) => !!t && t.kind !== 'folder' && t.kind !== 'aux' && (r.kind === 'midi' ? t.kind === 'inst' : t.kind === 'audio');
        if (!fits(target)) target = st.track(r.trackId);
        if (!fits(target)) continue;
        const c = cloneRegion(r, { id: uid('r'), trackId: target!.id, start: at + (r.start - clip.base) });
        st.project.regions.push(c); this.ui.selectedRegionIds.add(c.id);
      }
    });
  };
  /** Moves the selected regions by one grid step (⌥← / ⌥→). */
  nudgeRegions = (dir: number) => {
    const sel = this.store.selectedRegions(); if (!sel.length) return;
    const step = this.store.snapUnit() || 0.25;
    if (dir < 0 && Math.min(...sel.map(r => r.start)) - step < -1e-9) return;
    this.edit(() => { for (const r of sel) r.start = Math.max(0, r.start + dir * step); });
  };
  /** MIDI regions: transpose all notes. */
  transposeRegions = (semi: number) => {
    const sel = this.store.selectedRegions().filter(r => r.kind === 'midi' && r.notes && !r.session && !r.pattern);
    if (!sel.length) { toast('Select MIDI regions to transpose'); return; }
    this.edit(() => { for (const r of sel) for (const n of r.notes!) n.p = Math.max(0, Math.min(127, n.p + semi)); });
    toast(`Transposed ${semi > 0 ? '+' : ''}${semi}`);
  };
  /** MIDI regions: quantize note starts (and lengths) to the Piano Roll grid. */
  quantizeRegions = () => {
    const sel = this.store.selectedRegions().filter(r => r.kind === 'midi' && r.notes && !r.session && !r.pattern);
    if (!sel.length) { toast('Select MIDI regions to quantize'); return; }
    const u = this.ui.prSnap || 0.25;
    this.edit(() => { for (const r of sel) for (const n of r.notes!) { n.s = Math.max(0, Math.round(n.s / u) * u); n.l = Math.max(u, Math.round(n.l / u) * u); } });
    toast(`Quantized ${sel.length} region${sel.length === 1 ? '' : 's'}`);
  };
  /** Audio regions: reverse or normalize the part of the file the region plays (makes a new file; undoable). */
  processAudioRegions = (op: 'reverse' | 'normalize') => {
    const st = this.store;
    const sel = st.selectedRegions().filter(r => r.kind !== 'midi' && !r.takes && !r.flex?.on && st.buffers.has(r.bufferId));
    if (!sel.length) { toast('Select audio regions (not take folders or Flex regions)'); return; }
    this.edit(() => {
      for (const r of sel) {
        const src = st.buffers.get(r.bufferId)!, sr = src.sampleRate;
        const from = Math.floor(r.offset * sr), n = Math.max(1, Math.min(src.length - from, Math.ceil(st.secs(r.start, r.start + r.length) * sr)));
        const out = this.engine.ctx.createBuffer(src.numberOfChannels, n, sr);
        let peak = 0;
        for (let c = 0; c < src.numberOfChannels; c++) { const d = src.getChannelData(c).subarray(from, from + n); for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i])); }
        const g = op === 'normalize' && peak > 1e-6 ? Math.pow(10, -0.1 / 20) / peak : 1;
        for (let c = 0; c < src.numberOfChannels; c++) {
          const d = src.getChannelData(c).subarray(from, from + n), o = out.getChannelData(c);
          for (let i = 0; i < n; i++) o[i] = (op === 'reverse' ? d[n - 1 - i] : d[i]) * g;
        }
        r.bufferId = st.addBuffer(out); r.offset = 0;
        if (op === 'reverse') { const fi = r.fadeIn; r.fadeIn = r.fadeOut; r.fadeOut = fi; }
      }
    });
    toast(op === 'reverse' ? 'Reversed' : 'Normalized to −0.1 dBFS');
  };
  /** Logic: New Track with Duplicate Settings (⌘D) — plug-ins, instrument and sends, without regions. */
  duplicateTrack = () => {
    const t = this.store.track(this.ui.selectedTrackId ?? ''); if (!t || t.kind === 'folder') return;
    this.edit(() => {
      const c: Track = JSON.parse(JSON.stringify(t));
      c.id = uid('t'); c.name = `${t.name} 2`; c.armed = false; c.freeze = undefined;
      c.inserts = c.inserts.map(i => ({ ...i, id: uid('fx') }));
      const list = this.store.project.tracks, i = list.indexOf(t);
      list.splice(i + 1, 0, c);
      this.ui.selectedTrackId = c.id;
    });
  };
  /** Logic: Bounce in Place — renders the track with its plug-ins to a new audio track and mutes the original. */
  bounceInPlace = async () => {
    const st = this.store, t = st.track(this.ui.selectedTrackId ?? '');
    if (!t || t.kind === 'folder' || t.kind === 'aux') { toast('Select a track to bounce in place'); return; }
    if (!st.project.regions.some(r => r.trackId === t.id)) { toast('The track has no regions'); return; }
    toast(`Bouncing “${t.name}” in place…`);
    await this.engine.captureWamStates();
    const buf = await this.engine.renderTrack(t, t.inserts, 2);
    this.edit(() => {
      const n = st.addTrack(`${t.name} Bnc`.slice(0, 24));
      const list = st.project.tracks; list.splice(list.indexOf(n), 1); list.splice(list.indexOf(t) + 1, 0, n);
      n.volume = t.volume; n.pan = t.pan; n.sends = t.sends ? JSON.parse(JSON.stringify(t.sends)) : undefined; n.parent = t.parent;
      const r: Region = { id: uid('r'), trackId: n.id, bufferId: st.addBuffer(buf), name: `${t.name} (bounce)`, start: 0, length: st.beatAfter(0, buf.duration), offset: 0, muted: false };
      st.project.regions.push(r);
      t.mute = true;
      this.ui.selectedTrackId = n.id; this.ui.selectedRegionIds = new Set([r.id]);
    });
    toast(`“${t.name}” bounced to a new track (original muted)`);
  };

  /** Region gain (dB) and fades (beats); one undo step per call. */
  setRegionProps = (r: Region, props: { gain?: number; fadeIn?: number; fadeOut?: number }) => {
    this.edit(() => {
      if (props.gain != null) r.gain = Math.max(-30, Math.min(24, props.gain));
      if (props.fadeIn != null) r.fadeIn = Math.max(0, Math.min(r.length - (r.fadeOut ?? 0), props.fadeIn));
      if (props.fadeOut != null) r.fadeOut = Math.max(0, Math.min(r.length - (r.fadeIn ?? 0), props.fadeOut));
    });
  };

  /** Logic's "Pack Take Folder": selected audio regions on one track become takes of one folder. */
  packTakeFolder = () => {
    const sel = this.store.selectedRegions().filter(r => !isMidi(r));
    if (sel.length < 2) { toast('Select two or more audio regions on one track to pack them as takes'); return; }
    if (!sel.every(r => r.trackId === sel[0].trackId)) { toast('Takes must be on one track'); return; }
    const folder = packTakes(this.store, sel.sort((a, b) => a.start - b.start));
    this.edit(() => {
      const drop = new Set(sel.map(r => r.id));
      this.store.project.regions = this.store.project.regions.filter(r => !drop.has(r.id));
      this.store.project.regions.push(folder);
      this.ui.selectedRegionIds = new Set([folder.id]);
    });
    toast(`Take folder with ${folder.takes!.length} takes. Double-click it to comp.`);
  };
  /** Turns a take folder's comp into plain regions. */
  flattenTakeFolder = (r = this.store.selectedRegions().find(isFolder)) => {
    if (!r || !isFolder(r)) { toast('Select a take folder first'); return; }
    const parts = expandRegion(this.store, r).map((vr, i) => ({ ...vr, id: uid('r'), name: `${r.name.replace(/: Take Folder$/, '')} comp ${i + 1}` }));
    this.edit(() => {
      this.store.project.regions = this.store.project.regions.filter(x => x.id !== r.id).concat(parts);
      this.ui.selectedRegionIds = new Set(parts.map(p => p.id));
      if (this.ui.editorRegionId === r.id) this.ui.editorRegionId = parts[0]?.id ?? null;
    });
    toast(`Flattened into ${parts.length} region${parts.length === 1 ? '' : 's'}`);
  };

  toggleRegionMute = () => {
    const sel = this.store.selectedRegions();
    if (!sel.length) return;
    this.edit(() => { const v = !sel[0].muted; sel.forEach(r => (r.muted = v)); });
  };

  // ----- plugins -----
  /** Set by main.ts: opens the plugin window. */
  openPlugin: (owner: string, insertId: string) => void = () => {};

  addPlugin = (owner: string, type: PluginType, wam?: WamRef, native?: NativeRef) => {
    const list = this.store.insertsOf(owner);
    if (list.length >= MAX_INSERTS) { toast(`Up to ${MAX_INSERTS} plug-ins per channel`); return; }
    const ins: Insert = { id: uid('fx'), type, bypass: false, params: type === 'wam' || type === 'native' ? {} : defaultParams(type), ...(wam ? { wam: { url: wam.url, name: wam.name, vendor: wam.vendor } } : {}), ...(native ? { native: { ...native } } : {}) };
    this.editFx(() => list.push(ins));
    this.openPlugin(owner, ins.id);
  };
  removePlugin = (owner: string, id: string) => {
    const list = this.store.insertsOf(owner);
    const i = list.findIndex(x => x.id === id); if (i < 0) return;
    this.editFx(() => list.splice(i, 1));
  };
  replacePlugin = (owner: string, id: string, type: PluginType, wam?: WamRef, native?: NativeRef) => {
    const ins = this.store.insertsOf(owner).find(x => x.id === id); if (!ins) return;
    this.editFx(() => { ins.type = type; ins.params = type === 'wam' || type === 'native' ? {} : defaultParams(type); ins.wam = wam ? { url: wam.url, name: wam.name, vendor: wam.vendor } : undefined; ins.native = native ? { ...native } : undefined; ins.id = uid('fx'); });
    this.openPlugin(owner, ins.id);
  };
  toggleBypass = (owner: string, id: string) => {
    const ins = this.store.insertsOf(owner).find(x => x.id === id); if (!ins) return;
    this.editFx(() => (ins.bypass = !ins.bypass));
  };
  /** Live parameter change; call store.checkpoint() once at the start of a gesture. */
  setParam = (owner: string, id: string, param: string, v: number) => {
    if (id === 'inst') { const t = this.store.track(owner); if (t?.instrument) { t.instrument.params[param] = v; this.store.emit('fx'); } return; }
    const ins = this.store.insertsOf(owner).find(x => x.id === id); if (!ins) return;
    ins.params[param] = v;
    this.store.emit('fx');
  };
  pluginName = (ins: Insert) => ins.type === 'wam' ? ins.wam?.name ?? 'Plug-in' : ins.type === 'native' ? ins.native?.name ?? 'Plug-in' : PLUGINS[ins.type]?.short ?? ins.type;
  /** Set by main.ts. */
  freezer: import('./audio/freeze').Freezer | null = null;
  setNativeParam = (owner: string, id: string, param: number, v: number) => { const ins = this.store.insertsOf(owner).find(x => x.id === id); if (!ins?.native) return; ins.native.params = { ...(ins.native.params ?? {}), [param]: v }; this.store.emit('fx'); };
  /** Moves an insert up/down the chain (Logic: drag in the slot list). */
  movePlugin = (owner: string, id: string, d: number) => {
    const list = this.store.insertsOf(owner), i = list.findIndex(x => x.id === id), j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    this.editFx(() => { const [x] = list.splice(i, 1); list.splice(j, 0, x); });
  };
  /** Applies a factory/user preset to an insert (one undo step). */
  applyPluginPreset = (owner: string, id: string, params: Record<string, number>) => {
    const ins = this.store.insertsOf(owner).find(x => x.id === id); if (!ins) return;
    this.editFx(() => { ins.params = { ...defaultParams(ins.type), ...params }; });
  };
  private fxClipboard: { type: PluginType; params: Record<string, number> } | null = null;
  copyPluginSettings = (owner: string, id: string) => { const ins = this.store.insertsOf(owner).find(x => x.id === id); if (ins) { this.fxClipboard = { type: ins.type, params: { ...ins.params } }; toast('Settings copied'); } };
  canPastePlugin = (owner: string, id: string) => { const ins = this.store.insertsOf(owner).find(x => x.id === id); return !!ins && this.fxClipboard?.type === ins.type; };
  pastePluginSettings = (owner: string, id: string) => { if (this.fxClipboard && this.canPastePlugin(owner, id)) this.applyPluginPreset(owner, id, this.fxClipboard.params); };
  savePluginPreset = (owner: string, id: string, name: string) => { const ins = this.store.insertsOf(owner).find(x => x.id === id); if (ins && name.trim()) { pluginPrefs.savePreset(ins.type, name.trim(), ins.params); toast(`Preset “${name.trim()}” saved`); } };

  /** Picks a Sound Library instrument for a track (keeps its other instrument settings). */
  setGmProgram = (trackId: string, prog: number) => {
    const t = this.store.track(trackId); if (!t || t.kind !== 'inst') return;
    this.editFx(() => {
      if (t.instrument?.type !== 'gm') t.instrument = newInstrument('gm');
      t.instrument.params = { ...t.instrument.params, program: prog };
      t.instrument.preset = gmName(prog);
    });
    this.engine.loadSampledInstruments();
    this.openPlugin(trackId, 'inst');
  };
  /** Switches a track's instrument (built-in or a Web Audio Module). */
  setInstrumentType = (trackId: string, type: InstType, wam?: WamRef) => {
    const t = this.store.track(trackId); if (!t || t.kind !== 'inst') return;
    const inst = newInstrument(type);
    if (type === 'wam' && wam) { inst.wam = { url: wam.url, name: wam.name, vendor: wam.vendor, isInstrument: true }; inst.preset = wam.name; }
    this.editFx(() => { t.instrument = inst; });
    this.openPlugin(trackId, 'inst');
  };
  newWamInstrumentTrack = (wam: WamRef) => {
    const inst = newInstrument('wam'); inst.wam = { url: wam.url, name: wam.name, vendor: wam.vendor, isInstrument: true }; inst.preset = wam.name;
    let id = '';
    this.edit(() => { const t = this.store.addTrack(wam.name.slice(0, 24), true, 'inst', inst); t.armed = false; id = t.id; });
    this.openPlugin(id, 'inst');
  };
  /** Set by main.ts: the plug-in browser (Web Audio Module catalog). */
  openPluginBrowser: (mode: 'fx' | 'inst', trackId?: string) => void = () => {};
  addWamFromUrl = (trackId?: string) => this.openPluginBrowser(trackId ? 'inst' : 'fx', trackId);
  /** Set by main.ts: Settings window. */
  openSettings: (tab?: string) => void = () => {};

  /** Instrument that live input (Musical Typing, MIDI keyboard) plays: the recording track, else the selected one, else an armed one. */
  liveTarget = () => {
    const rec = this.engine.recordingTrackId; if (rec) { const t = this.store.track(rec); if (t?.kind === 'inst') return t; }
    const sel = this.store.track(this.ui.selectedTrackId);
    if (sel?.kind === 'inst') return sel;
    const ts = this.store.project.tracks;
    return ts.find(t => t.kind === 'inst' && t.armed) ?? ts.find(t => t.kind === 'inst');
  };
  connectMidi: () => void = () => {};

  // ----- track menu: color, stacks -----
  setTrackColor = (id: string, color: string) => { const t = this.store.track(id); if (!t) return; this.editFx(() => (t.color = color)); };

  /** Logic's "Create Track Stack" (⇧⌘D): selected tracks go into a new Summing Stack. */
  createStack = () => {
    const p = this.store.project;
    const ids = new Set([...this.ui.selectedTrackIds, ...(this.ui.selectedTrackId ? [this.ui.selectedTrackId] : [])]);
    const members = p.tracks.filter(t => ids.has(t.id) && t.kind !== 'folder' && t.kind !== 'aux');
    if (!members.length) { toast('Select one or more tracks first (⇧-click headers to select several)'); return; }
    this.editFx(() => {
      const at = p.tracks.indexOf(members[0]);
      const folder: import('./model').Track = { id: uid('f'), kind: 'folder', name: 'Stack', color: '#a3a6ad', volume: 0, pan: 0, mute: false, solo: false, armed: false, inserts: [], collapsed: false };
      const rest = p.tracks.filter(t => !members.includes(t));
      const insertAt = rest.indexOf(p.tracks.slice(at).find(t => !members.includes(t)) ?? rest[rest.length]) ;
      for (const m of members) m.parent = folder.id;
      const idx = insertAt < 0 ? rest.length : insertAt;
      p.tracks = [...rest.slice(0, idx), folder, ...members, ...rest.slice(idx)];
      this.ui.selectedTrackId = folder.id; this.ui.selectedTrackIds = new Set([folder.id]);
    });
    toast('Track Stack created. Its channel sums the tracks inside it.');
  };
  toggleCollapse = (folderId: string) => { const f = this.store.track(folderId); if (!f) return; f.collapsed = !f.collapsed; this.store.emit('structure'); };
  moveToStack = (trackId: string, folderId: string | null) => {
    const p = this.store.project, t = this.store.track(trackId);
    if (!t || t.kind === 'folder' || t.kind === 'aux') return;
    this.editFx(() => {
      p.tracks = p.tracks.filter(x => x !== t);
      if (folderId) {
        t.parent = folderId;
        const fi = p.tracks.findIndex(x => x.id === folderId);
        let i = fi + 1; while (i < p.tracks.length && p.tracks[i].parent === folderId) i++;
        p.tracks.splice(i, 0, t);
      } else {
        const old = t.parent; t.parent = undefined;
        const fi = p.tracks.findIndex(x => x.id === old);
        let i = fi + 1; while (i < p.tracks.length && p.tracks[i].parent === old) i++;
        p.tracks.splice(fi < 0 ? p.tracks.length : i, 0, t);
      }
    });
  };
  selectTrack = (id: string, additive: boolean) => {
    if (additive) {
      const s = this.ui.selectedTrackIds;
      if (!s.size && this.ui.selectedTrackId) s.add(this.ui.selectedTrackId);
      s.has(id) && s.size > 1 ? s.delete(id) : s.add(id);
    }
    else this.ui.selectedTrackIds = new Set([id]);
    this.ui.selectedTrackId = id;
    this.store.emit('structure');
  };

  // ----- automation -----
  toggleAutomation = () => {
    this.ui.showAuto = !this.ui.showAuto;
    if (this.ui.showAuto && this.ui.trackH < 84) this.ui.trackH = 84;
    this.store.emit('view');
  };
  setAutoShow = (trackId: string, key: string) => { const t = this.store.track(trackId); if (!t) return; t.autoShow = key; this.store.emit('structure'); };
  setAutoMode = (trackId: string, mode: AutoMode) => {
    const t = this.store.track(trackId); if (!t) return;
    t.autoMode = mode; this.store.emit('structure');
    if (mode !== 'off') this.engine.automate(this.engine.currentBeat());
  };
  /** After editing points while stopped, show the curve's value at the playhead. */
  autoEdited = () => { if (!this.engine.playing) this.engine.automate(this.ui.playhead); };

  private writing = new Map<string, number>(); // touch key -> last beat written
  /**
   * Fader/knob gestures call this. In Touch mode during playback the movement is written as automation.
   * phase 'start' | 'value' | 'end'
   */
  gesture = (trackId: string, key: string, phase: 'start' | 'value' | 'end', value?: number) => {
    const t = this.store.project.tracks.find(x => x.id === trackId);
    if (!t) return;
    const tk = `${trackId}|${key}`;
    if (phase === 'start') {
      if (t.autoMode !== 'touch' || !this.engine.playing) return;
      this.store.checkpoint();
      this.engine.touching.add(tk);
      this.writing.set(tk, this.engine.currentBeat());
      return;
    }
    if (phase === 'end') {
      if (this.engine.touching.delete(tk)) { this.writing.delete(tk); this.store.emit('view'); }
      return;
    }
    if (!this.engine.touching.has(tk) || value == null) return;
    const beat = this.engine.currentBeat();
    let last = this.writing.get(tk) ?? beat;
    if (beat < last) last = beat; // cycle wrapped
    t.auto ??= {};
    const pts = (t.auto[key] ??= []);
    if (!pts.length) { const p = findParam(this.store, t, key); if (p) pts.push({ b: 0, v: p.get() }); }
    t.auto[key] = sortPoints([...pts.filter(p => !(p.b > last && p.b <= beat)), { b: beat, v: value }]);
    this.writing.set(tk, beat);
    if (!t.autoShow) t.autoShow = key;
  };

  // ----- sends / aux -----
  addSend = (trackId: string, bus: number) => {
    const t = this.store.track(trackId); if (!t || t.kind === 'aux') return;
    if ((t.sends ?? []).length >= 2) { toast('Up to 2 sends per channel for now'); return; }
    this.editFx(() => { t.sends = [...(t.sends ?? []), { id: uid('s'), bus, level: -6 }]; });
  };
  newBusSend = (trackId: string, fx: 'reverb' | 'delay' | null) => {
    const t = this.store.track(trackId); if (!t || t.kind === 'aux') return;
    if ((t.sends ?? []).length >= 2) { toast('Up to 2 sends per channel for now'); return; }
    this.editFx(() => {
      const a = this.store.addAux(fx === 'reverb' ? 'Reverb Bus' : fx === 'delay' ? 'Delay Bus' : undefined);
      if (fx) a.inserts = [{ id: uid('fx'), type: fx, bypass: false, params: { ...defaultParams(fx), mix: 100 } }];
      t.sends = [...(t.sends ?? []), { id: uid('s'), bus: a.bus!, level: -6 }];
    });
    toast('New aux channel created. Open the Mixer (X) to see it.');
  };
  removeSend = (trackId: string, sendId: string) => {
    const t = this.store.track(trackId); if (!t?.sends) return;
    this.editFx(() => { t.sends = t.sends!.filter(x => x.id !== sendId); });
  };
  setSendBus = (trackId: string, sendId: string, bus: number) => {
    const sd = this.store.track(trackId)?.sends?.find(x => x.id === sendId); if (!sd) return;
    this.editFx(() => { sd.bus = bus; });
  };
  /** Live; call store.checkpoint() at gesture start. */
  setSendLevel = (trackId: string, sendId: string, db: number) => {
    const sd = this.store.track(trackId)?.sends?.find(x => x.id === sendId); if (!sd) return;
    sd.level = Math.max(-60, Math.min(6, Math.round(db * 10) / 10));
    this.store.emit('mix');
  };
  newAux = () => { this.editFx(() => { const a = this.store.addAux(); this.ui.selectedTrackId = a.id; }); };
  deleteAux = (auxId: string) => {
    const a = this.store.project.auxes.find(x => x.id === auxId); if (!a) return;
    this.editFx(() => {
      this.store.project.auxes = this.store.project.auxes.filter(x => x !== a);
      for (const t of this.store.project.tracks) if (t.sends) t.sends = t.sends.filter(x => x.bus !== a.bus);
      if (this.ui.selectedTrackId === a.id) this.ui.selectedTrackId = this.store.project.tracks[0]?.id ?? null;
    });
  };

  // ----- tracks -----
  newTrack = () => { this.edit(() => this.store.addTrack()); };
  newInstrumentTrack = (type: InstType = 'synth', preset?: string) => {
    const inst = newInstrument(type, preset);
    this.edit(() => { const t = this.store.addTrack(type === 'drums' ? 'Electronic Drums' : type === 'sampler' ? 'Sampler' : type === 'epiano' ? 'E-Piano' : type === 'organ' ? 'Organ' : type === 'gm' ? gmName(inst.params.program).replace(' (Acoustic)', '') : inst.preset, true, 'inst', inst); t.armed = false; });
  };
  newTrackMenu = (): [string, string, () => void][] => [
    ['New Audio Track', '⌥⌘A', this.newTrack],
    ['New Software Instrument Track (Grand Piano)', '⌥⌘S', () => this.newInstrumentTrack('gm')],
    ['New Drum Kit Track', '', () => this.newInstrumentTrack('gm', 'Drum Kit (Acoustic)')],
    ['New Electronic Drum Kit Track', '', () => this.newInstrumentTrack('drums')],
    ['New Synth Track', '', () => this.newInstrumentTrack('synth')],
    ['New Sampler Track', '', () => this.newInstrumentTrack('sampler')],
    ['New Electric Piano Track', '', () => this.newInstrumentTrack('epiano')],
    ['New Organ Track', '', () => this.newInstrumentTrack('organ')],
    ['New Drummer Track', '', () => this.newSessionTrack('drums')],
    ['New Session Bass Track', '', () => this.newSessionTrack('bass')],
    ['New Session Keys Track', '', () => this.newSessionTrack('keys')],
    ['New Step Sequencer Track', '', () => this.newPatternTrack()],
  ];
  /** Logic-style Session Player: a track plus a generated region covering the song. */
  newSessionTrack = (type: SessionType) => {
    const bpb = this.store.beatsPerBar;
    const inst = newInstrument('gm', type === 'drums' ? 'Drum Kit (Acoustic)' : type === 'bass' ? 'Finger Bass' : 'Electric Piano (Rhodes)');
    const name = type === 'drums' ? 'Drummer' : type === 'bass' ? 'Session Bass' : 'Session Keys';
    const length = Math.max(8 * bpb, Math.ceil(this.store.songEndBeats() / bpb) * bpb);
    let region: Region | null = null;
    this.edit(() => {
      const t = this.store.addTrack(name, true, 'inst', inst);
      region = { id: uid('r'), kind: 'midi', notes: [], trackId: t.id, bufferId: '', name, start: 0, length, offset: 0, muted: false, session: newSession(type) };
      generate(this.store, region);
      this.store.project.regions.push(region);
      this.ui.selectedRegionIds = new Set([region.id]);
    });
    if (region) this.openEditor((region as Region).id);
  };
  /** Loads an audio file into a Sampler track. */
  loadSample = async (trackId: string, file: File) => {
    const t = this.store.track(trackId); if (!t?.instrument || t.instrument.type !== 'sampler') return;
    try {
      const buf = await this.engine.decodeFile(file);
      const id = this.store.addBuffer(buf);
      this.editFx(() => { t.instrument!.bufferId = id; t.instrument!.sampleName = file.name.replace(/\.[^.]+$/, ''); });
      toast(`Loaded "${t.instrument.sampleName}". Play it from Musical Typing (⌘K) or the Piano Roll.`);
    } catch { toast(`Couldn't read "${file.name}"`); }
  };
  pickSample = (trackId: string) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'audio/*';
    inp.onchange = () => { const f = inp.files?.[0]; if (f) this.loadSample(trackId, f); };
    inp.click();
  };

  /** Turns a Session Player region into a plain MIDI region you can edit note by note. */
  sessionToMidi = (r: Region) => {
    if (!r.session) return;
    this.edit(() => { r.session = undefined; r.name = `${r.name} (MIDI)`; });
    this.openEditor(r.id);
  };
  /** Logic's Step Sequencer: a pattern region (grid of steps) on an instrument track. */
  createPatternRegion = (trackId: string, start: number, bars = 4) => {
    const t = this.store.track(trackId);
    if (!t || t.kind !== 'inst') { toast('Pattern regions go on software instrument tracks'); return null; }
    const drums = isDrumKit(t.instrument);
    const pat = newPattern(drums, this.store.project.key ?? 0);
    const r: Region = { id: uid('r'), kind: 'midi', notes: [], trackId, bufferId: '', name: drums ? 'Beat Pattern' : 'Pattern', start, length: Math.max(patternBeats(pat), bars * this.store.beatsPerBar), offset: 0, muted: false, pattern: pat };
    generatePattern(r);
    this.edit(() => { this.store.project.regions.push(r); this.ui.selectedRegionIds = new Set([r.id]); });
    this.openEditor(r.id);
    return r;
  };
  newPatternTrack = () => {
    let id = '';
    this.edit(() => { const t = this.store.addTrack('Step Sequencer', true, 'inst', newInstrument('gm', 'Drum Kit (Acoustic)')); t.armed = false; id = t.id; });
    const bpb = this.store.beatsPerBar;
    this.createPatternRegion(id, Math.floor(this.ui.playhead / bpb) * bpb);
  };
  /** Turns a pattern region into a plain MIDI region (Logic: "Convert to MIDI Region"). */
  patternToMidi = (r: Region) => {
    if (!r.pattern) return;
    this.edit(() => { generatePattern(r); r.pattern = undefined; r.name = `${r.name} (MIDI)`; });
    this.openEditor(r.id);
  };
  /** Turns a plain MIDI region into a pattern region; its notes become steps on the pattern grid. */
  midiToPattern = (r: Region) => {
    if (r.kind !== 'midi' || r.pattern || r.session) return;
    const t = this.store.track(r.trackId), drums = isDrumKit(t?.instrument);
    const pitches = [...new Set((r.notes ?? []).map(n => n.p))].sort((a, b) => drums ? a - b : b - a);
    if (!pitches.length) { toast('The region has no notes to convert'); return; }
    if (pitches.length > 24) { toast('Too many different pitches for the step grid (max 24)'); return; }
    const bpb = this.store.beatsPerBar;
    const steps = Math.min(64, Math.max(16, Math.round(Math.min(r.length, 4 * bpb) * 4)));
    const pat = { ...newPattern(drums, 0, 'Empty'), steps };
    pat.rows = pitches.map(p => ({ p, cells: new Array(64).fill(0), gate: drums ? 0.5 : 0.8 }));
    for (const n of r.notes ?? []) { const i = Math.round(n.s * 4); if (i < steps) { const row = pat.rows.find(x => x.p === n.p)!; row.cells[i] = Math.max(row.cells[i], n.v); } }
    this.edit(() => { r.pattern = clonePattern(pat); generatePattern(r); });
    this.openEditor(r.id);
  };
  /** Empty MIDI region (Pencil tool on an instrument track, or ⇧⌘N). */
  createMidiRegion = (trackId: string, start: number, length = this.store.beatsPerBar) => {
    const t = this.store.track(trackId);
    if (!t || t.kind !== 'inst') { toast('MIDI regions go on software instrument tracks'); return null; }
    const r: Region = { id: uid('r'), kind: 'midi', notes: [], trackId, bufferId: '', name: t.name, start, length, offset: 0, muted: false };
    this.edit(() => { this.store.project.regions.push(r); this.ui.selectedRegionIds = new Set([r.id]); });
    return r;
  };

  // ----- editor -----
  openEditor = (regionId?: string) => {
    const r = regionId ? this.store.region(regionId) : this.store.selectedRegions()[0];
    if (!r) { toast('Select a region, then press P (Piano Roll) or E (Audio Editor)'); return; }
    this.ui.editorRegionId = r.id; this.ui.showEditor = true; this.ui.showMixer = false; this.ui.focus = 'editor';
    this.store.emit('view');
  };
  toggleEditor = () => {
    if (this.ui.showEditor) { this.ui.showEditor = false; this.ui.focus = 'tracks'; this.store.emit('view'); }
    else this.openEditor(this.ui.editorRegionId && this.store.selectedRegions().length === 0 ? this.ui.editorRegionId : undefined);
  };
  toggleKeyboard = () => { this.ui.showKeyboard = !this.ui.showKeyboard; this.store.emit('view'); };

  // ----- instruments -----
  setPreset = (trackId: string, preset: string) => {
    const t = this.store.track(trackId); if (!t?.instrument) return;
    const def = INSTRUMENTS[t.instrument.type]; if (!def.presets[preset]) return;
    this.editFx(() => { t.instrument!.preset = preset; t.instrument!.params = { ...def.presets[preset] }; });
  };

  deleteTrack = () => {
    const t = this.store.track(this.ui.selectedTrackId); if (!t) return;
    this.edit(() => {
      const p = this.store.project;
      const i = p.tracks.indexOf(t);
      p.tracks.splice(i, 1);
      if (t.kind === 'folder') for (const c of p.tracks) if (c.parent === t.id) c.parent = undefined;
      p.regions = p.regions.filter(r => r.trackId !== t.id);
      this.ui.selectedTrackId = p.tracks[Math.min(i, p.tracks.length - 1)]?.id ?? null;
    });
  };
  toggleTrack = (key: 'mute' | 'solo' | 'armed' | 'monitor', id = this.ui.selectedTrackId) => {
    const t = this.store.track(id); if (!t) return;
    t[key] = !t[key];
    this.store.emit('structure');
    if (key === 'monitor') this.engine.syncMonitor().then(err => { if (err) toast(err); else if (t.monitor) toast('Input monitoring on. Use headphones to avoid feedback.'); });
  };
  selectTrackOffset = (d: number) => {
    const ts = this.store.visibleTracks(); if (!ts.length) return;
    const i = ts.findIndex(t => t.id === this.ui.selectedTrackId);
    this.ui.selectedTrackId = ts[Math.max(0, Math.min(ts.length - 1, i + d))].id;
    this.ui.selectedTrackIds = new Set([this.ui.selectedTrackId]);
    this.store.emit('structure');
  };

  // ----- files -----
  importAudio = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'audio/*'; inp.multiple = true;
    inp.onchange = () => { if (inp.files) this.importFiles([...inp.files], this.ui.playhead, this.ui.selectedTrackId); };
    inp.click();
  };

  importFiles = async (files: File[], atBeat: number, trackId: string | null) => {
    let count = 0;
    for (const f of files) {
      try {
        const buf = await this.engine.decodeFile(f);
        const bid = this.store.addBuffer(buf);
        this.store.checkpoint();
        let t = this.store.track(trackId);
        const busy = t && this.store.project.regions.some(r => r.trackId === t!.id && r.start < this.store.beatAfter(atBeat, buf.duration) && r.start + r.length > atBeat);
        if (!t || busy) t = this.store.addTrack(f.name.replace(/\.[^.]+$/, '').slice(0, 24));
        const r: Region = { id: uid('r'), trackId: t.id, bufferId: bid, name: f.name.replace(/\.[^.]+$/, ''), start: this.store.snapBeat(atBeat), length: this.store.beatAfter(this.store.snapBeat(atBeat), buf.duration) - this.store.snapBeat(atBeat), offset: 0, muted: false };
        this.store.project.regions.push(r);
        this.ui.selectedRegionIds = new Set([r.id]);
        trackId = null;
        count++;
      } catch {
        toast(`Couldn't read "${f.name}". Try WAV, MP3, AAC or FLAC.`);
      }
    }
    if (count) { this.store.emit('structure'); this.engine.resync(); }
  };

  /** Hands a file to the viewer: platform downloads capability inside Claude, a normal download elsewhere. */
  private async offerFile(blob: Blob, filename: string, zipInside?: string): Promise<boolean> {
    const dl = await Promise.race([downloadsP, new Promise(r => setTimeout(() => r(null), 300))]) as any;
    if (dl) {
      try {
        const data = zipInside ? zipOne(zipInside, new Uint8Array(await blob.arrayBuffer())) : blob;
        await dl.save({ filename, data });
        return true;
      } catch (e: any) {
        toast(e?.code === 'declined' ? 'Not saved' : 'Saving files isn\'t available here');
        return false;
      }
    }
    // packaged app: native Save dialog; tablets/phones: share sheet ("Save to Files"); else a normal download
    const name = zipInside ?? filename;
    if (isTauri()) {
      try { const r = await nativeSave(blob, name); if (r !== null) { if (!r) toast('Not saved'); return r; } }
      catch (e) { console.warn('native save failed', e); }
    }
    if (isTauri()) { const r = await shareFile(blob, name); if (r !== null) return r; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return true;
  }

  private get fileBase() { return this.store.project.name.replace(/[^\w-]+/g, '_') || 'Untitled'; }

  bounce = async () => {
    if (!this.store.project.regions.length) { toast('Nothing to bounce yet'); return; }
    toast('Bouncing…');
    const blob = await this.engine.bounce();
    const inside = await Promise.race([downloadsP, new Promise(r => setTimeout(() => r(null), 300))]);
    if (await this.offerFile(blob, `${this.fileBase}.zip`, inside ? `${this.fileBase}.wav` : `${this.fileBase}.wav`))
      toast(inside ? 'Bounced: the WAV is inside the zip' : 'Bounced to WAV');
  };

  saveProject = async () => {
    toast('Saving project…');
    await this.engine.captureWamStates();
    const blob = await saveProjectZip(this.store);
    if (await this.offerFile(blob, `${this.fileBase}.zip`)) toast('Project saved as .zip, open it again with File › Open');
  };

  openProject = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,application/zip';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      try {
        await openProjectZip(this.store, this.engine, f);
        this.store.emit('structure'); this.store.emit('view'); this.store.emit('transport');
        toast(`Opened "${this.store.project.name}"`);
      } catch (e: any) { toast(e?.message || 'Could not open that file'); }
    };
    inp.click();
  };

  autosave: Autosave | null = null;
  recentList: RecentEntry[] = [];
  refreshRecent = async () => { if (this.autosave) this.recentList = await this.autosave.recent(); };
  openRecent = async (id: string) => {
    if (!this.autosave) return;
    if (this.engine.playing) this.engine.stop();
    await this.autosave.save(); // keep the current project before switching
    if (await this.autosave.load(id)) { this.store.emit('structure'); this.store.emit('view'); this.store.emit('transport'); toast(`Opened "${this.store.project.name}"`); }
    else toast('That project could not be opened');
    this.refreshRecent();
  };
  loadDemoSong = async () => {
    if (this.engine.playing) this.engine.stop();
    await this.autosave?.save();
    this.store.checkpoint();
    await loadDemo(this.store);
    this.store.project.id = uid('p');
    this.store.emit('structure'); this.store.emit('view');
    toast('Demo song loaded');
  };
  clearRecent = async () => { await this.autosave?.clear(); await this.refreshRecent(); toast('Recent projects cleared from this browser'); };

  newProject = () => {
    if (this.engine.playing) this.engine.stop();
    this.edit(() => {
      const p = this.store.project;
      p.tracks = []; p.regions = []; p.masterInserts = []; p.auxes = []; p.tempoEvents = []; p.markers = []; p.name = 'Untitled'; p.id = uid('p'); p.movie = undefined;
      const g = generalPrefs(); p.tempo = g.newTempo; p.sigNum = g.newSigNum; p.key = g.newKey;
      this.store.addTrack();
      this.ui.selectedRegionIds = new Set(); this.ui.playhead = 0;
    });
    toast('New project. Undo (⌘Z) brings the old one back.');
  };

  renameProject = (name: string) => { const n = name.trim().slice(0, 60); if (n && n !== this.store.project.name) { this.store.project.name = n; this.store.emit('view'); } };

  /**
   * Runs a tempo-map edit. Audio regions keep their real-time length (audio is not stretched),
   * so their length in beats is recomputed; MIDI, markers and automation stay on the grid.
   */
  private retime(fn: () => void) {
    const st = this.store;
    // Regions set to Follow Tempo keep their length in beats (their audio is stretched instead).
    const audio = st.project.regions.filter(r => !isMidi(r) && !r.flex?.follow).map(r => ({ r, sec: st.secs(r.start, r.start + r.length) }));
    const playing = this.engine.playing;
    this.edit(() => {
      fn();
      st.project.tempoEvents.sort((a, b) => a.b - b.b);
      for (const { r, sec } of audio) r.length = Math.max(0.05, st.beatAfter(r.start, sec) - r.start);
    });
    if (!playing) this.store.emit('transport');
  }
  private clampBpm = (bpm: number) => Math.max(30, Math.min(300, Math.round(bpm * 10) / 10));

  /** LCD tempo: changes the tempo in effect at the playhead. */
  setTempo = (bpm: number) => {
    if (!isFinite(bpm)) return;
    bpm = this.clampBpm(bpm);
    const p = this.store.project, at = this.ui.playhead;
    const ev = [...p.tempoEvents].filter(e => e.b > 0 && e.b <= at).sort((a, b) => b.b - a.b)[0];
    if ((ev ? ev.bpm : p.tempo) === bpm) return;
    this.retime(() => { if (ev) ev.bpm = bpm; else p.tempo = bpm; });
  };
  addTempoEvent = (beat: number, bpm?: number) => {
    const b = Math.max(1, Math.round(beat));
    const ex = this.store.project.tempoEvents.find(e => Math.abs(e.b - b) < 1e-6);
    if (ex) return ex;
    const e = { id: uid('tm'), b, bpm: this.clampBpm(bpm ?? this.store.tempoAt(b)) };
    this.retime(() => this.store.project.tempoEvents.push(e));
    return e;
  };
  setTempoEvent = (id: string, bpm: number) => {
    if (!isFinite(bpm)) return;
    if (id === 'base') { this.retime(() => (this.store.project.tempo = this.clampBpm(bpm))); return; }
    const e = this.store.project.tempoEvents.find(x => x.id === id); if (!e) return;
    this.retime(() => (e.bpm = this.clampBpm(bpm)));
  };
  moveTempoEvent = (id: string, beat: number) => {
    const e = this.store.project.tempoEvents.find(x => x.id === id); if (!e) return;
    const b = Math.max(1, Math.round(beat)); if (b === e.b) return;
    this.retime(() => (e.b = b));
  };
  deleteTempoEvent = (id: string) => { this.retime(() => { this.store.project.tempoEvents = this.store.project.tempoEvents.filter(x => x.id !== id); }); };

  // ----- markers -----
  addMarker = (beat = this.engine.currentBeat(), name?: string) => {
    const bpb = this.store.beatsPerBar;
    const b = Math.max(0, Math.floor(beat / bpb + 1e-6) * bpb);
    const ms = this.store.project.markers;
    if (ms.some(m => Math.abs(m.b - b) < 1e-6)) { toast('There is already a marker on that bar'); return null; }
    const m = { id: uid('m'), b, name: name ?? `Marker ${ms.length + 1}` };
    this.edit(() => { ms.push(m); ms.sort((a, c) => a.b - c.b); });
    return m;
  };
  renameMarker = (id: string, name: string) => { const m = this.store.project.markers.find(x => x.id === id); const n = name.trim().slice(0, 40); if (!m || !n || n === m.name) return; this.edit(() => (m.name = n)); };
  deleteMarker = (id: string) => { this.edit(() => { this.store.project.markers = this.store.project.markers.filter(x => x.id !== id); }); };
  gotoMarker = (dir: 1 | -1) => {
    const now = this.engine.currentBeat();
    const ms = this.store.project.markers;
    const m = dir > 0 ? ms.find(x => x.b > now + 0.01) : [...ms].reverse().find(x => x.b < now - 0.25);
    if (m) this.locate(m.b); else toast(dir > 0 ? 'No marker after the playhead' : 'No marker before the playhead');
  };


}

// Recording preferences survive reloads (per browser).
const PREFS = 'untitled-daw-prefs';
export function savePrefs(ui: { countIn: number; latencyMs: number; inputDeviceId: string | null }) {
  try { localStorage.setItem(PREFS, JSON.stringify({ countIn: ui.countIn, latencyMs: ui.latencyMs, inputDeviceId: ui.inputDeviceId })); } catch { /* storage unavailable */ }
}
export function loadPrefs(ui: { countIn: number; latencyMs: number; inputDeviceId: string | null }) {
  try { const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}'); if (typeof p.countIn === 'number') ui.countIn = p.countIn; if (typeof p.latencyMs === 'number') ui.latencyMs = p.latencyMs; if (typeof p.inputDeviceId === 'string') ui.inputDeviceId = p.inputDeviceId; } catch { /* ignore */ }
}
