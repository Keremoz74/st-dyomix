// Software instruments: a polyphonic subtractive synth (with presets) and a GM-mapped drum kit.
// Notes can be scheduled with a known duration (playback/bounce) or held live (musical typing).
import { ParamDef } from './plugins';

import { playWamNote, WamRef } from './wam';

export type InstType = 'synth' | 'drums' | 'sampler' | 'wam';

export interface InstrumentState { type: InstType; preset: string; params: Record<string, number>; bufferId?: string; sampleName?: string; wam?: WamRef }

export interface Voice { src: AudioScheduledSourceNode[]; env: GainNode; release(at: number): void; kill?(): void }

export interface InstDef {
  type: InstType;
  name: string;
  params: ParamDef[];
  presets: Record<string, Record<string, number>>;
  /** dur = seconds the key is held; omit for a live note (call release later). `sample` = the Sampler's audio. */
  play(ctx: BaseAudioContext, dest: AudioNode, p: Record<string, number>, pitch: number, vel: number, when: number, dur?: number, sample?: AudioBuffer): Voice;
}

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const WAVES: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];
export const WAVE_NAMES = ['Saw', 'Square', 'Triangle', 'Sine'];

// ---------------- synth ----------------
const SYNTH_PARAMS: ParamDef[] = [
  { id: 'osc1', label: 'Osc 1', min: 0, max: 3, def: 0, unit: 'wave', step: 1 },
  { id: 'osc2', label: 'Osc 2', min: 0, max: 3, def: 1, unit: 'wave', step: 1 },
  { id: 'semi', label: 'Osc 2 Pitch', min: -24, max: 24, def: 0, unit: 'st', step: 1 },
  { id: 'detune', label: 'Detune', min: 0, max: 50, def: 8, unit: 'ct', step: 1 },
  { id: 'mix', label: 'Osc Mix', min: 0, max: 100, def: 50, unit: '%' },
  { id: 'cutoff', label: 'Cutoff', min: 60, max: 18000, def: 2400, unit: 'Hz', log: true },
  { id: 'reso', label: 'Resonance', min: 0, max: 20, def: 2, unit: '', step: 0.1 },
  { id: 'envAmt', label: 'Filter Env', min: 0, max: 100, def: 40, unit: '%' },
  { id: 'attack', label: 'Attack', min: 1, max: 3000, def: 5, unit: 'ms', log: true },
  { id: 'decay', label: 'Decay', min: 10, max: 4000, def: 400, unit: 'ms', log: true },
  { id: 'sustain', label: 'Sustain', min: 0, max: 100, def: 60, unit: '%' },
  { id: 'release', label: 'Release', min: 5, max: 5000, def: 250, unit: 'ms', log: true },
];
const sp = (o: Record<string, number>) => ({ ...Object.fromEntries(SYNTH_PARAMS.map(p => [p.id, p.def])), ...o });

const SYNTH: InstDef = {
  type: 'synth', name: 'Studio Synth', params: SYNTH_PARAMS,
  presets: {
    'Electric Piano': sp({ osc1: 3, osc2: 2, semi: 12, detune: 4, mix: 30, cutoff: 3500, reso: 0, envAmt: 30, attack: 2, decay: 900, sustain: 25, release: 400 }),
    'Analog Pad': sp({ osc1: 0, osc2: 0, semi: 0, detune: 18, mix: 50, cutoff: 1400, reso: 1.5, envAmt: 20, attack: 600, decay: 1200, sustain: 80, release: 1500 }),
    'Synth Bass': sp({ osc1: 0, osc2: 1, semi: -12, detune: 5, mix: 40, cutoff: 500, reso: 6, envAmt: 55, attack: 2, decay: 220, sustain: 40, release: 80 }),
    'Lead': sp({ osc1: 1, osc2: 0, semi: 0, detune: 12, mix: 50, cutoff: 2600, reso: 4, envAmt: 35, attack: 8, decay: 300, sustain: 70, release: 200 }),
    'Pluck': sp({ osc1: 0, osc2: 2, semi: 12, detune: 6, mix: 35, cutoff: 900, reso: 5, envAmt: 80, attack: 1, decay: 260, sustain: 0, release: 220 }),
    'Organ': sp({ osc1: 3, osc2: 3, semi: 12, detune: 2, mix: 45, cutoff: 6000, reso: 0, envAmt: 0, attack: 6, decay: 100, sustain: 100, release: 60 }),
  },
  play(ctx, dest, p, pitch, vel, when, dur) {
    const f = hz(pitch);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = WAVES[Math.round(p.osc1)] ?? 'sawtooth'; o2.type = WAVES[Math.round(p.osc2)] ?? 'square';
    o1.frequency.value = f; o2.frequency.value = f * Math.pow(2, Math.round(p.semi) / 12);
    o1.detune.value = -p.detune / 2; o2.detune.value = p.detune / 2;
    const g1 = ctx.createGain(), g2 = ctx.createGain();
    const m = p.mix / 100; g1.gain.value = Math.cos(m * Math.PI / 2); g2.gain.value = Math.sin(m * Math.PI / 2);
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.Q.value = p.reso;
    const env = ctx.createGain();
    o1.connect(g1); o2.connect(g2); g1.connect(flt); g2.connect(flt); flt.connect(env); env.connect(dest);
    o1.start(when); o2.start(when);

    const peak = Math.pow(vel / 127, 1.4) * 0.28;
    const A = p.attack / 1000, D = p.decay / 1000, S = p.sustain / 100, R = p.release / 1000;
    const base = p.cutoff, top = Math.min(20000, base * Math.pow(2, (p.envAmt / 100) * 5 * (0.5 + vel / 254)));
    env.gain.setValueAtTime(0, when);
    flt.frequency.setValueAtTime(top, when);
    flt.frequency.setTargetAtTime(base + (top - base) * S, when, Math.max(0.005, D / 3));

    const levelAt = (t: number) => (t < A ? peak * t / A : S * peak + (peak - S * peak) * Math.exp(-(t - A) / Math.max(0.001, D / 3)));
    const doRelease = (at: number, from: number) => {
      env.gain.setValueAtTime(from, at);
      env.gain.setTargetAtTime(0, at, Math.max(0.003, R / 4));
      flt.frequency.setTargetAtTime(base, at, Math.max(0.005, R / 4));
      const end = at + R * 1.2 + 0.02;
      o1.stop(end); o2.stop(end);
    };
    if (dur != null) {
      if (dur < A) env.gain.linearRampToValueAtTime(levelAt(dur), when + dur);
      else { env.gain.linearRampToValueAtTime(peak, when + A); env.gain.setTargetAtTime(S * peak, when + A, Math.max(0.001, D / 3)); }
      doRelease(when + dur, levelAt(dur));
    } else {
      env.gain.linearRampToValueAtTime(peak, when + A);
      env.gain.setTargetAtTime(S * peak, when + A, Math.max(0.001, D / 3));
    }
    o2.onended = () => { [o1, o2, g1, g2, flt, env].forEach(n => n.disconnect()); };
    return {
      src: [o1, o2], env,
      release(at) {
        if (dur != null) return;
        const t = Math.max(at, when);
        env.gain.cancelScheduledValues(t); flt.frequency.cancelScheduledValues(t);
        doRelease(t, levelAt(t - when));
      },
    };
  },
};

// ---------------- drum kit ----------------
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0); let s = 99991;
    for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
    noiseCache.set(ctx, b);
  }
  return b;
}

const DRUM_PARAMS: ParamDef[] = [
  { id: 'kickTune', label: 'Kick Tune', min: 30, max: 90, def: 48, unit: 'Hz', step: 1 },
  { id: 'kickDecay', label: 'Kick Decay', min: 80, max: 900, def: 350, unit: 'ms', log: true },
  { id: 'snareTone', label: 'Snare Tone', min: 120, max: 320, def: 190, unit: 'Hz', step: 1 },
  { id: 'snareSnap', label: 'Snare Snap', min: 0, max: 100, def: 65, unit: '%' },
  { id: 'hatDecay', label: 'Hat Decay', min: 20, max: 400, def: 60, unit: 'ms', log: true },
  { id: 'tomTune', label: 'Tom Tune', min: -12, max: 12, def: 0, unit: 'st', step: 1 },
  { id: 'cymbal', label: 'Cymbal', min: 200, max: 3000, def: 1200, unit: 'ms', log: true },
  { id: 'level', label: 'Kit Level', min: 0, max: 100, def: 80, unit: '%' },
];
export const DRUM_NAMES: Record<number, string> = { 36: 'Kick', 35: 'Kick 2', 37: 'Rim', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Low Tom', 42: 'Closed Hat', 43: 'Low Tom 2', 44: 'Pedal Hat', 45: 'Mid Tom', 46: 'Open Hat', 47: 'Mid Tom 2', 48: 'High Tom', 49: 'Crash', 50: 'High Tom 2', 51: 'Ride' };

const DRUMS: InstDef = {
  type: 'drums', name: 'Drum Kit', params: DRUM_PARAMS,
  presets: { 'Studio Kit': Object.fromEntries(DRUM_PARAMS.map(p => [p.id, p.def])), 'Tight Kit': { kickTune: 55, kickDecay: 200, snareTone: 230, snareSnap: 80, hatDecay: 35, tomTune: 3, cymbal: 700, level: 80 }, 'Boom Kit': { kickTune: 40, kickDecay: 800, snareTone: 160, snareSnap: 50, hatDecay: 90, tomTune: -5, cymbal: 2200, level: 80 } },
  play(ctx, dest, p, pitch, vel, when) {
    const v = Math.pow(vel / 127, 1.3) * (p.level / 100);
    const env = ctx.createGain(); env.gain.value = v; env.connect(dest);
    const src: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [env];
    const tone = (f0: number, f1: number, decay: number, amp: number, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
      o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1, when + Math.min(0.15, decay * 0.4));
      g.gain.setValueAtTime(amp, when); g.gain.exponentialRampToValueAtTime(0.0008, when + decay);
      o.connect(g); g.connect(env); o.start(when); o.stop(when + decay + 0.02); src.push(o); nodes.push(o, g);
    };
    const hiss = (type: BiquadFilterType, freq: number, q: number, decay: number, amp: number) => {
      const n = ctx.createBufferSource(); n.buffer = noise(ctx);
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.setValueAtTime(amp, when); g.gain.exponentialRampToValueAtTime(0.0008, when + decay);
      n.connect(f); f.connect(g); g.connect(env); n.start(when, Math.random() * 1.5, decay + 0.05); src.push(n); nodes.push(n, f, g);
    };
    const tomF = (base: number) => base * Math.pow(2, p.tomTune / 12);
    switch (pitch) {
      case 35: case 36: tone(p.kickTune * 3.2, p.kickTune, p.kickDecay / 1000, 1); hiss('lowpass', 3000, 0.7, 0.012, 0.25); break;
      case 37: tone(1700, 900, 0.03, 0.5, 'triangle'); hiss('bandpass', 2500, 2, 0.03, 0.3); break;
      case 38: case 40: tone(p.snareTone * 1.6, p.snareTone, 0.09, 0.55); hiss('highpass', 1200, 0.7, 0.13 + p.snareSnap / 600, 0.25 + p.snareSnap / 140); break;
      case 39: for (const d of [0, 0.011, 0.023]) { const w = when + d; const n = ctx.createBufferSource(); n.buffer = noise(ctx); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 1.2; const g = ctx.createGain(); g.gain.setValueAtTime(0.8, w); g.gain.exponentialRampToValueAtTime(0.001, w + (d === 0.023 ? 0.16 : 0.01)); n.connect(f); f.connect(g); g.connect(env); n.start(w, Math.random(), 0.2); src.push(n); nodes.push(n, f, g); } break;
      case 42: hiss('highpass', 7500, 0.8, p.hatDecay / 1000, 0.45); break;
      case 44: hiss('highpass', 7000, 0.8, p.hatDecay / 1500, 0.35); break;
      case 46: hiss('highpass', 6500, 0.8, Math.max(0.25, p.hatDecay * 5 / 1000), 0.4); break;
      case 41: case 43: tone(tomF(pitch === 41 ? 140 : 160), tomF(pitch === 41 ? 85 : 95), 0.45, 0.8); break;
      case 45: case 47: tone(tomF(pitch === 45 ? 190 : 210), tomF(pitch === 45 ? 120 : 135), 0.38, 0.75); break;
      case 48: case 50: tone(tomF(pitch === 48 ? 250 : 280), tomF(pitch === 48 ? 165 : 185), 0.32, 0.7); break;
      case 49: case 57: hiss('highpass', 5000, 0.5, p.cymbal / 1000, 0.5); hiss('bandpass', 9000, 1, p.cymbal / 1300, 0.25); break;
      case 51: case 59: hiss('bandpass', 8000, 2.5, p.cymbal / 1500, 0.35); tone(5200, 5000, p.cymbal / 2000, 0.05, 'square'); break;
      default: tone(hz(pitch), hz(pitch) * 0.6, 0.25, 0.6, 'triangle');
    }
    const last = src[src.length - 1];
    if (last) last.onended = () => nodes.forEach(n => n.disconnect());
    return { src, env, release() { /* one-shots */ } };
  },
};

// ---------------- sampler ----------------
const SAMPLER_PARAMS: ParamDef[] = [
  { id: 'root', label: 'Root Note', min: 24, max: 96, def: 60, unit: 'note', step: 1 },
  { id: 'tune', label: 'Fine Tune', min: -100, max: 100, def: 0, unit: 'ct', step: 1 },
  { id: 'start', label: 'Start', min: 0, max: 90, def: 0, unit: '%' },
  { id: 'attack', label: 'Attack', min: 1, max: 2000, def: 2, unit: 'ms', log: true },
  { id: 'release', label: 'Release', min: 5, max: 4000, def: 150, unit: 'ms', log: true },
  { id: 'loop', label: 'Loop', min: 0, max: 1, def: 0, unit: 'onoff', step: 1 },
  { id: 'cutoff', label: 'Filter', min: 200, max: 20000, def: 20000, unit: 'Hz', log: true },
  { id: 'level', label: 'Level', min: 0, max: 100, def: 80, unit: '%' },
];
const SAMPLER: InstDef = {
  type: 'sampler', name: 'Sampler', params: SAMPLER_PARAMS,
  presets: { 'Default': Object.fromEntries(SAMPLER_PARAMS.map(p => [p.id, p.def])), 'Pad (slow, looped)': { ...Object.fromEntries(SAMPLER_PARAMS.map(p => [p.id, p.def])), attack: 400, release: 1200, loop: 1, cutoff: 6000 } },
  play(ctx, dest, p, pitch, vel, when, dur, sample) {
    const env = ctx.createGain(), flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = p.cutoff;
    flt.connect(env); env.connect(dest);
    const peak = Math.pow(vel / 127, 1.3) * (p.level / 100);
    const A = p.attack / 1000, R = p.release / 1000;
    let src: AudioScheduledSourceNode;
    if (sample) {
      const b = ctx.createBufferSource(); b.buffer = sample;
      b.playbackRate.value = Math.pow(2, (pitch - p.root) / 12); b.detune.value = p.tune;
      const off = (p.start / 100) * sample.duration;
      if (p.loop >= 0.5) { b.loop = true; b.loopStart = off; b.loopEnd = sample.duration; }
      b.connect(flt); b.start(when, off);
      src = b;
    } else {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(pitch); o.connect(flt); o.start(when); src = o; // no sample loaded yet
    }
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + A);
    const stopAt = (t: number) => { env.gain.cancelScheduledValues(t); env.gain.setValueAtTime(env.gain.value || peak, t); env.gain.setTargetAtTime(0, t, Math.max(0.003, R / 4)); src.stop(t + R * 1.2 + 0.02); };
    if (dur != null) { env.gain.setValueAtTime(peak, when + Math.max(A, Math.min(dur, A))); env.gain.setTargetAtTime(0, when + dur, Math.max(0.003, R / 4)); src.stop(when + dur + R * 1.2 + 0.02); }
    src.onended = () => { [src, flt, env].forEach(n => n.disconnect()); };
    return { src: [src], env, release(at) { if (dur == null) stopAt(Math.max(at, when)); } };
  },
};

/** A Web Audio Module instrument: notes go to the plug-in as MIDI (see wam.ts). */
const WAM_INST: InstDef = {
  type: 'wam', name: 'Web Audio Module', params: [], presets: { Default: {} },
  play: (ctx, dest, _p, pitch, vel, when, dur) => playWamNote(ctx, dest, pitch, vel, when, dur),
};
export const INSTRUMENTS: Record<InstType, InstDef> = { synth: SYNTH, drums: DRUMS, sampler: SAMPLER, wam: WAM_INST };

export function newInstrument(type: InstType, preset?: string): InstrumentState {
  const def = INSTRUMENTS[type];
  const name = preset && def.presets[preset] ? preset : Object.keys(def.presets)[0];
  return { type, preset: name, params: { ...def.presets[name] } };
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (p: number) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 2}`;
