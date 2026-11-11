// Web Audio engine: per-track channel strips, lookahead scheduler with cycle, metronome, meters, recording, bounce.
import { Store, Track, Region, Insert, dbToGain } from '../model';
import { PLUGINS, PluginInstance } from './plugins';
import { INSTRUMENTS, Voice } from './instruments';
import { Note, uid, Store as StoreT } from '../model';
import { applyAutomation, autoParams, autoActive, valueAt } from '../automation';
import { expandRegion, packTakes, compOf, setComp, trimFolderStart } from '../takes';
import { refreshFlex } from '../flex';
import { ensureWorklets, workletsReady } from './worklets';
import { wamEffect, createWam, attachInstrument, detachInstrument, instrumentInstance, sendTransport } from './wam';
import { audioPrefs } from './prefs';
import { setDecodeContext, loadBank } from './gm';
import { generalPrefs } from '../general-prefs';

interface FxChain {
  pre: GainNode;
  fx: Map<string, PluginInstance>;
  sig: string;
}

interface Strip extends FxChain {
  sends: Map<string, { node: GainNode; bus: number }>;
  input: GainNode; // volume (post-inserts)
  split: ChannelSplitterNode;
  dest: string; // 'master' or a folder id
  muteGain: GainNode;
  pan: StereoPannerNode;
  aL: AnalyserNode;
  aR: AnalyserNode;
  /** URL of the Web Audio Module instrument feeding this channel. */
  wamUrl?: string;
}

interface Segment { time: number; beat: number }

const LOOKAHEAD = 0.3; // seconds
const TICK_MS = 40;

export class Engine {
  ctx: AudioContext;
  private master: GainNode;
  private masterChain: FxChain;
  private masterAL: AnalyserNode;
  private masterAR: AnalyserNode;
  private strips = new Map<string, Strip>();
  private sources = new Set<AudioScheduledSourceNode>();
  private voices = new Set<Voice>();
  private live = new Map<string, Voice>(); // `${trackId}:${pitch}` -> held voice
  // MIDI recording
  private midiRec: { trackId: string; start: number; notes: Note[]; held: Map<number, Note> } | null = null;
  private timer: number | null = null;
  private segs: Segment[] = [];
  private schedBeat = 0;
  private schedTime = 0;
  private passStart = 0;
  private meterBuf = new Float32Array(1024);
  /** `${trackId}|${paramKey}` being moved by the user right now (Touch mode). */
  touching = new Set<string>();

  // recording
  private micStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recStartBeat = 0;
  private recTrackId: string | null = null;
  private recCycle: { start: number; end: number } | null = null;
  private recPunch: { start: number; end: number } | null = null;
  private recCtxStart = 0;
  private playT0 = 0;
  /** MIDI played while not recording, for "Capture as Recording" (⇧R). */
  capture: { trackId: string; p: number; b: number; l: number; v: number; open: boolean }[] = [];
  private mics = new Map<string, MediaStream>();
  private monSrc: MediaStreamAudioSourceNode | null = null;
  private monGains = new Map<string, GainNode>();

  constructor(private store: Store) {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ap = audioPrefs();
    try { this.ctx = new AC({ latencyHint: ap.latency, ...(ap.sampleRate ? { sampleRate: ap.sampleRate } : {}) }); }
    catch { this.ctx = new AC({ latencyHint: 'interactive' }); }
    if (ap.outputId && (this.ctx as any).setSinkId) (this.ctx as any).setSinkId(ap.outputId).catch(() => {});
    ensureWorklets(this.ctx).then(() => this.rebuildPending());
    setDecodeContext(this.ctx);
    this.master = this.ctx.createGain();
    this.masterChain = { pre: this.ctx.createGain(), fx: new Map(), sig: '?' };
    const split = this.ctx.createChannelSplitter(2);
    this.masterAL = this.ctx.createAnalyser(); this.masterAR = this.ctx.createAnalyser();
    this.masterAL.fftSize = this.masterAR.fftSize = 1024;
    this.master.connect(this.ctx.destination);
    this.master.connect(split);
    split.connect(this.masterAL, 0); split.connect(this.masterAR, 1);
    store.on(k => {
      if (k === 'mix' || k === 'structure') this.syncMix();
      if (k === 'fx') this.syncFx();
      if (k === 'structure') this.scheduleFlex();
    });
  }

  get playing() { return this.store.ui.playing; }
  private sampleOf(t: Track) { const id = t.instrument?.bufferId; return id ? this.store.buffers.get(id) : undefined; }

  private flexTimer: number | undefined;
  /** Flex renders run shortly after edits settle; playback restarts so the new audio is heard. */
  private scheduleFlex() {
    clearTimeout(this.flexTimer);
    this.flexTimer = window.setTimeout(() => {
      if (refreshFlex(this.store, this.ctx)) { this.store.emit('view'); this.resync(); }
    }, 150);
  }
  flushFlex() { clearTimeout(this.flexTimer); if (refreshFlex(this.store, this.ctx)) this.store.emit('view'); }
  get recordingTrackId() { return this.midiRec?.trackId ?? null; }

  private strip(t: Track): Strip {
    let s = this.strips.get(t.id);
    if (s) return s;
    const ctx = this.ctx;
    const input = ctx.createGain(), muteGain = ctx.createGain(), pan = ctx.createStereoPanner();
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 1024;
    const pre = ctx.createGain();
    input.connect(muteGain); muteGain.connect(pan); pan.connect(this.masterChain.pre);
    pan.connect(split); split.connect(aL, 0); split.connect(aR, 1);
    s = { pre, fx: new Map(), sig: '?', sends: new Map(), input, muteGain, pan, aL, aR, split, dest: 'master' };
    this.strips.set(t.id, s);
    return s;
  }

  syncMix() {
    const tracks = this.store.channels();
    const now = this.ctx.currentTime;
    for (const t of tracks) {
      const s = this.strip(t);
      s.input.gain.setTargetAtTime(dbToGain(t.volume), now, 0.01);
      s.pan.pan.setTargetAtTime(t.pan, now, 0.01);
      s.muteGain.gain.setTargetAtTime(audibleBySolo(this.store, t) ? 1 : 0, now, 0.005);
      // Track Stack routing: children feed their stack's channel instead of the master.
      const parent = t.parent ? this.store.track(t.parent) : undefined;
      const dest = parent?.kind === 'folder' ? parent.id : 'master';
      if (dest !== s.dest) {
        s.pan.disconnect();
        s.pan.connect(dest === 'master' ? this.masterChain.pre : this.strip(parent!).pre);
        s.pan.connect(s.split);
        s.dest = dest;
      }
    }
    // post-fader sends -> aux inputs
    for (const t of tracks) {
      const s = this.strip(t);
      const want = new Map((t.kind === 'aux' ? [] : t.sends ?? []).map(x => [x.id, x]));
      for (const [id, sd] of s.sends) {
        const w = want.get(id);
        if (!w || w.bus !== sd.bus || !this.store.auxForBus(w.bus)) { sd.node.disconnect(); s.sends.delete(id); }
      }
      for (const w of want.values()) {
        const aux = this.store.auxForBus(w.bus); if (!aux) continue;
        let sd = s.sends.get(w.id);
        if (!sd) { const node = this.ctx.createGain(); s.muteGain.connect(node); node.connect(this.strip(aux).pre); sd = { node, bus: w.bus }; s.sends.set(w.id, sd); }
        sd.node.gain.setTargetAtTime(dbToGain(w.level), now, 0.01);
      }
    }
    for (const id of [...this.strips.keys()]) {
      if (!tracks.find(t => t.id === id)) {
        const st = this.strips.get(id)!;
        st.pan.disconnect(); st.sends.forEach(x => x.node.disconnect()); st.fx.forEach(f => f.dispose()); this.strips.delete(id);
      }
    }
    this.syncFx();
    this.syncInstruments();
    this.master.gain.setTargetAtTime(dbToGain(this.store.project.masterVolume), now, 0.01);
  }

  /** Builds/updates insert chains: pre -> [active plugins] -> dest. Params are pushed every call. */
  syncFx() {
    for (const t of this.store.channels()) { const s = this.strip(t); this.syncChain(s, t.inserts, s.input); }
    this.syncChain(this.masterChain, this.store.project.masterInserts, this.master);
  }

  /** Set by the Freezer: the freeze file of a track whose freeze is up to date, else null. */
  frozenBuffer: (t: Track) => string | null = () => null;
  /** Set by the Freezer: brings stale freezes up to date (before a bounce). */
  beforeBounce: () => Promise<void> = async () => {};

  /** Renders one track's sources (regions, instrument notes) through the given inserts (no fader/pan). */
  async renderTrack(t: Track, inserts: Insert[], tail = 3): Promise<AudioBuffer> {
    const st = this.store, sr = this.ctx.sampleRate;
    await this.loadSampledInstruments();
    const regs = st.project.regions.filter(r => r.trackId === t.id && !r.muted);
    const endBeat = Math.max(0, ...regs.map(r => r.start + r.length));
    const off = new OfflineAudioContext(2, Math.max(1, Math.ceil((st.secAt(endBeat) + tail) * sr)), sr);
    await ensureWorklets(off);
    const head = off.createGain();
    const out = await this.offlineChain(off, inserts, head);
    out.connect(off.destination);
    if (t.instrument?.type === 'wam' && t.instrument.wam) await attachInstrument(off, head, t.instrument.wam, () => {}).catch(() => {});
    this.scheduleOffline(off, regs, t, head);
    return off.startRendering();
  }
  /** Runs a buffer through inserts offline. */
  async processThrough(buf: AudioBuffer, inserts: Insert[]): Promise<AudioBuffer> {
    const off = new OfflineAudioContext(Math.max(2, buf.numberOfChannels), buf.length, buf.sampleRate);
    await ensureWorklets(off);
    const src = off.createBufferSource(); src.buffer = buf;
    const head = off.createGain(); src.connect(head);
    (await this.offlineChain(off, inserts, head)).connect(off.destination);
    src.start(0);
    return off.startRendering();
  }
  private async offlineChain(off: OfflineAudioContext, inserts: Insert[], head: AudioNode): Promise<AudioNode> {
    let node: AudioNode = head;
    for (const ins of inserts) {
      if (ins.bypass || ins.type === 'native') continue;
      let p: PluginInstance;
      if (ins.type === 'wam' && ins.wam) { try { const w = await createWam(off, ins.wam); p = { input: w.audioNode, output: w.audioNode, set() {}, dispose() {} }; } catch { continue; } }
      else p = this.makeFx(off, ins);
      p.set(ins.params); node.connect(p.input); node = p.output;
    }
    return node;
  }
  private scheduleOffline(off: OfflineAudioContext, regs: Region[], t: Track, dest: AudioNode) {
    const st = this.store;
    for (const r of regs) {
      if (r.kind === 'midi') {
        if (!t.instrument || !r.notes) continue;
        const def = INSTRUMENTS[t.instrument.type];
        for (const n of r.notes) {
          if (n.s < 0 || n.s >= r.length) continue;
          def.play(off, dest, t.instrument.params, n.p, n.v, st.secAt(r.start + n.s), Math.max(0.02, st.secs(r.start + n.s, r.start + Math.min(n.s + n.l, r.length))), this.sampleOf(t));
        }
        continue;
      }
      for (const vr of expandRegion(st, r)) {
        const buf = st.buffers.get(vr.bufferId); if (!buf) continue;
        const s = off.createBufferSource(); s.buffer = buf;
        const env = off.createGain(); s.connect(env); env.connect(dest);
        const dur = Math.min(st.secs(vr.start, vr.start + vr.length), buf.duration - vr.offset);
        if (dur <= 0) continue;
        applyEnvelope(env.gain, vr, st, st.secAt(vr.start), 0, dur);
        s.start(st.secAt(vr.start), vr.offset, dur);
      }
    }
  }

  /** Reports plug-ins that fail to load (set by the UI). */
  onPluginError: (msg: string) => void = () => {};

  /** Builds one insert: a built-in plug-in, or a Web Audio Module (loads asynchronously, passes audio until ready). */
  makeFx(ctx: BaseAudioContext, ins: Insert): PluginInstance {
    if (ins.type === 'wam' && ins.wam) {
      const ref = ins.wam;
      return wamEffect(ctx, ref, e => this.onPluginError(`Couldn't load “${ref.name}”: ${(e as Error)?.message ?? e}`));
    }
    const def = PLUGINS[ins.type];
    if (!def) { const g = ctx.createGain(); return { input: g, output: g, set() {}, dispose() { g.disconnect(); } }; }
    return def.create(ctx);
  }

  /** Worklet-based plug-ins created before their module loaded are rebuilt once it is ready. */
  private rebuildPending() {
    const chains = [this.masterChain, ...this.strips.values()];
    for (const ch of chains) for (const [id, inst] of ch.fx) if (inst.pending) { inst.dispose(); ch.fx.delete(id); ch.sig = '?'; }
    this.syncFx();
  }

  private syncChain(ch: FxChain, inserts: Insert[], dest: AudioNode) {
    const ids = new Set(inserts.map(i => i.id));
    for (const [id, inst] of ch.fx) if (!ids.has(id)) { inst.dispose(); ch.fx.delete(id); }
    for (const ins of inserts) {
      let inst = ch.fx.get(ins.id);
      if (inst && ((inst.pending && workletsReady(this.ctx)) || ((inst as any).wamUrl && (inst as any).wamUrl !== ins.wam?.url))) { inst.dispose(); ch.fx.delete(ins.id); ch.sig = '?'; inst = undefined; }
      if (!inst) { inst = this.makeFx(this.ctx, ins); if (ins.wam) (inst as any).wamUrl = ins.wam.url; ch.fx.set(ins.id, inst); }
      inst.set(ins.params);
    }
    const sig = inserts.map(i => i.id + (i.bypass ? '~' : '')).join(',');
    if (sig === ch.sig) return;
    ch.pre.disconnect();
    for (const inst of ch.fx.values()) inst.output.disconnect();
    let node: AudioNode = ch.pre;
    for (const ins of inserts) { if (ins.bypass) continue; const inst = ch.fx.get(ins.id)!; node.connect(inst.input); node = inst.output; }
    node.connect(dest);
    ch.sig = sig;
  }

  /** Connects/disconnects Web Audio Module instruments on instrument tracks. */
  /** Loads the Sound Library samples every instrument track needs (resolves when all are in, or failed). */
  loadSampledInstruments() {
    const progs = new Set(this.store.project.tracks.filter(t => t.kind === 'inst' && t.instrument?.type === 'gm').map(t => Math.round(t.instrument!.params.program)));
    return Promise.all([...progs].map(p => loadBank(p).catch(() => null)));
  }

  private syncInstruments() {
    this.loadSampledInstruments();
    for (const t of this.store.project.tracks) {
      if (t.kind !== 'inst') continue;
      const s = this.strip(t), ref = t.instrument?.type === 'wam' ? t.instrument.wam : undefined;
      if ((ref?.url ?? '') === (s.wamUrl ?? '')) continue;
      if (s.wamUrl) detachInstrument(s.pre);
      s.wamUrl = ref?.url;
      if (ref) attachInstrument(this.ctx, s.pre, ref, e => { s.wamUrl = undefined; this.onPluginError(`Couldn't load “${ref.name}”: ${(e as Error)?.message ?? e}`); });
    }
  }
  /** The WAM instrument instance on a track (for its editor window). */
  wamInstrument(trackId: string) { const s = this.strips.get(trackId); return s ? instrumentInstance(s.pre) : undefined; }

  /** Copies every Web Audio Module's current state into the project (before saving or bouncing). */
  async captureWamStates() {
    const jobs: Promise<void>[] = [];
    const grab = (p: Promise<any> | undefined, target: { state?: unknown } | undefined) => {
      if (!p || !target) return;
      jobs.push(p.then(async i => { target.state = await i.audioNode.getState(); }).catch(() => {}));
    };
    for (const t of this.store.channels()) {
      const s = this.strips.get(t.id); if (!s) continue;
      for (const ins of t.inserts) if (ins.wam) grab((s.fx.get(ins.id) as any)?.wam, ins.wam);
      if (t.instrument?.type === 'wam') grab(instrumentInstance(s.pre), t.instrument.wam);
    }
    for (const ins of this.store.project.masterInserts) if (ins.wam) grab((this.masterChain.fx.get(ins.id) as any)?.wam, ins.wam);
    await Promise.all(jobs);
  }

  /** Sends tempo / play state to all Web Audio Modules. */
  private wamTransport(playing: boolean) {
    const st = this.store, bar = Math.floor(st.ui.playhead / st.beatsPerBar);
    const send = (p: Promise<any> | undefined) => p?.then(i => sendTransport(i.audioNode, this.ctx, st.project.tempo, st.project.sigNum, 4, playing, bar)).catch(() => {});
    for (const s of [this.masterChain, ...this.strips.values()]) for (const f of s.fx.values()) send((f as any).wam);
    for (const s of this.strips.values()) send(instrumentInstance(s.pre));
  }

  plugin(owner: string | 'master', insertId: string): PluginInstance | undefined {
    return owner === 'master' ? this.masterChain.fx.get(insertId) : this.strips.get(owner)?.fx.get(insertId);
  }

  // ---------- transport ----------
  currentBeat(): number {
    if (!this.playing) return this.store.ui.playhead;
    const now = this.ctx.currentTime;
    let seg = this.segs[0];
    for (const s of this.segs) if (s.time <= now) seg = s;
    if (!seg) return this.store.ui.playhead;
    if (now < seg.time) return seg.beat; // count-in
    return Math.max(0, this.store.beatAfter(seg.beat, now - seg.time));
  }

  async play(from = this.store.ui.playhead, countInBars = 0) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.stopSources();
    const ui = this.store.ui;
    const c = ui.cycle;
    if (c.on && (from < c.start || from >= c.end)) from = c.start;
    const spb = this.store.secs(from, from + 1), bpb = this.store.beatsPerBar;
    const pre = countInBars * bpb;
    const t0 = this.ctx.currentTime + 0.06 + pre * spb;
    for (let i = 0; i < pre; i++) this.click(t0 - (pre - i) * spb, i % bpb === 0);
    this.capture = [];
    this.playT0 = t0;
    this.segs = [{ time: t0, beat: from }];
    this.schedBeat = from; this.schedTime = t0; this.passStart = from;
    ui.playing = true; ui.playhead = from;
    this.syncMix();
    this.wamTransport(true);
    this.tick();
    if (this.timer == null) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.store.emit('transport');
  }

  stop() {
    const ui = this.store.ui;
    if (ui.recording) this.stopRecording();
    if (ui.playing) ui.playhead = this.currentBeat();
    ui.playing = false;
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
    this.stopSources();
    this.wamTransport(false);
    this.store.emit('transport');
  }

  /** Re-start playback from the current position (after edits while playing). */
  resync() { if (this.playing && !this.store.ui.recording) this.play(this.currentBeat()); }

  private stopSources() {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.env.gain.cancelScheduledValues(now);
      v.env.gain.setValueAtTime(v.env.gain.value, now);
      v.env.gain.linearRampToValueAtTime(0, now + 0.015);
      for (const s of v.src) { try { s.stop(now + 0.02); } catch { /* not started */ } }
      v.kill?.();
    }
    this.voices.clear();
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.sources.clear();
  }

  /** Reads automation at `beat` into the model and pushes it to the audio graph. */
  automate(beat = this.currentBeat()) {
    const ch = applyAutomation(this.store, beat, this.touching);
    if (ch.mix) this.store.emit('mix');
    if (ch.fx) this.store.emit('fx');
  }

  private tick() {
    this.automate();
    const ui = this.store.ui, spb = this.store.spb;
    const horizon = this.ctx.currentTime + LOOKAHEAD;
    const now = this.ctx.currentTime;
    this.segs = this.segs.filter((s, i, a) => i === a.length - 1 || a[i + 1].time > now - 1);
    // Stop when past the song end (no cycle, not recording).
    const end = Math.max(this.store.songEndBeats(), 0);
    if (!ui.cycle.on && !ui.recording && !ui.metronome && this.currentBeat() > end + 1) { this.stop(); return; }
    let guard = 0;
    while (this.schedTime < horizon && guard++ < 64) {
      const c = ui.cycle;
      const passEnd = c.on ? c.end : Infinity;
      const chunkEnd = Math.min(Math.floor(this.schedBeat) + 1, passEnd);
      this.scheduleChunk(this.schedBeat, chunkEnd, this.schedTime, this.passStart, passEnd);
      this.schedTime += this.store.secs(this.schedBeat, chunkEnd);
      this.schedBeat = chunkEnd;
      if (c.on && this.schedBeat >= c.end) {
        this.schedBeat = c.start; this.passStart = c.start;
        this.segs.push({ time: this.schedTime, beat: c.start });
      }
    }
  }

  private scheduleChunk(a: number, b: number, timeA: number, passStart: number, passEnd: number) {
    const st = this.store;
    const timeOf = (beat: number) => timeA + st.secs(a, beat);
    const frozen = new Set<string>();
    const regions: Region[] = [];
    for (const t of this.store.project.tracks) {
      const id = this.frozenBuffer(t);
      if (!id) continue;
      frozen.add(t.id);
      const buf = this.store.buffers.get(id)!;
      regions.push({ id: `frz-${t.id}`, trackId: t.id, bufferId: id, name: 'Freeze', start: 0, length: st.beatAfter(0, buf.duration), offset: 0, muted: false, freeze: true } as Region);
    }
    for (const r of this.store.project.regions) if (!frozen.has(r.trackId)) regions.push(r);
    for (const r of regions) {
      if (r.muted) continue;
      const rEnd = r.start + r.length;
      if (r.kind === 'midi') {
        const t = this.store.track(r.trackId);
        if (!t?.instrument || !r.notes) continue;
        const def = INSTRUMENTS[t.instrument.type];
        for (const n of r.notes) {
          if (n.s < 0 || n.s >= r.length) continue;
          const abs = r.start + n.s;
          if (abs < a || abs >= b || abs < passStart || abs >= passEnd) continue;
          const end = Math.min(abs + n.l, rEnd, passEnd);
          const when = timeOf(abs);
          if (when < this.ctx.currentTime - 0.01) continue;
          const v = def.play(this.ctx, this.strip(t).pre, t.instrument.params, n.p, n.v, Math.max(when, this.ctx.currentTime), Math.max(0.02, st.secs(abs, end)), this.sampleOf(t));
          this.trackVoice(v);
        }
        continue;
      }
      for (const vr of expandRegion(st, r)) {
        const vEnd = vr.start + vr.length;
        const rs = Math.max(vr.start, passStart);
        if (rs < a || rs >= b || rs >= vEnd || rs >= passEnd) continue;
        const buf = this.store.buffers.get(vr.bufferId);
        const t = this.store.track(vr.trackId);
        if (!buf || !t) continue;
        const offset = vr.offset + st.secs(vr.start, rs);
        const dur = st.secs(rs, Math.min(vEnd, passEnd));
        if (offset >= buf.duration || dur <= 0) continue;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        // short fades avoid clicks at cut points
        const env = this.ctx.createGain();
        const when = Math.max(timeOf(rs), this.ctx.currentTime);
        const lateBy = when - timeOf(rs);
        const playDur = Math.max(0.005, Math.min(dur - lateBy, buf.duration - offset - lateBy));
        applyEnvelope(env.gain, vr, st, when, st.secs(vr.start, rs) + lateBy, playDur);
        src.connect(env); env.connect((r as any).freeze ? this.strip(t).input : this.strip(t).pre); // a freeze file already has the plug-ins in it
        src.start(when, offset + lateBy, playDur);
        src.onended = () => { this.sources.delete(src); env.disconnect(); };
        this.sources.add(src);
      }
    }
    if (this.store.ui.metronome || this.store.ui.recording) {
      for (let beat = Math.ceil(a - 1e-9); beat < b; beat++) this.click(timeOf(beat), beat % this.store.beatsPerBar === 0);
    }
  }

  private click(when: number, accent: boolean) {
    if (when < this.ctx.currentTime) return;
    const gp = generalPrefs(), level = 0.5 * gp.clickLevel / 100;
    if (level <= 0) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    let len = 0.05;
    if (gp.clickSound === 'wood') { o.type = 'triangle'; o.frequency.value = accent ? 1200 : 900; len = 0.035; }
    else if (gp.clickSound === 'hihat') { o.type = 'square'; o.frequency.value = accent ? 7800 : 6400; len = 0.03; }
    else o.frequency.value = accent ? 1760 : 1320;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * (accent ? 1 : 0.8)), when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + len);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(when); o.stop(when + len + 0.01);
    this.sources.add(o);
    o.onended = () => { this.sources.delete(o); g.disconnect(); };
  }

  private trackVoice(v: Voice) {
    this.voices.add(v);
    const last = v.src[v.src.length - 1];
    if (last) { const prev = last.onended; last.onended = (e) => { this.voices.delete(v); (prev as any)?.call(last, e); }; }
  }

  // ---------- live notes (musical typing, piano roll audition) ----------
  noteOn(trackId: string, pitch: number, vel: number) {
    const t = this.store.track(trackId);
    if (!t?.instrument) return;
    if (this.ctx.state !== 'running') this.ctx.resume();
    this.noteOff(trackId, pitch);
    const v = INSTRUMENTS[t.instrument.type].play(this.ctx, this.strip(t).pre, t.instrument.params, pitch, vel, this.ctx.currentTime + 0.005, undefined, this.sampleOf(t));
    this.live.set(`${trackId}:${pitch}`, v);
    if (this.playing && !this.store.ui.recording) this.capture.push({ trackId, p: pitch, b: this.currentBeat(), l: 0.1, v: vel, open: true });
    if (this.midiRec && this.midiRec.trackId === trackId && this.store.ui.recording) {
      const n: Note = { p: pitch, s: this.currentBeat() - this.midiRec.start, l: 0.1, v: vel };
      this.midiRec.held.set(pitch, n); this.midiRec.notes.push(n);
    }
  }
  noteOff(trackId: string, pitch: number) {
    const key = `${trackId}:${pitch}`;
    const v = this.live.get(key);
    if (v) { v.release(this.ctx.currentTime); this.live.delete(key); }
    const cap = [...this.capture].reverse().find(c => c.open && c.trackId === trackId && c.p === pitch);
    if (cap) { cap.open = false; cap.l = Math.max(0.05, this.currentBeat() - cap.b); }
    const rec = this.midiRec;
    if (rec && rec.trackId === trackId) {
      const n = rec.held.get(pitch);
      if (n) { n.l = Math.max(0.05, this.currentBeat() - rec.start - n.s); rec.held.delete(pitch); }
    }
  }
  /** One-shot preview of a note (piano roll clicks). */
  audition(trackId: string, pitch: number, vel = 100, secs = 0.35) {
    const t = this.store.track(trackId);
    if (!t?.instrument) return;
    if (this.ctx.state !== 'running') this.ctx.resume();
    INSTRUMENTS[t.instrument.type].play(this.ctx, this.strip(t).pre, t.instrument.params, pitch, vel, this.ctx.currentTime + 0.005, secs, this.sampleOf(t));
  }

  // ---------- input monitoring ----------
  async syncMonitor(): Promise<string | null> {
    const want = this.store.project.tracks.filter(t => t.monitor && t.kind === 'audio');
    for (const [id, g] of this.monGains) if (!want.some(t => t.id === id)) { g.disconnect(); this.monGains.delete(id); }
    if (!want.length) return null;
    let mic: MediaStream;
    try { mic = await this.getMic(); } catch { for (const t of want) t.monitor = false; this.store.emit('structure'); return this.micError(); }
    if (!this.monSrc || this.monSrc.mediaStream !== mic) { this.monSrc?.disconnect(); this.monSrc = this.ctx.createMediaStreamSource(mic); this.monGains.forEach(g => g.disconnect()); this.monGains.clear(); }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    for (const t of want) {
      if (this.monGains.has(t.id)) continue;
      const g = this.ctx.createGain(); this.monSrc.connect(g); g.connect(this.strip(t).pre); this.monGains.set(t.id, g);
    }
    return null;
  }

  // ---------- meters ----------
  private peak(a: AnalyserNode) {
    a.getFloatTimeDomainData(this.meterBuf);
    let m = 0;
    for (let i = 0; i < this.meterBuf.length; i++) { const v = Math.abs(this.meterBuf[i]); if (v > m) m = v; }
    return m;
  }
  levels(trackId: string | 'master'): [number, number] {
    if (trackId === 'master') return [this.peak(this.masterAL), this.peak(this.masterAR)];
    const s = this.strips.get(trackId);
    return s ? [this.peak(s.aL), this.peak(s.aR)] : [0, 0];
  }

  // ---------- recording ----------
  /** Microphone stream for the chosen input (cached per device). */
  async getMic(): Promise<MediaStream> {
    const dev = this.store.ui.inputDeviceId ?? 'default';
    let st = this.mics.get(dev);
    if (st && st.getAudioTracks().some(t => t.readyState === 'live')) return st;
    // iOS: let the app record and play at the same time (otherwise the input mutes playback)
    try { const as = (navigator as any).audioSession; if (as) as.type = 'play-and-record'; } catch { /* not iOS */ }
    st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.store.ui.inputDeviceId ? { exact: this.store.ui.inputDeviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.mics.set(dev, st);
    return st;
  }
  micError() { return window.self !== window.top ? 'The microphone is blocked in this viewer. Open the standalone file in your browser to record.' : 'Microphone access was blocked. Allow it in your browser and try again.'; }

  async startRecording(): Promise<string | null> {
    const store = this.store, ui = store.ui;
    const track = store.track(ui.selectedTrackId) ?? store.project.tracks.find(t => t.armed);
    if (!track) return 'Add a track to record on.';
    if (track.kind === 'aux' || track.kind === 'folder') return 'Select an audio or instrument track to record on.';
    const c = ui.cycle;
    const start = c.on ? c.start : ui.playhead;
    this.recPunch = ui.punch.on && ui.punch.end > ui.punch.start ? { start: ui.punch.start, end: ui.punch.end } : null;
    if (track.kind === 'inst') {
      if (!track.armed) { track.armed = true; store.emit('structure'); }
      this.midiRec = { trackId: track.id, start, notes: [], held: new Map() };
      ui.recording = true;
      await this.play(start, ui.countIn);
      store.emit('transport');
      return null;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'Recording is not supported in this browser.';
    let mic: MediaStream;
    try { mic = await this.getMic(); } catch { return this.micError(); }
    if (!track.armed) { track.armed = true; store.emit('structure'); }
    this.recTrackId = track.id;
    this.recChunks = [];
    this.recorder = new MediaRecorder(mic);
    this.recorder.ondataavailable = e => { if (e.data.size) this.recChunks.push(e.data); };
    this.recorder.onstop = () => this.finishRecording();
    ui.recording = true;
    this.recStartBeat = start;
    this.recCycle = c.on ? { ...c } : null;
    await this.play(start, ui.countIn);
    this.recCtxStart = this.ctx.currentTime;
    this.recorder.start();
    store.emit('transport');
    return null;
  }


  private stopRecording() {
    this.store.ui.recording = false;
    if (this.midiRec) { this.finishMidiRecording(); return; }
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  private async finishRecording() {
    const store = this.store;
    const blob = new Blob(this.recChunks, { type: this.recorder?.mimeType || 'audio/webm' });
    let buf: AudioBuffer;
    try { buf = await this.ctx.decodeAudioData(await blob.arrayBuffer()); }
    catch { window.dispatchEvent(new CustomEvent('daw-toast', { detail: 'The recording could not be decoded.' })); return; }
    const t = store.track(this.recTrackId);
    if (!t) return;
    // where the transport start sits in the file: count-in + device latency + the user's compensation
    const auto = (this.ctx.baseLatency || 0) + ((this.ctx as any).outputLatency || 0);
    const latency = Math.max(0, Math.min(buf.duration * 0.9, (this.playT0 - this.recCtxStart) + auto + store.ui.latencyMs / 1000));
    store.checkpoint();
    const made = placeRecording(store, t.id, store.addBuffer(buf), buf.duration, latency, this.recStartBeat, this.recCycle, this.recPunch);
    if (!made) { store.emit('structure'); window.dispatchEvent(new CustomEvent('daw-toast', { detail: 'Nothing was recorded inside the punch range' })); return; }
    store.ui.selectedRegionIds = new Set([made.id]);
    store.emit('structure');
    if (made.takes && made.takes.length > 1) window.dispatchEvent(new CustomEvent('daw-toast', { detail: `Take folder: ${made.takes.length} takes. Double-click to comp.` }));
  }


  private finishMidiRecording() {
    const rec = this.midiRec!; this.midiRec = null;
    const store = this.store;
    const nowBeat = this.currentBeat();
    for (const n of rec.held.values()) n.l = Math.max(0.05, nowBeat - rec.start - n.s);
    const c = store.ui.cycle;
    // With cycle on, positions wrapped by the transport are already inside the cycle.
    let notes = rec.notes.filter(n => n.s >= -0.02).map(n => ({ ...n, s: Math.max(0, n.s) }));
    const pu = this.recPunch;
    if (pu) {
      notes = notes.filter(n => rec.start + n.s >= pu.start && rec.start + n.s < pu.end).map(n => ({ ...n, s: rec.start + n.s - pu.start, l: Math.min(n.l, pu.end - rec.start - n.s) }));
      rec.start = pu.start;
    }
    if (!notes.length) return;
    const bpb = store.beatsPerBar;
    const last = Math.max(...notes.map(n => n.s + n.l));
    const length = pu ? pu.end - pu.start : c.on ? c.end - c.start : Math.max(bpb, Math.ceil(last / bpb) * bpb);
    const t = store.track(rec.trackId); if (!t) return;
    store.checkpoint();
    const take = store.project.regions.filter(r => r.trackId === t.id).length + 1;
    const r: Region = { id: uid('r'), kind: 'midi', notes, trackId: t.id, bufferId: '', name: `${t.name}#${String(take).padStart(2, '0')}`, start: rec.start, length, offset: 0, muted: false };
    store.project.regions.push(r);
    store.ui.selectedRegionIds = new Set([r.id]);
    store.emit('structure');
  }

  // ---------- import ----------
  async decodeFile(file: File): Promise<AudioBuffer> {
    return await this.ctx.decodeAudioData(await file.arrayBuffer());
  }

  // ---------- bounce ----------
  async bounce(): Promise<Blob> {
    this.flushFlex();
    await this.loadSampledInstruments();
    await this.beforeBounce();
    const store = this.store, spb = store.spb;
    const endBeats = store.songEndBeats();
    const bp = audioPrefs();
    const sr = bp.bounceRate || 44100;
    const live = [...store.project.masterInserts, ...store.channels().flatMap(t => t.inserts)].filter(i => !i.bypass);
    const fxTail = Math.max(0, ...live.map(i => i.type === 'space' ? i.params.decay * 1.2 : i.type === 'reverb' ? i.params.decay : (i.type === 'delay' || i.type === 'sdelay' || i.type === 'wam') ? 3 : 0));
    const tail = bp.bounceTail + fxTail;
    const len = Math.max(1, Math.ceil((store.secAt(endBeats) + tail) * sr));
    const off = new OfflineAudioContext(2, len, sr);
    // plug-ins that load asynchronously (worklets, Web Audio Modules) must be ready before rendering starts
    await ensureWorklets(off);
    await this.captureWamStates();
    const preFx = new Map<string, PluginInstance>();
    const allInserts = [...store.project.masterInserts, ...store.channels().flatMap(t => t.inserts)];
    for (const i of allInserts) {
      if (i.bypass || i.type !== 'wam' || !i.wam) continue;
      try { const w = await createWam(off, i.wam); const node = w.audioNode as AudioNode; preFx.set(i.id, { input: node, output: node, set() {}, dispose() {} }); }
      catch (e) { this.onPluginError(`“${i.wam.name}” was skipped in the bounce: ${(e as Error)?.message ?? e}`); }
    }
    const master = off.createGain(); master.gain.value = dbToGain(store.project.masterVolume); master.connect(off.destination);
    const fxInst = new Map<string, PluginInstance>();
    const chain = (inserts: Insert[], dest: AudioNode): AudioNode => {
      const head = off.createGain(); let node: AudioNode = head;
      for (const ins of inserts) { if (ins.bypass) continue; if (ins.type === 'wam' && !preFx.has(ins.id)) continue; const p = preFx.get(ins.id) ?? this.makeFx(off, ins); p.set(ins.params); fxInst.set(ins.id, p); node.connect(p.input); node = p.output; }
      node.connect(dest); return head;
    };
    const handles = new Map<string, { g: GainNode; p: StereoPannerNode; sends: Map<string, GainNode> }>();
    const masterIn = chain(store.project.masterInserts, master);
    const ins = new Map<string, GainNode>();
    const auxIn = new Map<number, AudioNode>();
    const folderIn = new Map<string, AudioNode>();
    const channel = (t: Track) => {
      const g = off.createGain(); const p = off.createStereoPanner();
      const audible = audibleBySolo(store, t);
      g.gain.value = audible ? dbToGain(t.volume) : 0; p.pan.value = t.pan;
      g.connect(p); p.connect((t.parent && folderIn.get(t.parent)) || masterIn);
      handles.set(t.id, { g, p, sends: new Map() });
      return { head: chain(t.inserts, g) as GainNode, post: g };
    };
    for (const a of store.project.auxes) { const c = channel(a); auxIn.set(a.bus!, c.head); }
    for (const t of store.project.tracks.filter(x => x.kind === 'folder')) { const c = channel(t); ins.set(t.id, c.head); folderIn.set(t.id, c.head); }
    for (const t of store.project.tracks.filter(x => x.kind !== 'folder')) {
      const c = channel(t); ins.set(t.id, c.head);
      for (const sd of t.sends ?? []) { const dest = auxIn.get(sd.bus); if (!dest) continue; const sg = off.createGain(); sg.gain.value = dbToGain(sd.level); c.post.connect(sg); sg.connect(dest); handles.get(t.id)!.sends.set(sd.id, sg); }
    }
    for (const t of store.project.tracks) {
      if (t.kind !== 'inst' || t.instrument?.type !== 'wam' || !t.instrument.wam) continue;
      const g = ins.get(t.id); if (!g) continue;
      const ref = t.instrument.wam;
      try { await attachInstrument(off, g, ref, () => {}); } catch (e) { this.onPluginError(`“${ref.name}” was skipped in the bounce: ${(e as Error)?.message ?? e}`); }
    }
    const frozenIds = new Set<string>();
    for (const t of store.project.tracks) {
      const id = this.frozenBuffer(t), buf = id ? store.buffers.get(id) : undefined, post = handles.get(t.id)?.g;
      if (!buf || !post) continue;
      frozenIds.add(t.id);
      const s = off.createBufferSource(); s.buffer = buf; s.connect(post); s.start(0);
    }
    for (const r of store.project.regions) {
      if (frozenIds.has(r.trackId)) continue;
      if (r.kind === 'midi') {
        const t = store.track(r.trackId), g = ins.get(r.trackId);
        if (!t?.instrument || !g || r.muted || !r.notes) continue;
        const def = INSTRUMENTS[t.instrument.type];
        for (const n of r.notes) {
          if (n.s < 0 || n.s >= r.length) continue;
          const dur = store.secs(r.start + n.s, r.start + Math.min(n.s + n.l, r.length));
          def.play(off, g, t.instrument.params, n.p, n.v, store.secAt(r.start + n.s), Math.max(0.02, dur), this.sampleOf(t));
        }
        continue;
      }
      const g = ins.get(r.trackId);
      if (!g || r.muted) continue;
      for (const vr of expandRegion(store, r)) {
        const buf = store.buffers.get(vr.bufferId); if (!buf) continue;
        const s = off.createBufferSource(); s.buffer = buf;
        const env = off.createGain(); s.connect(env); env.connect(g);
        const dur = Math.min(store.secs(vr.start, vr.start + vr.length), buf.duration - vr.offset);
        if (dur <= 0) continue;
        applyEnvelope(env.gain, vr, store, store.secAt(vr.start), 0, dur);
        s.start(store.secAt(vr.start), vr.offset, dur);
      }
    }
    // Automation: evaluate the curves every 20 ms of rendered audio.
    const autoTracks = store.project.tracks.filter(t => autoActive(t) && Object.values(t.auto!).some(p => p.length));
    if (autoTracks.length) {
      const applyAt = (sec: number) => {
        const beat = store.beatAtSec(sec);
        for (const t of autoTracks) {
          const hd = handles.get(t.id)!;
          const audible = audibleBySolo(store, t);
          const params = autoParams(store, t);
          const fxTouched = new Set<string>();
          for (const [key, pts] of Object.entries(t.auto!)) {
            const v = valueAt(pts, beat); if (v == null) continue;
            if (key === 'volume') hd.g.gain.value = audible ? dbToGain(v) : 0;
            else if (key === 'pan') hd.p.pan.value = v;
            else if (key.startsWith('send:')) { const sg = hd.sends.get(key.slice(5)); if (sg) sg.gain.value = dbToGain(v); }
            else if (key.startsWith('fx:')) fxTouched.add(key.split(':')[1]);
          }
          for (const insId of fxTouched) {
            const ins = t.inserts.find(i => i.id === insId), inst = fxInst.get(insId);
            if (!ins || !inst) continue;
            const pr = { ...ins.params };
            for (const p of params) if (p.key.startsWith(`fx:${insId}:`) && t.auto![p.key]?.length) pr[p.key.split(':')[2]] = valueAt(t.auto![p.key], beat)!;
            inst.set(pr);
          }
        }
      };
      applyAt(0);
      const step = 0.02;
      for (let sec = step; sec < len / sr; sec += step) {
        const at = sec;
        off.suspend(at).then(() => { applyAt(at); off.resume(); }).catch(() => {});
      }
    }
    const out = await off.startRendering();
    if (bp.normalize) {
      let peak = 0;
      for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
      if (peak > 1e-6) { const g = Math.pow(10, -1 / 20) / peak; for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; } }
    }
    return encodeWav(out, bp.bounceBits);
  }
}

/** Solo rules: aux channels are solo-safe; a soloed stack lets its children through; a soloed child keeps its stack open. */
export function audibleBySolo(store: Store, t: Track) {
  if (t.mute) return false;
  if (t.kind === 'aux') return true;
  const tracks = store.project.tracks;
  if (!tracks.some(x => x.solo)) return true;
  if (t.solo) return true;
  if (t.parent && store.track(t.parent)?.solo) return true;
  if (t.kind === 'folder' && tracks.some(x => x.parent === t.id && x.solo)) return true;
  return false;
}

/**
 * Region volume envelope: region gain plus fade-in/out (beats), with 4 ms anti-click ramps.
 * `from` = seconds into the region where playback starts, `dur` = seconds that will play.
 */
export function applyEnvelope(p: AudioParam, r: Region, st: Store, when: number, from: number, dur: number) {
  const g = dbToGain(r.gain ?? 0);
  const rEnd = r.start + r.length;
  const len = st.secs(r.start, rEnd), fi = st.secs(r.start, r.start + (r.fadeIn ?? 0)), fo = st.secs(rEnd - (r.fadeOut ?? 0), rEnd);
  const level = (t: number) => {
    let v = g;
    if (fi > 0 && t < fi) v *= Math.max(0, t / fi);
    if (fo > 0 && t > len - fo) v *= Math.max(0, (len - t) / fo);
    return v;
  };
  const end = from + dur;
  const pts = new Set<number>([from, end]);
  if (fi > 0 && fi > from && fi < end) pts.add(fi);
  if (fo > 0 && len - fo > from && len - fo < end) pts.add(len - fo);
  const times = [...pts].sort((x, y) => x - y);
  const click = 0.004;
  p.setValueAtTime(0, when);
  p.linearRampToValueAtTime(level(Math.min(end, from + click)), when + Math.min(dur, click));
  for (const t of times) if (t > from + click && t < end - click) p.linearRampToValueAtTime(level(t), when + (t - from));
  if (dur > 2 * click) p.linearRampToValueAtTime(level(end - click), when + dur - click);
  p.linearRampToValueAtTime(0, when + dur);
}

/** WAV file from an AudioBuffer: 16/24-bit PCM or 32-bit float. */
export function encodeWav(buf: AudioBuffer, bits: 16 | 24 | 32 = 16): Blob {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate, bps = bits / 8, float = bits === 32;
  const dataLen = len * ch * bps;
  const data = new DataView(new ArrayBuffer(44 + dataLen));
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); data.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, float ? 3 : 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * bps, true); data.setUint16(32, ch * bps, true); data.setUint16(34, bits, true);
  w(36, 'data'); data.setUint32(40, dataLen, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    if (float) data.setFloat32(o, v, true);
    else if (bits === 24) { const x = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff); data.setUint8(o, x & 0xff); data.setUint8(o + 1, (x >> 8) & 0xff); data.setUint8(o + 2, (x >> 16) & 0xff); }
    else data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    o += bps;
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}

/**
 * Places a finished audio recording, Logic-style:
 * - cycle recording: every pass becomes a take of one take folder (the last full pass is active);
 * - recording over a region that starts at the same position: the new take joins it as a take folder;
 * - otherwise: a plain region.
 */
export function placeRecording(store: Store, trackId: string, bufferId: string, duration: number, latency: number, startBeat: number, cycle: { start: number; end: number } | null, punch: { start: number; end: number } | null = null): Region | null {
  const t = store.track(trackId)!;
  const n = store.project.regions.filter(r => r.trackId === trackId).length + 1;
  const name = `${t.name}#${String(n).padStart(2, '0')}`;
  if (cycle) {
    const cyc = store.secs(cycle.start, cycle.end);
    const total = duration - latency;
    let passes = Math.floor(total / cyc + 1e-6);
    if (total - passes * cyc > cyc * 0.25) passes++; // keep a partial last pass if it is long enough
    passes = Math.max(1, passes);
    if (passes > 1) {
      const takes = Array.from({ length: passes }, (_, i) => ({ id: uid('tk'), bufferId, offset: latency + i * cyc, name: `Take ${i + 1}` }));
      const full = Math.max(0, Math.floor(total / cyc + 1e-6) - 1);
      const r: Region = { id: uid('r'), trackId, bufferId: '', name: `${t.name}: Take Folder`, start: cycle.start, length: cycle.end - cycle.start, offset: 0, muted: false, takes, comp: [{ s: 0, e: cycle.end - cycle.start, take: takes[Math.min(full, takes.length - 1)].id }] };
      if (punch && !clipRegion(store, r, punch.start, punch.end)) return null;
      store.project.regions.push(r);
      return r;
    }
  }
  const plain: Region = { id: uid('r'), trackId, bufferId, name, start: startBeat, length: Math.max(0.25, store.beatAfter(startBeat, duration - latency) - startBeat), offset: latency, muted: false };
  if (punch && !clipRegion(store, plain, punch.start, punch.end)) return null;
  // recording over existing audio makes (or extends) a take folder; the new take is active where it was recorded
  const existing = store.project.regions.find(r => r.trackId === trackId && r.kind !== 'midi' && r.start < plain.start + plain.length - 1e-6 && r.start + r.length > plain.start + 1e-6);
  if (existing) {
    const oldComp = existing.takes?.length ? compOf(existing) : null;
    const folder = packTakes(store, [existing, plain].sort((a, b) => a.start - b.start));
    const newest = folder.takes!.find(t => t.bufferId === bufferId && Math.abs(t.offset - (plain.offset - store.secs(folder.start, plain.start))) < 1e-6) ?? folder.takes![folder.takes!.length - 1];
    const others = folder.takes!.filter(t => t !== newest);
    // previous comp (or the old take) keeps playing outside the new recording
    if (oldComp) folder.comp = oldComp.map(sg => { const i = existing.takes!.findIndex(t => t.id === sg.take); const shift = existing.start - folder.start; return { s: sg.s + shift, e: sg.e + shift, take: others[i]?.id ?? others[0].id }; });
    else folder.comp = [{ s: existing.start - folder.start, e: existing.start + existing.length - folder.start, take: others[0].id }];
    setComp(folder, plain.start - folder.start, plain.start + plain.length - folder.start, newest.id);
    store.project.regions = store.project.regions.filter(r => r !== existing).concat(folder);
    return folder;
  }
  store.project.regions.push(plain);
  return plain;
}

/** Trims a region (plain or take folder) to [a, b). Returns false if nothing is left. */
export function clipRegion(store: Store, r: Region, a: number, b: number) {
  const s = Math.max(r.start, a), e = Math.min(r.start + r.length, b);
  if (e - s < 1e-3) return false;
  if (r.takes?.length) trimFolderStart(store, r, r.start, r.takes.map(t => ({ ...t })), compOf(r).map(c => ({ ...c })), s);
  else r.offset += store.secs(r.start, s);
  r.length = e - s; r.start = s;
  return true;
}
