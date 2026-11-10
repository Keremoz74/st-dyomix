// Synthesizes a short demo song (A minor, 120 BPM) so the project has sound on first open.
import { Store, uid, Insert } from '../model';
import { PluginType, defaultParams } from './plugins';
import { newInstrument } from './instruments';
import { Note } from '../model';

const fx = (type: PluginType, p: Record<string, number> = {}): Insert => ({ id: uid('fx'), type, bypass: false, params: { ...defaultParams(type), ...p } });

const BPM = 120, SPB = 60 / BPM, BARS = 8, SR = 44100;
const LEN = BARS * 4 * SPB;
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function noiseBuffer(ctx: BaseAudioContext, secs: number) {
  const b = ctx.createBuffer(1, Math.ceil(secs * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = (s / 0x3fffffff) - 1; }
  return b;
}

async function renderDrums() {
  const ctx = new OfflineAudioContext(2, Math.ceil(LEN * SR), SR);
  const out = ctx.createGain(); out.gain.value = 0.9; out.connect(ctx.destination);
  const noise = noiseBuffer(ctx, 1);
  for (let bar = 0; bar < BARS; bar++) for (let step = 0; step < 16; step++) {
    const t = (bar * 16 + step) * SPB / 4;
    if (step === 0 || step === 8 || step === 10 || (bar % 2 === 1 && step === 14)) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.4);
    }
    if (step === 4 || step === 12) {
      const n = ctx.createBufferSource(); n.buffer = noise;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      n.connect(bp); bp.connect(g); g.connect(out); n.start(t, 0, 0.2);
      const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 190;
      og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(og); og.connect(out); o.start(t); o.stop(t + 0.1);
    }
    if (step % 2 === 0) {
      const n = ctx.createBufferSource(); n.buffer = noise;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
      const p = ctx.createStereoPanner(); p.pan.value = 0.3;
      const g = ctx.createGain(); const v = step % 4 === 2 ? 0.28 : 0.16;
      g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      n.connect(hp); hp.connect(g); g.connect(p); p.connect(out); n.start(t, 0.3, 0.06);
    }
  }
  return ctx.startRendering();
}

async function renderBass() {
  const ctx = new OfflineAudioContext(2, Math.ceil(LEN * SR), SR);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 4;
  const out = ctx.createGain(); out.gain.value = 0.32; lp.connect(out); out.connect(ctx.destination);
  for (let bar = 0; bar < BARS; bar++) for (let e = 0; e < 8; e++) {
    const t = (bar * 8 + e) * SPB / 2;
    const root = PROG[bar % 4][0] - 24 + (e === 3 || e === 7 ? 12 : 0);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(root);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.005); g.gain.exponentialRampToValueAtTime(0.25, t + 0.2); g.gain.linearRampToValueAtTime(0, t + SPB / 2 - 0.01);
    o.connect(g); g.connect(lp); o.start(t); o.stop(t + SPB / 2);
  }
  return ctx.startRendering();
}

export async function loadDemo(store: Store) {
  const [drums, bass] = await Promise.all([renderDrums(), renderBass()]);
  const p = store.project;
  p.name = 'Demo Song'; p.id = p.id ?? uid('p'); p.tempo = BPM; p.tracks = []; p.regions = []; p.auxes = []; p.tempoEvents = []; p.movie = undefined;
  p.markers = [{ id: uid('m'), b: 0, name: 'Intro' }, { id: uid('m'), b: 16, name: 'Verse' }, { id: uid('m'), b: 32, name: 'Chorus' }, { id: uid('m'), b: 48, name: 'Chorus 2' }];
  const add = (name: string, buf: AudioBuffer, starts: number[], vol: number, pan = 0) => {
    const t = store.addTrack(name, false); t.volume = vol; t.pan = pan;
    const id = store.addBuffer(buf);
    starts.forEach((s, i) => p.regions.push({ id: uid('r'), trackId: t.id, bufferId: id, name: `${name}${starts.length > 1 ? ` ${i + 1}` : ''}`, start: s, length: BARS * 4, offset: 0, muted: false }));
    return t;
  };
  const first = add('Drums', drums, [0, 32], -5);
  first.inserts = [fx('eq', { hpf: 30, lowGain: 3, highGain: 2.5 }), fx('comp', { threshold: -20, ratio: 3, attack: 8, makeup: 3 })];
  add('Bass', bass, [0, 32], -7).inserts = [fx('eq', { hpf: 35, midGain: -3, midFreq: 400 })];
  const midi = (name: string, preset: string, vol: number, pan: number, regions: { start: number; length: number; notes: Note[] }[]) => {
    const t = store.addTrack(name, false, 'inst', newInstrument('synth', preset)); t.volume = vol; t.pan = pan;
    regions.forEach((r, i) => p.regions.push({ id: uid('r'), kind: 'midi', notes: r.notes, trackId: t.id, bufferId: '', name: `${name}${regions.length > 1 ? ` ${i + 1}` : ''}`, start: r.start, length: r.length, offset: 0, muted: false }));
    return t;
  };
  const chords: Note[] = [];
  for (let bar = 0; bar < BARS; bar++) for (const half of [0, 2]) PROG[bar % 4].forEach(m => chords.push({ p: m, s: bar * 4 + half, l: 1.9, v: half ? 78 : 92 }));
  const MEL = [[69, 72, 71, 69], [69, 67, 65, 67], [67, 69, 72, 74], [71, 67, 66, 67]];
  const melody: Note[] = [];
  for (let bar = 0; bar < BARS; bar++) MEL[bar % 4].forEach((m, i) => melody.push({ p: m + (bar >= 4 ? 12 : 0), s: bar * 4 + i, l: 0.85, v: 100 + (i % 2 ? -8 : 6) }));
  const verb = store.addAux('Reverb Bus');
  verb.inserts = [fx('reverb', { decay: 2.8, mix: 100, predelay: 25 })];
  verb.volume = -6;
  const keysT = midi('Keys', 'Electric Piano', -7, -0.1, [{ start: 0, length: 32, notes: chords }, { start: 32, length: 32, notes: chords.map(n => ({ ...n })) }]);
  keysT.sends = [{ id: uid('s'), bus: verb.bus!, level: -10 }];
  const leadT = midi('Lead Synth', 'Lead', -12, 0.15, [{ start: 32, length: 32, notes: melody }]);
  leadT.inserts = [fx('delay')];
  leadT.sends = [{ id: uid('s'), bus: verb.bus!, level: -8 }];
  first.sends = [{ id: uid('s'), bus: verb.bus!, level: -22 }];
  p.masterInserts = [];
  store.addTrack('Vocal', false);
  store.ui.selectedTrackId = first.id;
  store.ui.cycle = { on: false, start: 32, end: 48 };
}
