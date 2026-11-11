// Tool windows: Groups & VCA, Memory Locations (Pro Tools), Strip Silence (Pro Tools) and the Tuner (Cubase).
import type { Commands } from '../commands';
import { h, toast } from './dom';
import { FloatWin, fwRow, fwNumber } from './floatwin';
import { members } from '../groups';
import { COLOR_CHOICES } from '../model';

const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

export class ToolWindows {
  private groups = new FloatWin('Groups & VCA', 400);
  private locs = new FloatWin('Memory Locations', 380);
  private strip = new FloatWin('Strip Silence', 360);
  private tuner = new FloatWin('Tuner', 320);
  private stripOpts = { threshold: -42, minSilence: 120, minRegion: 60, pre: 10, post: 60 };

  constructor(private cmd: Commands) {
    cmd.openGroups = () => this.renderGroups();
    cmd.openLocations = () => this.renderLocs();
    cmd.openStripSilence = () => this.renderStrip();
    cmd.openTuner = () => this.openTuner();
    cmd.store.on(k => {
      if ((k === 'structure' || k === 'mix') && this.groups.isOpen && !this.groups.el?.contains(document.activeElement)) this.renderGroups();
      if ((k === 'structure' || k === 'transport') && this.locs.isOpen && !this.locs.el?.contains(document.activeElement)) this.renderLocs();
      if (k === 'structure' && this.strip.isOpen) this.renderStrip();
    });
    this.tuner.onClose = () => this.stopTuner();
  }

  // ---------- Groups & VCA ----------
  private renderGroups() {
    const { store } = this.cmd;
    const groups = store.project.groups ?? [];
    const list = groups.map(g => {
      const name = h('input', { type: 'text', value: g.name, 'aria-label': 'Group name' }) as HTMLInputElement;
      name.addEventListener('keydown', e => e.stopPropagation());
      name.addEventListener('change', () => { store.checkpoint(); g.name = name.value.trim().slice(0, 24) || g.name; store.emit('structure'); });
      const vca = h('input', { type: 'range', min: '-60', max: '12', step: '0.5', value: String(g.vca), 'aria-label': `${g.name} VCA level` }) as HTMLInputElement;
      const val = h('span', { class: 'fw-pos' }, fmtDb(g.vca));
      vca.addEventListener('input', () => { g.vca = parseFloat(vca.value); val.textContent = fmtDb(g.vca); store.emit('mix'); });
      vca.addEventListener('dblclick', () => { g.vca = 0; vca.value = '0'; val.textContent = fmtDb(0); store.emit('mix'); });
      const tog = (label: string, key: 'linkVol' | 'linkMute' | 'linkSolo' | 'linkSel') => h('button', { class: `pw-btn${g[key] ? ' on' : ''}`, 'aria-pressed': String(g[key]), title: `Link ${label.toLowerCase()} between the group's tracks`, onClick: () => { g[key] = !g[key]; this.renderGroups(); } }, label);
      const mute = h('button', { class: `pw-btn${g.vcaMute ? ' on' : ''}`, title: 'VCA mute: silences every track in the group', onClick: () => { g.vcaMute = !g.vcaMute; store.emit('mix'); store.emit('structure'); this.renderGroups(); } }, 'M');
      const mem = members(store, g);
      return h('div', { class: 'fw-item', style: { flexDirection: 'column', alignItems: 'stretch' } },
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('button', { class: 'fw-dot', style: { background: g.color, border: '0', cursor: 'pointer' }, title: 'Change color', 'aria-label': 'Change group color', onClick: () => { const i = COLOR_CHOICES.findIndex(c => c[1] === g.color); g.color = COLOR_CHOICES[(i + 1) % COLOR_CHOICES.length][1]; store.emit('structure'); this.renderGroups(); } }),
          name, mute,
          h('button', { class: 'pw-btn', title: 'Ungroup (the tracks stay)', onClick: () => this.cmd.deleteGroup(g.id) }, 'Ungroup')),
        h('div', { class: 'fw-vca' }, h('span', { class: 'fw-label', style: { minWidth: '34px' } }, 'VCA'), vca, val),
        h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, tog('Volume', 'linkVol'), tog('Mute', 'linkMute'), tog('Solo', 'linkSolo'), tog('Select', 'linkSel')),
        h('div', { class: 'fw-hint' }, mem.length ? mem.map(t => t.name).join(' · ') : 'No tracks'));
    });
    this.groups.open([
      h('div', { class: 'fw-list' }, ...list),
      groups.length ? null as unknown as HTMLElement : h('div', { class: 'fw-hint' }, 'No groups yet.'),
      h('button', { class: 'pw-btn', onClick: this.cmd.groupSelectedTracks }, 'Group Selected Tracks (⌘G)'),
      h('div', { class: 'fw-hint' }, 'Select tracks with Shift- or ⌘-click (on a tablet: long-press a track › Group Tracks). The VCA fader moves every track in the group together and keeps their balance; double-click it to reset.'),
    ].filter(Boolean));
  }

  // ---------- Memory Locations ----------
  private renderLocs() {
    const { store } = this.cmd;
    const ms = store.project.markers;
    const now = this.cmd.engine.currentBeat();
    const curIdx = ms.reduce((acc, m, i) => (m.b <= now + 1e-6 ? i : acc), -1);
    const rows = ms.map((m, i) => {
      const name = h('input', { type: 'text', value: m.name, 'aria-label': `Location ${i + 1} name` }) as HTMLInputElement;
      name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      name.addEventListener('change', () => this.cmd.renameMarker(m.id, name.value));
      const pos = store.formatPos(m.b), sec = store.secAt(m.b);
      const next = ms[i + 1];
      return h('div', { class: `fw-item${i === curIdx ? ' now' : ''}` },
        h('span', { class: 'fw-pos', style: { width: '18px' } }, String(i + 1)),
        h('button', { class: 'pw-btn', title: 'Go to this location', 'aria-label': `Go to ${m.name}`, onClick: () => this.cmd.locate(m.b) }, '▶'),
        name,
        h('span', { class: 'fw-pos', title: `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}` }, `${pos.bar}.${pos.beat}`),
        h('button', { class: 'pw-btn', title: next ? 'Cycle from here to the next location' : 'Cycle the next 4 bars', onClick: () => { store.ui.cycle = { on: true, start: m.b, end: next?.b ?? m.b + 4 * store.beatsPerBar }; this.cmd.locate(m.b); this.cmd.engine.resync(); } }, '⟳'),
        h('button', { class: 'pw-btn', title: 'Delete location', 'aria-label': `Delete ${m.name}`, onClick: () => this.cmd.deleteMarker(m.id) }, '✕'));
    });
    this.locs.open([
      h('div', { class: 'fw-list' }, ...rows),
      ms.length ? null as unknown as HTMLElement : h('div', { class: 'fw-hint' }, 'No locations yet.'),
      h('button', { class: 'pw-btn', onClick: () => { const m = this.cmd.addMarker(); if (m) this.renderLocs(); } }, '+ New Location at Playhead'),
      h('div', { class: 'fw-hint' }, 'Locations are the song’s markers. Keys: ⌥1…⌥9 jump to locations 1–9.'),
    ].filter(Boolean));
  }

  // ---------- Strip Silence ----------
  private renderStrip() {
    const o = this.stripOpts;
    const count = h('div', { class: 'fw-hint' });
    const update = () => { const n = this.cmd.stripSilence(o, true); const any = this.cmd.store.selectedRegions().some(r => r.kind !== 'midi'); count.textContent = n ? `Will make ${n} region${n === 1 ? '' : 's'} from the selection.` : any ? 'Nothing above the threshold that is long enough: lower the threshold or Min region.' : 'Select one or more audio regions.'; };
    const num = (label: string, key: keyof typeof o, min: number, max: number, step: number, unit: string) =>
      fwRow(label, fwNumber(o[key], min, max, step, v => { o[key] = v; update(); }, label), h('span', { class: 'fw-hint' }, unit));
    this.strip.open([
      num('Threshold', 'threshold', -80, 0, 1, 'dB'),
      num('Min silence', 'minSilence', 10, 2000, 10, 'ms'),
      num('Min region', 'minRegion', 10, 2000, 10, 'ms'),
      num('Pad before', 'pre', 0, 500, 5, 'ms'),
      num('Pad after', 'post', 0, 1000, 5, 'ms'),
      count,
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('button', { class: 'pw-btn on', onClick: () => { if (this.cmd.stripSilence(o)) update(); } }, 'Strip'),
        h('button', { class: 'pw-btn', onClick: () => this.strip.close() }, 'Close')),
    ]);
    update();
  }

  // ---------- Tuner ----------
  private tunerStop: (() => void) | null = null;
  private async openTuner() {
    const note = h('div', { class: 'tn-note' }, '–');
    const cents = h('div', { class: 'tn-cents' }, 'Play a single note');
    const needle = h('div', { class: 'tn-needle' });
    const hz = h('div', { class: 'fw-hint', style: { textAlign: 'center' } }, '');
    const ref = { a4: 440 };
    const refIn = fwNumber(440, 415, 466, 1, v => { ref.a4 = v; }, 'Reference A4');
    this.tuner.open([
      h('div', { class: 'tn-scale' }, h('span', {}, '−50'), h('span', {}, '0'), h('span', {}, '+50'), needle),
      note, cents, hz,
      fwRow('Reference A4', refIn, h('span', { class: 'fw-hint' }, 'Hz')),
    ]);
    if (this.tunerStop) return;
    const eng = this.cmd.engine;
    let mic: MediaStream;
    try { mic = await eng.getMic(); } catch { cents.textContent = 'Microphone blocked: allow it to use the tuner'; return; }
    if (eng.ctx.state !== 'running') eng.ctx.resume().catch(() => {});
    const src = eng.ctx.createMediaStreamSource(mic), an = eng.ctx.createAnalyser();
    an.fftSize = 4096; src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0, smooth = 0;
    const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
    const loop = () => {
      raf = requestAnimationFrame(loop);
      an.getFloatTimeDomainData(buf);
      const f = detectPitch(buf, eng.ctx.sampleRate);
      if (!f) { needle.style.opacity = '0.3'; return; }
      const m = 69 + 12 * Math.log2(f / ref.a4), n = Math.round(m), c = (m - n) * 100;
      smooth = smooth * 0.6 + c * 0.4;
      note.textContent = `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
      cents.textContent = Math.abs(smooth) < 3 ? 'In tune' : `${smooth > 0 ? '+' : ''}${smooth.toFixed(0)} cents ${smooth > 0 ? '(sharp)' : '(flat)'}`;
      cents.classList.toggle('ok', Math.abs(smooth) < 3);
      hz.textContent = `${f.toFixed(1)} Hz`;
      needle.style.opacity = '1';
      needle.style.left = `${50 + Math.max(-50, Math.min(50, smooth))}%`;
      needle.classList.toggle('ok', Math.abs(smooth) < 3);
    };
    loop();
    this.tunerStop = () => { cancelAnimationFrame(raf); src.disconnect(); an.disconnect(); };
    toast('Tuner: play one note at a time');
  }
  private stopTuner() { this.tunerStop?.(); this.tunerStop = null; }
}

/** YIN pitch detection (returns Hz, or 0 when there is no clear pitch). */
export function detectPitch(buf: Float32Array, sr: number): number {
  let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / buf.length) < 0.01) return 0;
  const W = Math.floor(buf.length / 2), tMin = Math.floor(sr / 1500), tMax = Math.min(W - 1, Math.floor(sr / 40));
  const d = new Float32Array(tMax + 2); let run = 0; d[0] = 1;
  for (let t = 1; t <= tMax + 1; t++) {
    let s = 0; for (let j = 0; j < W; j++) { const x = buf[j] - buf[j + t]; s += x * x; }
    run += s; d[t] = run ? s * t / run : 1;
  }
  for (let t = tMin; t <= tMax; t++) {
    if (d[t] < 0.12) {
      while (t + 1 <= tMax && d[t + 1] < d[t]) t++;
      const a = d[t - 1], b = d[t], c = d[t + 1], den = a + c - 2 * b;
      return sr / (den ? t + (a - c) / (2 * den) : t);
    }
  }
  return 0;
}
