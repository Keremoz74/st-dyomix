// Core data model: project, tracks, regions, UI state, undo/redo.

import type { PluginType } from './audio/plugins';
import type { InstrumentState } from './audio/instruments';
import type { SessionState } from './session';
import type { PatternState } from './pattern';
import type { WamRef } from './audio/wam';
import type { NativeRef } from './audio/native';
import { generalPrefs } from './general-prefs';

export interface Note { p: number; s: number; l: number; v: number } // pitch, start (beats, region-relative), length (beats), velocity

export interface Insert {
  id: string;
  type: PluginType;
  bypass: boolean;
  params: Record<string, number>;
  /** Web Audio Module (type 'wam'): which plug-in and its saved state. */
  wam?: WamRef;
  /** Native VST3/AU plug-in (type 'native', desktop app only). */
  native?: NativeRef;
}

export type TrackKind = 'audio' | 'inst' | 'aux' | 'folder';

export interface Send { id: string; bus: number; level: number } // level in dB, post-fader
export interface AutoPoint { b: number; v: number } // beat, value in the parameter's own units
export type AutoMode = 'off' | 'read' | 'touch';
export interface TempoEvent { id: string; b: number; bpm: number } // tempo change at beat b (b > 0); project.tempo applies from 0
export interface Marker { id: string; b: number; name: string }
export interface Take { id: string; bufferId: string; offset: number; name: string } // offset: seconds into the file at the folder's start (may be negative)
export interface CompSeg { s: number; e: number; take: string } // beats, region-relative
export interface FlexMarker { id: string; src: number; b: number } // source seconds -> region-relative beat
export interface FlexState { on: boolean; follow: boolean; srcSpb?: number; markers: FlexMarker[] }

export interface Track {
  id: string;
  kind: TrackKind;
  instrument?: InstrumentState;
  name: string;
  color: string;
  volume: number; // dB
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  armed: boolean;
  monitor?: boolean; // input monitoring
  inserts: Insert[];
  sends?: Send[];
  bus?: number; // aux channels: the bus that feeds them
  parent?: string; // id of the Track Stack (folder) this track belongs to
  collapsed?: boolean; // folders
  auto?: Record<string, AutoPoint[]>; // param key -> points
  autoMode?: AutoMode;
  autoShow?: string; // param key shown in the lane
  /** Freeze file (rendered through native VST3/AU plug-ins); `sig` = what it was rendered from. */
  freeze?: { bufferId: string; sig: string };
}

export interface Region {
  id: string;
  kind?: 'audio' | 'midi';
  notes?: Note[];
  trackId: string;
  bufferId: string;
  name: string;
  start: number; // beats
  length: number; // beats
  offset: number; // seconds into the buffer
  muted: boolean;
  fadeIn?: number; // beats (audio regions)
  fadeOut?: number; // beats
  gain?: number; // dB (audio regions)
  takes?: Take[]; // take folder
  comp?: CompSeg[];
  flex?: FlexState;
  session?: SessionState; // Session Player region: notes are generated from these settings
  pattern?: PatternState; // Step Sequencer pattern region: notes are generated from the step grid
}

export const isMidi = (r: Region) => r.kind === 'midi';
export const cloneRegion = (r: Region, over: Partial<Region> = {}): Region => ({ ...r, notes: r.notes?.map(n => ({ ...n })), takes: r.takes?.map(t => ({ ...t })), comp: r.comp?.map(c => ({ ...c })), flex: r.flex ? { ...r.flex, markers: r.flex.markers.map(m => ({ ...m })) } : undefined, session: r.session ? { ...r.session } : undefined, pattern: r.pattern ? { ...r.pattern, rows: r.pattern.rows.map(x => ({ ...x, cells: [...x.cells] })) } : undefined, ...over });

export interface Project {
  id?: string; // identifies the project in the autosave store
  name: string;
  tempo: number;
  sigNum: number;
  tracks: Track[];
  regions: Region[];
  masterVolume: number; // dB
  masterInserts: Insert[];
  auxes: Track[];
  tempoEvents: TempoEvent[];
  markers: Marker[];
  key?: number; // key signature in fifths (-6..6), for the Score
  movie?: MovieInfo; // video synced to the timeline (the file itself lives in Store.movieBlob)
}

export interface MovieInfo { id: string; name: string; type: string; start: number /* project seconds where the movie's first frame plays */; audio: boolean; volume: number /* 0..1 */; fps: number; duration: number; w: number; h: number }

export type ToolId = 'pointer' | 'pencil' | 'eraser' | 'scissors' | 'join' | 'mute' | 'fade';
export type SnapMode = 'smart' | 'bar' | 'beat' | 'div' | 'off';

export const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'pointer', label: 'Pointer', key: 'T' },
  { id: 'pencil', label: 'Pencil', key: 'P' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'scissors', label: 'Scissors', key: 'I' },
  { id: 'join', label: 'Join', key: 'J' },
  { id: 'mute', label: 'Mute', key: 'M' },
  { id: 'fade', label: 'Fade', key: 'A' },
];

export interface UIState {
  playhead: number; // beats
  playing: boolean;
  recording: boolean;
  cycle: { on: boolean; start: number; end: number };
  metronome: boolean;
  selectedTrackId: string | null;
  selectedTrackIds: Set<string>;
  selectedRegionIds: Set<string>;
  tool: ToolId;
  cmdTool: ToolId;
  snap: SnapMode;
  pxPerBeat: number;
  trackH: number;
  showInspector: boolean;
  showMixer: boolean;
  showEditor: boolean;
  editorRegionId: string | null;
  showKeyboard: boolean;
  showMovie?: boolean;
  focus: 'tracks' | 'editor';
  midiView: 'roll' | 'score';
  punch: { on: boolean; start: number; end: number };
  countIn: number; // bars
  latencyMs: number; // extra recording offset
  inputDeviceId: string | null;
  showAuto: boolean;
  prSnap: number; // beats, 0 = off
  prPpb: number;
  octave: number;
  typingVel: number;
}

export const TRACK_COLORS = ['#2bb3a3', '#e8c547', '#4c8dff', '#e86ba8', '#9b7bff', '#e0a43a', '#5fc77f', '#e2714b'];
export const COLOR_CHOICES: [string, string][] = [['Teal', '#2bb3a3'], ['Yellow', '#e8c547'], ['Blue', '#4c8dff'], ['Pink', '#e86ba8'], ['Violet', '#9b7bff'], ['Amber', '#e0a43a'], ['Green', '#5fc77f'], ['Orange', '#e2714b'], ['Red', '#ff6b6b'], ['Sky', '#7fc6d9'], ['Gray', '#a3a6ad']];

let idCounter = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export type ChangeKind = 'structure' | 'mix' | 'view' | 'transport' | 'fx';
type Listener = (kind: ChangeKind) => void;

export class Store {
  project: Project = { name: 'Untitled', tempo: 120, sigNum: 4, tracks: [], regions: [], masterVolume: 0, masterInserts: [], auxes: [], tempoEvents: [], markers: [] };
  ui: UIState = {
    playhead: 0, playing: false, recording: false,
    cycle: { on: false, start: 16, end: 32 },
    metronome: false,
    selectedTrackId: null, selectedTrackIds: new Set(), selectedRegionIds: new Set(),
    tool: 'pointer', cmdTool: 'scissors', snap: 'smart',
    pxPerBeat: 24, trackH: 64,
    showInspector: true, showMixer: false, showEditor: false, editorRegionId: null, showKeyboard: false,
    focus: 'tracks', midiView: 'roll', showAuto: false, punch: { on: false, start: 8, end: 16 }, countIn: 0, latencyMs: 0, inputDeviceId: null, prSnap: 0.25, prPpb: 80, octave: 4, typingVel: 100,
  };
  buffers = new Map<string, AudioBuffer>();
  /** The movie file for project.movie (kept outside the project JSON). */
  movieBlob: Blob | null = null;
  movieId = '';
  peaks = new Map<string, Float32Array>();
  private listeners: Listener[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  on(fn: Listener) { this.listeners.push(fn); }
  emit(kind: ChangeKind) { for (const l of this.listeners) l(kind); }

  /** Seconds per beat of the first tempo (use secs()/beatAfter() for positions). */
  get spb() { return 60 / this.project.tempo; }

  // ---- tempo map: project.tempo from beat 0, then step changes in project.tempoEvents ----
  private tempoSegs() {
    const ev = [...(this.project.tempoEvents ?? [])].filter(e => e.b > 0).sort((a, b) => a.b - b.b);
    const segs: { b: number; spb: number; sec: number }[] = [{ b: 0, spb: 60 / this.project.tempo, sec: 0 }];
    for (const e of ev) { const last = segs[segs.length - 1]; segs.push({ b: e.b, spb: 60 / e.bpm, sec: last.sec + (e.b - last.b) * last.spb }); }
    return segs;
  }
  /** Seconds from beat 0 to beat b. */
  secAt(b: number) {
    const segs = this.tempoSegs();
    if (b <= 0) return b * segs[0].spb;
    let s = segs[0];
    for (const x of segs) { if (x.b <= b) s = x; else break; }
    return s.sec + (b - s.b) * s.spb;
  }
  /** Beat position at `sec` seconds from beat 0. */
  beatAtSec(sec: number) {
    const segs = this.tempoSegs();
    if (sec <= 0) return sec / segs[0].spb;
    let s = segs[0];
    for (const x of segs) { if (x.sec <= sec) s = x; else break; }
    return s.b + (sec - s.sec) / s.spb;
  }
  tempoAt(b: number) { const segs = this.tempoSegs(); let s = segs[0]; for (const x of segs) if (x.b <= b) s = x; return Math.round(600 / s.spb) / 10; }
  /** Seconds between two beat positions. */
  secs(b0: number, b1: number) { return this.secAt(b1) - this.secAt(b0); }
  /** Beat position `sec` seconds after beat `b` (negative sec = before). */
  beatAfter(b: number, sec: number) { return this.beatAtSec(this.secAt(b) + sec); }
  get beatsPerBar() { return this.project.sigNum; }

  insertsOf(owner: string | 'master'): Insert[] {
    return owner === 'master' ? this.project.masterInserts : this.track(owner)?.inserts ?? [];
  }
  clearHistory() { this.undoStack = []; this.redoStack = []; }

  track(id: string | null) { return this.project.tracks.find(t => t.id === id) ?? this.project.auxes.find(t => t.id === id); }
  channels() { return [...this.project.tracks, ...this.project.auxes]; }
  /** Tracks shown as rows in the Tracks area (children of collapsed stacks are hidden). */
  visibleTracks() {
    const collapsed = new Set(this.project.tracks.filter(t => t.kind === 'folder' && t.collapsed).map(t => t.id));
    return this.project.tracks.filter(t => !t.parent || !collapsed.has(t.parent));
  }
  children(folderId: string) { return this.project.tracks.filter(t => t.parent === folderId); }
  auxForBus(bus: number) { return this.project.auxes.find(a => a.bus === bus); }
  addAux(name?: string): Track {
    const used = new Set(this.project.auxes.map(a => a.bus));
    let bus = 1; while (used.has(bus)) bus++;
    const a: Track = { id: uid('a'), kind: 'aux', bus, name: name ?? `Aux ${bus}`, color: '#7fc6d9', volume: 0, pan: 0, mute: false, solo: false, armed: false, inserts: [] };
    this.project.auxes.push(a);
    return a;
  }
  region(id: string) { return this.project.regions.find(r => r.id === id); }
  selectedRegions() { return this.project.regions.filter(r => this.ui.selectedRegionIds.has(r.id)); }

  songEndBeats() {
    let end = 0;
    for (const r of this.project.regions) end = Math.max(end, r.start + r.length);
    
    return end;
  }

  addBuffer(buf: AudioBuffer, id = uid('b')) {
    this.buffers.set(id, buf);
    this.peaks.set(id, computePeaks(buf));
    return id;
  }

  // Undo works on snapshots of tracks + regions (buffers are immutable and shared).
  private snapshot() { const p = this.project; return JSON.stringify({ t: p.tracks, r: p.regions, tempo: p.tempo, mi: p.masterInserts, ax: p.auxes, te: p.tempoEvents, mk: p.markers, name: p.name, key: p.key ?? 0, mv: p.movie ?? null }); }
  private restore(s: string) {
    const o = JSON.parse(s);
    this.project.tracks = o.t; this.project.regions = o.r; this.project.tempo = o.tempo; this.project.masterInserts = o.mi; this.project.auxes = o.ax ?? []; this.project.tempoEvents = o.te ?? []; this.project.markers = o.mk ?? []; if (o.name) this.project.name = o.name; this.project.key = o.key ?? 0; this.project.movie = o.mv && this.movieBlob && o.mv.id === this.movieId ? o.mv : undefined;
    const ids = new Set(this.project.regions.map(r => r.id));
    for (const id of [...this.ui.selectedRegionIds]) if (!ids.has(id)) this.ui.selectedRegionIds.delete(id);
    if (!this.track(this.ui.selectedTrackId)) this.ui.selectedTrackId = this.project.tracks[0]?.id ?? null;
    this.ui.selectedTrackIds = new Set([...this.ui.selectedTrackIds].filter(id => this.track(id)));
    if (this.ui.editorRegionId && !this.region(this.ui.editorRegionId)) this.ui.editorRegionId = null;
  }
  checkpoint() {
    this.undoStack.push(this.snapshot());
    while (this.undoStack.length > generalPrefs().undoSteps) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    const s = this.undoStack.pop(); if (!s) return false;
    this.redoStack.push(this.snapshot()); this.restore(s); this.emit('structure'); return true;
  }
  redo() {
    const s = this.redoStack.pop(); if (!s) return false;
    this.undoStack.push(this.snapshot()); this.restore(s); this.emit('structure'); return true;
  }

  addTrack(name?: string, select = true, kind: TrackKind = 'audio', instrument?: InstrumentState): Track {
    const n = this.project.tracks.length;
    const t: Track = { id: uid('t'), kind, instrument, name: name ?? `${kind === 'inst' ? 'Inst' : 'Audio'} ${n + 1}`, color: TRACK_COLORS[n % TRACK_COLORS.length], volume: 0, pan: 0, mute: false, solo: false, armed: false, inserts: [] };
    this.project.tracks.push(t);
    if (select) this.ui.selectedTrackId = t.id;
    return t;
  }

  snapUnit(): number {
    const { snap, pxPerBeat } = this.ui;
    if (snap === 'off') return 0;
    if (snap === 'bar') return this.beatsPerBar;
    if (snap === 'beat') return 1;
    if (snap === 'div') return 0.25;
    // smart: depends on zoom
    if (pxPerBeat >= 120) return 0.25;
    if (pxPerBeat >= 40) return 0.5;
    if (pxPerBeat >= 14) return 1;
    return this.beatsPerBar;
  }
  snapBeat(b: number) { const u = this.snapUnit(); return u ? Math.round(b / u) * u : b; }

  formatPos(beats: number) {
    const bpb = this.beatsPerBar;
    const bar = Math.floor(beats / bpb) + 1;
    const beat = Math.floor(beats % bpb) + 1;
    const div = Math.floor((beats % 1) * 4) + 1;
    const tick = Math.floor(((beats * 4) % 1) * 240) + 1;
    return { bar, beat, div, tick, text: `${bar} ${beat} ${div} ${String(tick).padStart(3, ' ')}` };
  }
}

export function computePeaks(buf: AudioBuffer, bucket = 256): Float32Array {
  const n = Math.ceil(buf.length / bucket);
  const out = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = i * bucket, e = Math.min(buf.length, s + bucket);
    for (const d of chans) for (let j = s; j < e; j++) { const v = Math.abs(d[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

export const PEAK_BUCKET = 256;

export const dbToGain = (db: number) => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number) => (g <= 0.001 ? -60 : 20 * Math.log10(g));
// Fader position (0..1) <-> dB, with 0 dB at ~0.78 and +6 dB at top.
export const faderToDb = (p: number) => (p <= 0.001 ? -Infinity : 6 + 40 * Math.log10(p) * 1.6);
export const dbToFader = (db: number) => (db === -Infinity || db <= -60 ? 0 : Math.min(1, Math.pow(10, (db - 6) / 64)));
export const fmtDb = (db: number) => (db === -Infinity || db <= -60 ? '-∞' : (db > 0 ? '+' : '') + db.toFixed(1));
