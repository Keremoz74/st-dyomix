// Control bar, Inspector, Mixer and the floating Tool menu.
import { TOOLS } from '../model';
import { Commands } from '../commands';
import { h, icon, iconBtn, openMenu, inlineEdit, MenuItem, swallowGesture } from './dom';
import { channelStrip, StripHandle } from './strip';

export class ControlBar {
  el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private recBtn: HTMLButtonElement;
  private cycleBtn: HTMLButtonElement;
  private metroBtn: HTMLButtonElement;
  private punchBtn: HTMLButtonElement;
  private recSetBtn: HTMLButtonElement;
  private inspBtn: HTMLButtonElement;
  private mixBtn: HTMLButtonElement;
  private pos: HTMLElement;
  private tempo: HTMLInputElement;
  private lastPos = '';

  constructor(private cmd: Commands) {
    const { store } = cmd;
    this.inspBtn = iconBtn('inspector', 'Inspector (I)', cmd.toggleInspector);
    this.mixBtn = iconBtn('mixer', 'Mixer (X)', cmd.toggleMixer);
    this.playBtn = iconBtn('play', 'Play / Stop (Space)', cmd.togglePlay);
    this.recBtn = iconBtn('record', 'Record (R)', cmd.record, 'cb-btn rec');
    this.cycleBtn = iconBtn('cycle', 'Cycle (C)', cmd.toggleCycle);
    this.metroBtn = iconBtn('metronome', 'Metronome (K)', cmd.toggleMetronome);
    this.punchBtn = iconBtn('punch', 'Autopunch: record only inside the red ruler range', cmd.togglePunch);
    this.recSetBtn = iconBtn('settings', 'Recording settings: count-in, input, latency', () => this.recordMenu());
    this.pos = h('span', { class: 'lcd-pos', 'aria-live': 'off' });
    this.tempo = h('input', { class: 'lcd-tempo', inputmode: 'decimal', 'aria-label': 'Tempo (BPM)', title: 'Tempo: type a value or drag up/down' }) as HTMLInputElement;
    this.tempo.addEventListener('change', () => cmd.setTempo(parseFloat(this.tempo.value)));
    this.tempo.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') this.tempo.blur(); if (e.key === 'Escape') { this.tempo.value = String(store.project.tempo); this.tempo.blur(); } });
    const master = h('input', { type: 'range', min: '-60', max: '6', step: '0.5', value: '0', 'aria-label': 'Master volume', class: 'master-vol' }) as HTMLInputElement;
    master.addEventListener('input', () => { store.project.masterVolume = parseFloat(master.value); store.emit('mix'); });
    store.on(k => { if (k === 'mix' && document.activeElement !== master) master.value = String(store.project.masterVolume); });

    this.el = h('header', { class: 'control-bar' },
      h('div', { class: 'cb-group' }, this.inspBtn, this.mixBtn),
      h('div', { class: 'cb-group cb-transport' }, iconBtn('tostart', 'Go to Beginning (Return)', cmd.goToStart), iconBtn('rewind', 'Rewind (,)', cmd.rewind), iconBtn('forward', 'Forward (.)', cmd.forward), iconBtn('stop', 'Stop (go to start when stopped)', cmd.stop), this.playBtn, this.recBtn),
      h('div', { class: 'lcd' },
        h('div', { class: 'lcd-cell' }, this.pos, h('span', { class: 'lcd-label' }, 'BAR  BEAT  DIV  TICK')),
        h('div', { class: 'lcd-cell' }, this.tempo, h('span', { class: 'lcd-label' }, 'TEMPO')),
        h('div', { class: 'lcd-cell' }, h('span', { class: 'lcd-sig' }, '4/4'), h('span', { class: 'lcd-label' }, 'TIME')),
      ),
      h('div', { class: 'cb-group' }, this.cycleBtn, this.punchBtn, this.metroBtn, this.recSetBtn),
      h('label', { class: 'cb-master' }, h('span', {}, 'Master'), master),
      h('div', { class: 'cb-group cb-right' },
        iconBtn('undo', 'Undo (⌘Z)', cmd.undo), iconBtn('redo', 'Redo (⇧⌘Z)', cmd.redo),
        iconBtn('import', 'Import Audio File (⇧⌘I)', cmd.importAudio), iconBtn('bounce', 'Bounce to WAV (⌘B)', cmd.bounce)),
    );
    store.on(() => this.update());
    this.update();
  }

  update() {
    const { ui, project } = this.cmd.store;
    this.playBtn.classList.toggle('on-green', ui.playing);
    this.recBtn.classList.toggle('on-red', ui.recording);
    this.cycleBtn.classList.toggle('on-yellow', ui.cycle.on);
    this.metroBtn.classList.toggle('on', ui.metronome);
    this.punchBtn.classList.toggle('on-red-soft', ui.punch.on);
    this.recSetBtn.classList.toggle('on', ui.countIn > 0);
    this.recSetBtn.title = `Recording settings · Count-in: ${ui.countIn ? `${ui.countIn} bar${ui.countIn > 1 ? 's' : ''}` : 'off'}`;
    this.inspBtn.classList.toggle('on', ui.showInspector);
    this.mixBtn.classList.toggle('on', ui.showMixer);
    if (document.activeElement !== this.tempo) this.tempo.value = String(this.cmd.store.tempoAt(ui.playhead));
  }

  private async recordMenu() {
    const { ui } = this.cmd.store;
    let devices: MediaDeviceInfo[] = [];
    try { devices = (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default'); } catch { /* not available */ }
    openMenu(this.recSetBtn, [
      ['Count-in: Off', '', () => this.cmd.setCountIn(0), ui.countIn === 0],
      ['Count-in: 1 Bar', '', () => this.cmd.setCountIn(1), ui.countIn === 1],
      ['Count-in: 2 Bars', '', () => this.cmd.setCountIn(2), ui.countIn === 2],
      '-',
      ['Input: System Default', '', () => this.cmd.setInputDevice(null), !ui.inputDeviceId],
      ...devices.map((d, i) => [`Input: ${d.label || `Microphone ${i + 1}`}`, '', () => this.cmd.setInputDevice(d.deviceId), ui.inputDeviceId === d.deviceId] as MenuItem),
      '-',
      [`Recording Offset: ${ui.latencyMs} ms…`, '', () => { const r = this.recSetBtn.getBoundingClientRect(); inlineEdit(r.left, r.bottom + 4, String(ui.latencyMs), v => this.cmd.setLatency(parseFloat(v)), 80, true); }],
      '-',
      ['All Settings…', '', () => this.cmd.openSettings()],
    ]);
  }

  frame(beat: number) {
    const t = this.cmd.store.formatPos(beat).text;
    if (t !== this.lastPos) {
      this.pos.textContent = t; this.lastPos = t;
      if (document.activeElement !== this.tempo) { const bpm = String(this.cmd.store.tempoAt(beat)); if (this.tempo.value !== bpm) this.tempo.value = bpm; }
    }
  }
}

export class Inspector {
  el: HTMLElement;
  private strips: StripHandle[] = [];
  constructor(private cmd: Commands) {
    this.el = h('aside', { class: 'inspector', 'aria-label': 'Inspector' });
    cmd.store.on(k => { if (k === 'structure' || k === 'view') this.render(); if (k === 'mix') this.strips.forEach(s => s.refresh()); });
    this.render();
  }
  render() {
    const { store } = this.cmd;
    this.el.hidden = !store.ui.showInspector;
    if (!store.ui.showInspector) { this.strips = []; return; }
    const sel = store.selectedRegions();
    const t = store.track(store.ui.selectedTrackId) ?? null;
    const row = (k: string, v: string) => [h('span', { class: 'insp-k' }, k), h('span', { class: 'insp-v' }, v)];
    let regionBox: HTMLElement;
    if (sel.length === 1) {
      const r = sel[0];
      const p = store.formatPos(r.start), len = r.length;
      const bars = Math.floor(len / store.beatsPerBar), beats = Math.round((len % store.beatsPerBar) * 100) / 100;
      const mute = h('input', { type: 'checkbox', checked: r.muted, 'aria-label': 'Mute region' }) as HTMLInputElement;
      mute.addEventListener('change', () => this.cmd.toggleRegionMute());
      const name = h('input', { class: 'insp-name', value: r.name, 'aria-label': 'Region name' }) as HTMLInputElement;
      name.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
      name.addEventListener('change', () => { store.checkpoint(); r.name = name.value.slice(0, 40); store.emit('structure'); });
      regionBox = h('div', { class: 'insp-sec' },
        h('div', { class: 'insp-title' }, 'Region'), name,
        h('div', { class: 'insp-grid' },
          h('span', { class: 'insp-k' }, 'Mute'), h('label', { class: 'insp-v' }, mute),
          row('Position', `${p.bar} ${p.beat} ${p.div} ${p.tick}`),
          row('Length', `${bars} bar${bars === 1 ? '' : 's'} ${beats ? `${beats} beat${beats === 1 ? '' : 's'}` : ''}`),
          ...(r.kind === 'midi' ? [row('Notes', String(r.notes?.length ?? 0))] : [
            row('Offset', `${r.offset.toFixed(3)} s`),
            ...this.numField('Gain', 'dB', r.gain ?? 0, 0.5, v => this.cmd.setRegionProps(r, { gain: v })),
            ...this.numField('Fade In', 'ms', Math.round(store.secs(r.start, r.start + (r.fadeIn ?? 0)) * 1000), 10, v => this.cmd.setRegionProps(r, { fadeIn: store.beatAfter(r.start, v / 1000) - r.start })),
            ...this.numField('Fade Out', 'ms', Math.round(store.secs(r.start + r.length - (r.fadeOut ?? 0), r.start + r.length) * 1000), 10, v => this.cmd.setRegionProps(r, { fadeOut: r.start + r.length - store.beatAfter(r.start + r.length, -v / 1000) })),
          ])));
    } else {
      regionBox = h('div', { class: 'insp-sec' }, h('div', { class: 'insp-title' }, sel.length ? `${sel.length} regions selected` : 'Region'),
        h('p', { class: 'insp-hint' }, sel.length ? 'Drag to move them together.' : 'Select a region to see its settings.'));
    }
    this.strips = [channelStrip(this.cmd, t, { selected: true }), channelStrip(this.cmd, null)];
    this.el.replaceChildren(regionBox,
      h('div', { class: 'insp-sec insp-track' }, h('div', { class: 'insp-title' }, `Track: ${t?.name ?? '—'}`)),
      h('div', { class: 'insp-strips' }, this.strips.map(s => s.el)));
  }
  meters() { this.strips.forEach(s => s.meter()); }

  private numField(label: string, unit: string, value: number, step: number, set: (v: number) => void) {
    const inp = h('input', { type: 'number', class: 'insp-num', value: String(Math.round(value * 10) / 10), step: String(step), 'aria-label': `${label} (${unit})` }) as HTMLInputElement;
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v)) set(v); });
    return [h('span', { class: 'insp-k' }, label), h('label', { class: 'insp-v insp-numwrap' }, inp, h('span', { class: 'insp-unit' }, unit))];
  }
}

export class Mixer {
  el: HTMLElement;
  private strips: StripHandle[] = [];
  constructor(private cmd: Commands) {
    this.el = h('section', { class: 'mixer', 'aria-label': 'Mixer' });
    cmd.store.on(k => { if (k === 'structure' || k === 'view') this.render(); if (k === 'mix') this.strips.forEach(s => s.refresh()); });
    this.render();
  }
  render() {
    const { store } = this.cmd;
    this.el.hidden = !store.ui.showMixer;
    if (!store.ui.showMixer) { this.strips = []; return; }
    const tracks = store.project.tracks.map(t => channelStrip(this.cmd, t, { selected: t.id === store.ui.selectedTrackId }));
    const auxes = store.project.auxes.map(t => channelStrip(this.cmd, t, { selected: t.id === store.ui.selectedTrackId }));
    const master = channelStrip(this.cmd, null);
    this.strips = [...tracks, ...auxes, master];
    this.el.replaceChildren(
      h('div', { class: 'lm-bar' }, h('span', { class: 'lm-title' }, 'Mixer'),
        h('button', { class: 'tool-btn', title: 'New Aux channel', onClick: this.cmd.newAux }, '+ Aux'), h('span', { class: 'grow' }),
        h('button', { class: 'tool-btn', 'aria-label': 'Close Mixer', title: 'Close (X)', onClick: this.cmd.toggleMixer }, '×')),
      h('div', { class: 'mixer-strips' }, tracks.map(s => s.el), auxes.length ? [h('div', { class: 'mixer-sep' }), auxes.map(s => s.el)] : null, h('div', { class: 'mixer-sep' }), master.el));
  }
  meters() { this.strips.forEach(s => s.meter()); }
}

/** Floating Tool menu (T key), like Logic: T opens it at the pointer, a letter picks a tool, T again = Pointer. */
export class ToolMenu {
  el: HTMLElement | null = null;
  constructor(private cmd: Commands) {}
  get open() { return !!this.el; }
  show(x: number, y: number) {
    this.close();
    const ui = this.cmd.store.ui;
    this.el = h('div', { class: 'menu tool-menu', role: 'menu', 'aria-label': 'Tool menu' },
      h('div', { class: 'menu-head' }, 'Tool Menu'),
      TOOLS.map(t => h('button', { class: 'menu-item' + (ui.tool === t.id ? ' checked' : ''), role: 'menuitem', onClick: () => this.pick(t.id) },
        h('span', { class: 'menu-check' }, icon(t.id, 14)), h('span', { class: 'menu-label' }, t.label), h('span', { class: 'menu-key' }, t.key))));
    document.body.appendChild(this.el);
    const w = this.el.offsetWidth, hh = this.el.offsetHeight;
    this.el.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
    this.el.style.top = `${Math.max(4, Math.min(y, innerHeight - hh - 4))}px`;
    setTimeout(() => document.addEventListener('pointerdown', this.outside, true));
  }
  private outside = (e: Event) => { if (this.el && !this.el.contains(e.target as Node)) { this.close(); swallowGesture(e); } };
  pick(id: (typeof TOOLS)[number]['id']) { this.cmd.setTool(id); this.close(); }
  key(k: string): boolean {
    const t = TOOLS.find(t => t.key.toLowerCase() === k.toLowerCase());
    if (t) { this.pick(t.id); return true; }
    if (k === 'Escape') { this.close(); return true; }
    return false;
  }
  close() { if (this.el) { this.el.remove(); this.el = null; document.removeEventListener('pointerdown', this.outside, true); } }
}
