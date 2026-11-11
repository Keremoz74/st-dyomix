// Two more software instruments: an FM electric piano and a drawbar organ.
import type { InstDef, Voice } from './instruments';
import type { ParamDef } from './plugins';

const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const defaults = (ps: ParamDef[]) => Object.fromEntries(ps.map(p => [p.id, p.def]));

// ---------------- Electric Piano (two-operator FM, tine + bark) ----------------
const EP_PARAMS: ParamDef[] = [
  { id: 'tine', label: 'Tine', min: 0, max: 100, def: 45, unit: '%' },
  { id: 'bark', label: 'Bark', min: 0, max: 100, def: 35, unit: '%' },
  { id: 'bell', label: 'Bell', min: 0, max: 100, def: 15, unit: '%' },
  { id: 'decay', label: 'Decay', min: 0.5, max: 8, def: 3, unit: 's', log: true },
  { id: 'release', label: 'Release', min: 20, max: 2000, def: 250, unit: 'ms', log: true },
  { id: 'trem', label: 'Tremolo', min: 0, max: 100, def: 20, unit: '%' },
  { id: 'tremRate', label: 'Trem Rate', min: 1, max: 10, def: 4.5, unit: 'Hz' },
  { id: 'tone', label: 'Tone', min: 800, max: 12000, def: 5000, unit: 'Hz', log: true },
];
const ep = (o: Record<string, number>) => ({ ...defaults(EP_PARAMS), ...o });
export const EPIANO: InstDef = {
  type: 'epiano' as any, name: 'Electric Piano', params: EP_PARAMS,
  presets: {
    'Classic Tine': ep({}),
    'Bright Bell': ep({ tine: 70, bark: 20, bell: 55, decay: 4, tone: 9000 }),
    'Dark & Warm': ep({ tine: 25, bark: 15, bell: 5, decay: 2.5, tone: 2200, trem: 35 }),
    'Barky Rhodes': ep({ tine: 50, bark: 80, bell: 10, decay: 2.2, tone: 6000 }),
    'Ballad': ep({ tine: 35, bark: 10, bell: 25, decay: 6, release: 600, trem: 30, tremRate: 3.5, tone: 4000 }),
  },
  play(ctx, dest, p, pitch, vel, when, dur): Voice {
    const f = hz(pitch), v = vel / 127;
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), modG = ctx.createGain();
    const bell = ctx.createOscillator(), bellMod = ctx.createGain();
    car.frequency.value = f; mod.frequency.value = f; bell.frequency.value = f * 14;
    // "bark": modulation index rises with velocity, decays quickly
    const idx = f * (0.3 + 2.2 * (p.bark / 100) * v * v);
    modG.gain.setValueAtTime(idx, when); modG.gain.setTargetAtTime(idx * 0.25, when, 0.15);
    bellMod.gain.setValueAtTime(f * 3 * (p.bell / 100) * v, when); bellMod.gain.setTargetAtTime(0, when, 0.05);
    mod.connect(modG); modG.connect(car.frequency); bell.connect(bellMod); bellMod.connect(car.frequency);
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = Math.min(18000, p.tone * (0.6 + v * 0.8)); tone.Q.value = 0.5;
    const tine = ctx.createOscillator(), tineG = ctx.createGain(); tine.frequency.value = f * 4; tine.type = 'sine';
    tineG.gain.setValueAtTime(0.18 * (p.tine / 100) * v, when); tineG.gain.setTargetAtTime(0, when, 0.06);
    const env = ctx.createGain();
    const trem = ctx.createOscillator(), tremG = ctx.createGain(), tremBase = ctx.createGain();
    trem.frequency.value = p.tremRate; tremG.gain.value = 0.5 * p.trem / 100; tremBase.gain.value = 1 - 0.5 * p.trem / 100;
    trem.connect(tremG); tremG.connect(tremBase.gain);
    car.connect(tone); tine.connect(tineG); tineG.connect(tone); tone.connect(env); env.connect(tremBase); tremBase.connect(dest);
    const peak = 0.3 * Math.pow(v, 1.3);
    const decay = p.decay * Math.max(0.35, 1.4 - (pitch - 48) / 60); // low notes ring longer
    env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(peak, when + 0.003); env.gain.setTargetAtTime(0, when + 0.003, decay / 4);
    const nodes = [car, mod, bell, tine, trem];
    nodes.forEach(o => o.start(when));
    const R = p.release / 1000;
    const stopAt = (at: number) => {
      env.gain.cancelScheduledValues(at); env.gain.setValueAtTime(peak * Math.exp(-4 * Math.max(0, at - when) / decay), at); env.gain.setTargetAtTime(0, at, R / 4);
      nodes.forEach(o => o.stop(at + R + 0.05));
    };
    if (dur != null) stopAt(when + dur); else nodes.forEach(o => o.stop(when + decay * 3));
    car.onended = () => [car, mod, modG, bell, bellMod, tone, tine, tineG, env, trem, tremG, tremBase].forEach(n => n.disconnect());
    return { src: nodes, env, release(at) { if (dur == null) stopAt(Math.max(at, when)); } };
  },
};

// ---------------- Drawbar Organ ----------------
// drawbar footages as harmonics of the 16' sub: 16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1'
const DRAWBARS: [string, number][] = [["16'", 1], ["5⅓'", 3], ["8'", 2], ["4'", 4], ["2⅔'", 6], ["2'", 8], ["1⅗'", 10], ["1⅓'", 12], ["1'", 16]];
const ORGAN_PARAMS: ParamDef[] = [
  ...DRAWBARS.map(([n], i) => ({ id: `d${i}`, label: n, min: 0, max: 8, def: [8, 8, 8, 0, 0, 0, 0, 0, 0][i], unit: '', step: 1 })),
  { id: 'perc', label: 'Percussion', min: 0, max: 2, def: 0, unit: '', step: 1, options: ['Off', '2nd', '3rd'] },
  { id: 'vib', label: 'Vibrato', min: 0, max: 100, def: 30, unit: '%' },
  { id: 'click', label: 'Key Click', min: 0, max: 100, def: 30, unit: '%' },
  { id: 'drive', label: 'Drive', min: 0, max: 100, def: 15, unit: '%' },
];
const og = (bars: string, o: Record<string, number> = {}) => ({ ...defaults(ORGAN_PARAMS), ...Object.fromEntries([...bars].map((c, i) => [`d${i}`, +c])), ...o });
const waves = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
function organWave(ctx: BaseAudioContext, p: Record<string, number>) {
  const key = DRAWBARS.map((_, i) => Math.round(p[`d${i}`])).join('');
  let m = waves.get(ctx); if (!m) waves.set(ctx, m = new Map());
  let w = m.get(key);
  if (!w) {
    const real = new Float32Array(17), imag = new Float32Array(17);
    DRAWBARS.forEach(([, h], i) => { const lvl = Math.round(p[`d${i}`]); if (lvl) imag[h] += Math.pow(10, (lvl - 8) * 3 / 20); });
    w = ctx.createPeriodicWave(real, imag);
    m.set(key, w);
  }
  return w;
}
export const ORGAN: InstDef = {
  type: 'organ' as any, name: 'Drawbar Organ', params: ORGAN_PARAMS,
  presets: {
    'Full Gospel': og('888888888', { perc: 0, vib: 40, drive: 30 }),
    'Jazz (888000000)': og('888000000', { perc: 2, vib: 30, click: 40 }),
    'Rock Organ': og('888800000', { perc: 1, vib: 20, drive: 55 }),
    'Soft Flute': og('008400000', { vib: 45, click: 10, drive: 0 }),
    'Reggae Bubble': og('688600000', { perc: 1, vib: 0, click: 50 }),
  },
  play(ctx, dest, p, pitch, vel, when, dur): Voice {
    const f = hz(pitch) / 2; // 16' fundamental
    const osc = ctx.createOscillator(); osc.setPeriodicWave(organWave(ctx, p)); osc.frequency.value = f;
    const vib = ctx.createOscillator(), vibG = ctx.createGain(); vib.frequency.value = 6.8; vibG.gain.value = 12 * p.vib / 100; vib.connect(vibG); vibG.connect(osc.detune);
    const env = ctx.createGain(), sat = ctx.createWaveShaper();
    const k = 1 + p.drive / 12, c = new Float32Array(512); for (let i = 0; i < 512; i++) { const x = i / 255.5 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); } sat.curve = c;
    osc.connect(env); env.connect(sat); sat.connect(dest);
    const lvl = 0.11 * (0.75 + 0.25 * vel / 127); // organs aren't velocity sensitive, but a little helps
    env.gain.setValueAtTime(0, when); env.gain.linearRampToValueAtTime(lvl, when + 0.006);
    const srcs: AudioScheduledSourceNode[] = [osc, vib];
    if (p.perc >= 1) {
      const po = ctx.createOscillator(), pg = ctx.createGain(); po.frequency.value = f * (p.perc >= 2 ? 6 : 4);
      pg.gain.setValueAtTime(lvl * 0.9, when); pg.gain.setTargetAtTime(0, when, 0.12);
      po.connect(pg); pg.connect(sat); srcs.push(po);
    }
    if (p.click > 0) {
      const cl = ctx.createOscillator(), cg = ctx.createGain(); cl.type = 'square'; cl.frequency.value = 2200 + pitch * 20;
      cg.gain.setValueAtTime(lvl * 0.25 * p.click / 100, when); cg.gain.setTargetAtTime(0, when, 0.004);
      cl.connect(cg); cg.connect(sat); srcs.push(cl);
    }
    srcs.forEach(s => s.start(when));
    const stopAt = (at: number) => { env.gain.cancelScheduledValues(at); env.gain.setValueAtTime(lvl, at); env.gain.linearRampToValueAtTime(0, at + 0.012); srcs.forEach(s => s.stop(at + 0.03)); };
    if (dur != null) stopAt(when + dur);
    osc.onended = () => [osc, vib, vibG, env, sat].forEach(n => n.disconnect());
    return { src: srcs, env, release(at) { if (dur == null) stopAt(Math.max(at, when)); } };
  },
};
