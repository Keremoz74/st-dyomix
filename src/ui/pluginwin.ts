// Floating plug-in window with knobs, EQ curve and compressor gain-reduction meter.
import { Insert } from '../model';
import { Commands } from '../commands';
import { PLUGINS, ParamDef, fmtParam, toNorm, fromNorm, defaultParams } from '../audio/plugins';
import { pluginPrefs } from '../plugin-prefs';
import { instrumentMenu, gmLibraryMenu } from './pluginmenu';
import { bankReady, bankFailed, gmName, onBankState } from '../audio/gm';
import { nativeParams, hostingAvailable } from '../audio/native';
import { toast, inlineEdit } from './dom';
import { INSTRUMENTS } from '../audio/instruments';
import { h, icon, openMenu, MenuItem } from './dom';

const ARC = 270; // degrees of knob travel

/** Named-choice parameter (amp model, cabinet, reverb space…): a menu button instead of a knob. */
function choice(cmd: Commands, owner: string, ins: Insert, p: ParamDef) {
  const val = h('span', { class: 'ch-val' });
  const btn: HTMLButtonElement = h('button', { class: 'sel-btn ch-btn', 'aria-haspopup': 'menu', 'aria-label': p.label,
    onClick: () => openMenu(btn, p.options!.map((o, i) => [o, '', () => { cmd.store.checkpoint(); cmd.setParam(owner, ins.id, p.id, i); show(); }, Math.round(ins.params[p.id]) === i] as MenuItem)) }, val, icon('chevron', 10));
  const el = h('div', { class: 'knob choice' }, h('span', { class: 'kn-label' }, p.label), btn);
  const show = () => { val.textContent = p.options![Math.round(ins.params[p.id])] ?? ''; };
  show();
  return { el, show };
}

/** On/off parameter: a toggle button. */
function toggle(cmd: Commands, owner: string, ins: Insert, p: ParamDef) {
  const btn = h('button', { class: 'pw-toggle', 'aria-label': p.label, onClick: () => { cmd.store.checkpoint(); cmd.setParam(owner, ins.id, p.id, ins.params[p.id] >= 0.5 ? 0 : 1); show(); } });
  const el = h('div', { class: 'knob choice' }, h('span', { class: 'kn-label' }, p.label), btn);
  const show = () => { const on = ins.params[p.id] >= 0.5; btn.textContent = on ? 'On' : 'Off'; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); };
  show();
  return { el, show };
}

const control = (cmd: Commands, owner: string, ins: Insert, p: ParamDef) => p.options ? choice(cmd, owner, ins, p) : p.unit === 'onoff' && p.max === 1 && p.step === 1 && ins.id !== 'inst' ? toggle(cmd, owner, ins, p) : knob(cmd, owner, ins, p);

function knob(cmd: Commands, owner: string, ins: Insert, p: ParamDef) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 56 56'); svg.setAttribute('width', '56'); svg.setAttribute('height', '56'); svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(ns, 'path'), val = document.createElementNS(ns, 'path'), dot = document.createElementNS(ns, 'line');
  track.setAttribute('class', 'kn-track'); val.setAttribute('class', 'kn-val'); dot.setAttribute('class', 'kn-dot');
  const body = document.createElementNS(ns, 'circle'); body.setAttribute('cx', '28'); body.setAttribute('cy', '28'); body.setAttribute('r', '17'); body.setAttribute('class', 'kn-body');
  svg.append(track, val, body, dot);
  const arc = (a0: number, a1: number) => {
    const r = 23, pt = (a: number) => { const rad = (a - 90) * Math.PI / 180; return `${28 + r * Math.cos(rad)} ${28 + r * Math.sin(rad)}`; };
    return `M${pt(a0)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}`;
  };
  track.setAttribute('d', arc(-ARC / 2, ARC / 2));
  const readout = h('span', { class: 'kn-readout' });
  const el = h('div', { class: 'knob', role: 'slider', tabindex: '0', 'aria-label': p.label, 'aria-valuemin': String(p.min), 'aria-valuemax': String(p.max), title: `${p.label}: drag up/down, double-click to reset` },
    h('span', { class: 'kn-label' }, p.label), svg, readout);
  const show = () => {
    const v = ins.params[p.id], n = toNorm(p, v), a = -ARC / 2 + n * ARC;
    const bipolar = p.min < 0 && p.max > 0, a0 = bipolar ? 0 : -ARC / 2;
    val.setAttribute('d', Math.abs(a - a0) < 0.5 ? '' : arc(Math.min(a0, a), Math.max(a0, a)));
    const rad = (a - 90) * Math.PI / 180;
    dot.setAttribute('x1', String(28 + 7 * Math.cos(rad))); dot.setAttribute('y1', String(28 + 7 * Math.sin(rad)));
    dot.setAttribute('x2', String(28 + 15 * Math.cos(rad))); dot.setAttribute('y2', String(28 + 15 * Math.sin(rad)));
    readout.textContent = fmtParam(p, v);
    el.setAttribute('aria-valuenow', String(v)); el.setAttribute('aria-valuetext', fmtParam(p, v));
  };
  const autoKey = `fx:${ins.id}:${p.id}`;
  const set = (v: number) => { cmd.setParam(owner, ins.id, p.id, v); cmd.gesture(owner, autoKey, 'value', ins.params[p.id]); show(); };
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId);
    cmd.store.checkpoint();
    cmd.gesture(owner, autoKey, 'start');
    const y0 = e.clientY, n0 = toNorm(p, ins.params[p.id]);
    const move = (ev: PointerEvent) => set(fromNorm(p, n0 - (ev.clientY - y0) / (ev.shiftKey ? 800 : 160)));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); cmd.gesture(owner, autoKey, 'end'); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  el.addEventListener('dblclick', () => { cmd.store.checkpoint(); set(p.def); });
  el.addEventListener('keydown', e => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    set(fromNorm(p, toNorm(p, ins.params[p.id]) + d * (e.shiftKey ? 0.002 : 0.02)));
  });
  show();
  return { el, show };
}

export class PluginWindow {
  private el: HTMLElement | null = null;
  private owner = '';
  private insId = '';
  private canvas: HTMLCanvasElement | null = null;
  private grFill: HTMLElement | null = null;
  private grText: HTMLElement | null = null;
  private knobs: { show: () => void }[] = [];
  private pos: { x: number; y: number } | null = null;

  constructor(private cmd: Commands) {
    onBankState(() => this.libStatus?.());
    cmd.store.on(k => {
      if (!this.el) return;
      if (k === 'fx' || k === 'mix') this.knobs.forEach(kn => kn.show());
      if (k === 'view') this.nativeStatus?.();
      if (k === 'structure') {
        const ins = this.ins();
        if (!ins) { this.close(); return; }
        const t = this.insId === 'inst' ? cmd.store.track(this.owner) : undefined;
        const key = `${ins.type}|${ins.wam?.url ?? t?.instrument?.wam?.url ?? t?.instrument?.type ?? ''}|${ins.bypass}`;
        if (this.wamGui && key === this.shownKey) return; // keep a Web Audio Module's interface alive
        this.shownKey = key;
        this.render();
      }
    });
  }

  private ins(): Insert | undefined {
    if (this.insId === 'inst') {
      const t = this.cmd.store.track(this.owner);
      return t?.instrument ? { id: 'inst', type: 'eq', bypass: false, params: t.instrument.params } : undefined;
    }
    return this.cmd.store.insertsOf(this.owner).find(i => i.id === this.insId);
  }

  open(owner: string, insId: string) {
    this.owner = owner; this.insId = insId; this.shownKey = '';
    this.render();
  }

  close() { this.nativeStatus = null; this.libStatus = null; this.dropWamGui(); this.el?.remove(); this.el = null; this.canvas = null; this.grFill = null; }

  private wamGui: { el: Element; inst: any } | null = null;
  private shownKey = '';
  private dropWamGui() { if (this.wamGui) { try { this.wamGui.el.remove(); this.wamGui.inst.destroyGui?.(this.wamGui.el); } catch { /* */ } this.wamGui = null; } }

  /** Factory + user presets, Save As, Reset, Copy/Paste — Logic's plug-in header settings menu. */
  private presetMenu(ins: Insert): MenuItem[] {
    const c = this.cmd, owner = this.owner, def = PLUGINS[ins.type];
    const factory = Object.entries(def.presets ?? {}), user = Object.entries(pluginPrefs.userPresets(ins.type));
    const same = (p: Record<string, number>) => Object.keys(p).every(k => Math.abs((ins.params[k] ?? 0) - p[k]) < 1e-6);
    return [
      ...(factory.length ? [{ header: 'Factory' } as MenuItem, ...factory.map(([n, p]) => [n, '', () => c.applyPluginPreset(owner, ins.id, p), same(p)] as MenuItem)] : []),
      ...(user.length ? ['-' as MenuItem, { header: 'User' } as MenuItem, ...user.map(([n, p]) => [n, '', () => c.applyPluginPreset(owner, ins.id, p), same(p)] as MenuItem),
        { label: 'Delete User Preset', sub: user.map(([n]) => [n, '', () => pluginPrefs.deletePreset(ins.type, n)] as MenuItem) } as MenuItem] : []),
      '-',
      ['Save As User Preset…', '', () => { const r = this.el!.getBoundingClientRect(); inlineEdit(r.left + 20, r.top + 40, `${def.name} ${user.length + 1}`, v => c.savePluginPreset(owner, ins.id, v), 200); }],
      ['Reset to Default', '', () => c.applyPluginPreset(owner, ins.id, defaultParams(ins.type)), same(defaultParams(ins.type))],
      '-',
      ['Copy Settings', '', () => c.copyPluginSettings(owner, ins.id)],
      ...(c.canPastePlugin(owner, ins.id) ? [['Paste Settings', '', () => c.pastePluginSettings(owner, ins.id)] as MenuItem] : []),
      '-',
      [pluginPrefs.isFavorite(ins.type) ? 'Remove from Favorites' : 'Add to Favorites', '', () => pluginPrefs.toggleFavorite(ins.type)],
    ];
  }

  /** Window for a Web Audio Module: the plug-in's own interface. */
  private renderWam(ins: Insert, ownerName: string, color: string, instrumentTrack?: string) {
    const ref = instrumentTrack ? this.cmd.store.track(instrumentTrack)!.instrument!.wam! : ins.wam!;
    const body = h('div', { class: 'pw-wam' }, h('div', { class: 'pw-wam-msg' }, `Loading ${ref.name}…`));
    const head = h('div', { class: 'pw-head' },
      h('span', { class: 'pw-dot', style: { background: color } }),
      h('span', { class: 'pw-title' }, `${ownerName} · ${ref.name}`), ref.vendor ? h('span', { class: 'pw-vendor' }, ref.vendor) : null,
      h('span', { class: 'grow' }),
      instrumentTrack ? (() => { const b: HTMLButtonElement = h('button', { class: 'pw-btn pw-preset', 'aria-haspopup': 'menu', title: 'Change instrument', onClick: () => openMenu(b, instrumentMenu(this.cmd, instrumentTrack)) }, 'Instrument', icon('chevron', 10)); return b; })() : null,
      instrumentTrack ? h('button', { class: 'pw-btn', title: 'Musical Typing (⌘K)', 'aria-label': 'Show Musical Typing', onClick: () => { if (!this.cmd.store.ui.showKeyboard) this.cmd.toggleKeyboard(); } }, icon('piano', 14)) : null,
      !instrumentTrack ? h('button', { class: 'pw-btn' + (ins.bypass ? '' : ' on'), 'aria-pressed': String(!ins.bypass), title: ins.bypass ? 'Enable' : 'Bypass', 'aria-label': ins.bypass ? 'Enable plug-in' : 'Bypass plug-in', onClick: () => this.cmd.toggleBypass(this.owner, ins.id) }, icon('power', 14)) : null,
      !instrumentTrack ? h('button', { class: 'pw-btn', title: 'Remove plug-in', 'aria-label': 'Remove plug-in', onClick: () => this.cmd.removePlugin(this.owner, ins.id) }, 'Remove') : null,
      h('button', { class: 'pw-btn', title: 'Close', 'aria-label': 'Close plug-in window', onClick: () => this.close() }, '×'));
    const win = h('div', { class: 'plugin-win wam-win' + (ins.bypass ? ' bypassed' : ''), role: 'dialog', 'aria-label': `${ref.name} on ${ownerName}` }, head, body);
    this.knobs = []; this.canvas = null; this.grFill = null; this.grText = null;
    this.mount(win, head);
    const p: Promise<any> | undefined = instrumentTrack ? this.cmd.engine.wamInstrument(instrumentTrack) : (this.cmd.engine.plugin(this.owner, ins.id) as any)?.wam;
    const key = this.insId + this.owner;
    if (!p) { body.firstElementChild!.textContent = 'The plug-in is not loaded. Check the internet connection, then reopen this window.'; return; }
    p.then(async inst => {
      if (!this.el || this.insId + this.owner !== key) return;
      this.dropWamGui();
      const gui = await inst.createGui();
      body.replaceChildren(gui);
      this.wamGui = { el: gui, inst };
    }).catch(e => { body.firstElementChild!.textContent = `Couldn't load ${ref.name}: ${(e as Error)?.message ?? e}`; });
  }

  private render() {
    const ins = this.ins(); if (!ins) return;
    this.dropWamGui();
    if (this.insId === 'inst') {
      const t = this.cmd.store.track(this.owner)!;
      if (t.instrument?.type === 'wam') return this.renderWam(ins, t.name, t.color, t.id);
      return this.renderInstrument(ins);
    }
    if (ins.type === 'native') return this.renderNativeWin(ins);
    if (ins.type === 'wam') {
      const { store } = this.cmd;
      return this.renderWam(ins, this.owner === 'master' ? 'Stereo Out' : store.track(this.owner)?.name ?? '', this.owner === 'master' ? '#9aa0aa' : store.track(this.owner)?.color ?? '#9aa0aa');
    }
    const def = PLUGINS[ins.type];
    const { store } = this.cmd;
    const ownerName = this.owner === 'master' ? 'Stereo Out' : store.track(this.owner)?.name ?? '';
    const color = this.owner === 'master' ? '#9aa0aa' : store.track(this.owner)?.color ?? '#9aa0aa';
    this.knobs = def.params.map(p => control(this.cmd, this.owner, ins, p));
    this.canvas = null; this.grFill = null; this.grText = null;
    let viz: HTMLElement | null = null;
    if (ins.type === 'eq' || ins.type === 'geq' || ins.type === 'veq') { this.canvas = h('canvas', { class: 'pw-eq', 'aria-label': 'EQ curve' }); viz = this.canvas; }
    if (ins.type === 'analyzer') { this.canvas = h('canvas', { class: 'pw-eq pw-spec', 'aria-label': 'Spectrum' }); viz = this.canvas; }
    if (ins.type === 'transient') { /* gain-change display */ }
    if (ins.type === 'comp' || ins.type === 'limiter' || ins.type === 'gate' || ins.type === 'deesser' || ins.type === 'multi') {
      this.grFill = h('div', { class: 'pw-gr-fill' }); this.grText = h('span', { class: 'pw-gr-val' }, '0.0 dB');
      viz = h('div', { class: 'pw-gr' }, h('span', { class: 'pw-gr-label' }, 'Gain Reduction'), h('div', { class: 'pw-gr-bar' }, this.grFill), this.grText);
    }
    const head = h('div', { class: 'pw-head' },
      h('span', { class: 'pw-dot', style: { background: color } }),
      h('span', { class: 'pw-title' }, `${ownerName} · ${def.name}`),
      h('span', { class: 'grow' }),
      (() => { const b: HTMLButtonElement = h('button', { class: 'pw-btn pw-preset', 'aria-haspopup': 'menu', title: 'Presets and settings', onClick: () => openMenu(b, this.presetMenu(ins)) }, this.presetLabel(ins), icon('chevron', 10)); return b; })(),
      h('button', { class: 'pw-btn' + (ins.bypass ? '' : ' on'), 'aria-pressed': String(!ins.bypass), title: ins.bypass ? 'Enable' : 'Bypass', 'aria-label': ins.bypass ? 'Enable plug-in' : 'Bypass plug-in', onClick: () => this.cmd.toggleBypass(this.owner, ins.id) }, icon('power', 14)),
      h('button', { class: 'pw-btn', title: 'Remove plug-in', 'aria-label': 'Remove plug-in', onClick: () => this.cmd.removePlugin(this.owner, ins.id) }, 'Remove'),
      h('button', { class: 'pw-btn', title: 'Close', 'aria-label': 'Close plug-in window', onClick: () => this.close() }, '×'));
    const win = h('div', { class: 'plugin-win' + (ins.bypass ? ' bypassed' : ''), role: 'dialog', 'aria-label': `${def.name} on ${ownerName}` },
      head, viz, h('div', { class: 'pw-knobs' }, this.knobs.map(k => (k as any).el)));
    this.mount(win, head);
  }

  /** Native VST3/AU plug-in: generic parameter list (the plug-in runs offline, as a freeze). */
  private renderNativeWin(ins: Insert) {
    const c = this.cmd, st = c.store, ref = ins.native!, t = st.track(this.owner);
    const ownerName = this.owner === 'master' ? 'Stereo Out' : t?.name ?? '';
    const status = h('div', { class: 'pw-native-status' });
    const list = h('div', { class: 'pw-native-params' }, h('div', { class: 'pw-wam-msg' }, 'Reading parameters…'));
    const head = h('div', { class: 'pw-head' },
      h('span', { class: 'pw-dot', style: { background: t?.color ?? '#9aa0aa' } }),
      h('span', { class: 'pw-title' }, `${ownerName} · ${ref.name}`), h('span', { class: 'pw-vendor' }, [ref.vendor, ref.format].filter(Boolean).join(' · ')),
      h('span', { class: 'grow' }),
      t ? h('button', { class: 'pw-btn', title: 'Render the track through the plug-in now', onClick: () => c.freezer?.freeze(t) }, 'Render Now') : null,
      h('button', { class: 'pw-btn' + (ins.bypass ? '' : ' on'), 'aria-pressed': String(!ins.bypass), title: ins.bypass ? 'Enable' : 'Bypass', 'aria-label': ins.bypass ? 'Enable plug-in' : 'Bypass plug-in', onClick: () => c.toggleBypass(this.owner, ins.id) }, icon('power', 14)),
      h('button', { class: 'pw-btn', title: 'Remove plug-in', onClick: () => c.removePlugin(this.owner, ins.id) }, 'Remove'),
      h('button', { class: 'pw-btn', title: 'Close', 'aria-label': 'Close plug-in window', onClick: () => this.close() }, '×'));
    const win = h('div', { class: 'plugin-win native-win' + (ins.bypass ? ' bypassed' : ''), role: 'dialog', 'aria-label': `${ref.name} on ${ownerName}` }, head, status, list);
    this.knobs = []; this.canvas = null; this.grFill = null; this.grText = null;
    this.mount(win, head);
    const showStatus = () => {
      const f = c.freezer;
      status.textContent = this.owner === 'master' ? 'Native plug-ins work on track channels (they render the track offline).'
        : !t ? '' : f?.rendering(t) ? '⟳ Rendering the track through the plug-in…' : f?.fresh(t) ? '❄ Up to date: playback uses the rendered (frozen) track.' : 'Changes are rendered automatically a moment after you stop editing.';
    };
    showStatus();
    this.nativeStatus = showStatus;
    hostingAvailable().then(async (ok: boolean) => {
      if (!ok) { list.replaceChildren(h('div', { class: 'pw-wam-msg' }, 'This build of the app can list VST3/AU plug-ins but not run them yet. Build the desktop app with the “native-plugins” feature (see PACKAGING.md).')); return; }
      try {
        const params = await nativeParams(ref);
        list.replaceChildren(...params.filter(p => p.name).slice(0, 200).map(p => {
          const v = ref.params?.[p.id] ?? p.value;
          const val = h('span', { class: 'np-val' }, p.display);
          const r = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: String(v), 'aria-label': p.name }) as HTMLInputElement;
          r.addEventListener('pointerdown', () => st.checkpoint());
          r.addEventListener('input', () => { c.setNativeParam(this.owner, ins.id, p.id, parseFloat(r.value)); val.textContent = `${Math.round(parseFloat(r.value) * 100)}%`; });
          return h('label', { class: 'np-row' }, h('span', { class: 'np-name' }, p.name), r, val);
        }));
      } catch (e) { list.replaceChildren(h('div', { class: 'pw-wam-msg' }, `Couldn't open ${ref.name}: ${(e as Error)?.message ?? e}`)); }
    });
  }
  private nativeStatus: (() => void) | null = null;
  private libStatus: (() => void) | null = null;

  private presetLabel(ins: Insert) {
    const def = PLUGINS[ins.type];
    const all = { ...(def.presets ?? {}), ...pluginPrefs.userPresets(ins.type) };
    const hit = Object.entries(all).find(([, p]) => Object.keys(p).every(k => Math.abs((ins.params[k] ?? 0) - p[k]) < 1e-6));
    if (hit) return hit[0];
    return Object.keys(defaultParams(ins.type)).every(k => Math.abs(ins.params[k] - defaultParams(ins.type)[k]) < 1e-6) ? 'Default' : 'Custom';
  }

  private renderInstrument(ins: Insert) {
    const { store } = this.cmd;
    const t = store.track(this.owner)!, inst = t.instrument!, def = INSTRUMENTS[inst.type];
    const gm = inst.type === 'gm';
    this.knobs = def.params.filter(p => !(gm && p.id === 'program')).map(p => p.options ? choice(this.cmd, this.owner, ins, p) : knob(this.cmd, this.owner, ins, p));
    this.canvas = null; this.grFill = null; this.grText = null;
    const presetBtn: HTMLButtonElement = gm
      ? h('button', { class: 'pw-btn pw-preset pw-lib', 'aria-haspopup': 'menu', title: 'Choose an instrument from the Sound Library',
          onClick: () => openMenu(presetBtn, gmLibraryMenu(p => this.cmd.setGmProgram(t.id, p), Math.round(inst.params.program))) }, gmName(inst.params.program), icon('chevron', 10))
      : h('button', { class: 'pw-btn pw-preset', 'aria-haspopup': 'menu', title: 'Presets',
          onClick: () => openMenu(presetBtn, Object.keys(def.presets).map(n => [n, '', () => this.cmd.setPreset(t.id, n), n === inst.preset] as MenuItem)) }, inst.preset, icon('chevron', 10));
    const head = h('div', { class: 'pw-head' },
      h('span', { class: 'pw-dot', style: { background: t.color } }),
      h('span', { class: 'pw-title' }, `${t.name} · ${def.name}`),
      h('span', { class: 'grow' }), presetBtn,
      (() => { const b: HTMLButtonElement = h('button', { class: 'pw-btn pw-preset', 'aria-haspopup': 'menu', title: 'Change instrument', onClick: () => openMenu(b, instrumentMenu(this.cmd, t.id)) }, 'Instrument', icon('chevron', 10)); return b; })(),
      h('button', { class: 'pw-btn', title: 'Musical Typing (⌘K)', 'aria-label': 'Show Musical Typing', onClick: () => { if (!store.ui.showKeyboard) this.cmd.toggleKeyboard(); } }, icon('piano', 14)),
      h('button', { class: 'pw-btn', title: 'Close', 'aria-label': 'Close instrument window', onClick: () => this.close() }, '×'));
    const libStatus = gm ? h('div', { class: 'pw-libstatus' }) : null;
    const showLib = () => {
      if (!libStatus) return;
      const p = inst.params.program;
      libStatus.textContent = bankReady(p) ? `🎹 ${gmName(p)} — sampled (FluidR3 GM)` : bankFailed(p)
        ? `⚠ Couldn't download ${gmName(p)} (internet needed once; it is kept for offline use afterwards). A synth stands in for now.`
        : `⟳ Loading ${gmName(p)} samples…`;
      libStatus.classList.toggle('warn', bankFailed(p));
    };
    showLib(); this.libStatus = showLib;
    const sampleBar = inst.type === 'sampler' ? h('div', { class: 'pw-sample' },
      h('span', { class: 'pw-sample-name' }, inst.sampleName ? `Sample: ${inst.sampleName}` : 'No sample loaded. Load one or drop an audio file here.'),
      h('button', { class: 'pw-btn', onClick: () => this.cmd.pickSample(t.id) }, 'Load Sample…')) : null;
    const win = h('div', { class: 'plugin-win inst-win', role: 'dialog', 'aria-label': `${def.name} on ${t.name}` },
      head, libStatus, sampleBar, h('div', { class: 'pw-knobs' }, this.knobs.map(k => (k as any).el)));
    if (inst.type === 'sampler') {
      win.addEventListener('dragover', e => { e.preventDefault(); win.classList.add('drop'); });
      win.addEventListener('dragleave', () => win.classList.remove('drop'));
      win.addEventListener('drop', e => { e.preventDefault(); win.classList.remove('drop'); const f = e.dataTransfer?.files?.[0]; if (f) this.cmd.loadSample(t.id, f); });
    }
    this.mount(win, head);
  }

  private mount(win: HTMLElement, head: HTMLElement) {
    if (this.el) this.el.replaceWith(win); else document.body.appendChild(win);
    this.el = win;
    if (this.pos && innerWidth > 700) { win.style.left = `${this.pos.x}px`; win.style.top = `${this.pos.y}px`; }
    // drag by header
    head.addEventListener('pointerdown', e => {
      if ((e.target as HTMLElement).closest('button') || innerWidth <= 700) return;
      const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        this.pos = { x: Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)), y: Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) };
        win.style.left = `${this.pos.x}px`; win.style.top = `${this.pos.y}px`;
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
    });
  }

  frame() {
    if (!this.el) return;
    const inst = this.cmd.engine.plugin(this.owner, this.insId);
    if (this.canvas && inst?.eqNodes) this.drawEq(inst.eqNodes);
    if (this.canvas && inst?.analyser) this.drawSpectrum(inst.analyser);
    if (this.grFill && inst?.reduction) {
      const r = Math.min(0, inst.reduction());
      this.grFill.style.width = `${Math.min(100, (-r / 30) * 100)}%`;
      this.grText!.textContent = `${r.toFixed(1)} dB`;
    }
  }

  private spec: Float32Array<ArrayBuffer> | null = null;
  /** Analyzer: log-frequency spectrum with a dB grid. */
  private drawSpectrum(an: AnalyserNode) {
    const c = this.canvas!, dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.spec || this.spec.length !== an.frequencyBinCount) this.spec = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(this.spec);
    const sr = an.context.sampleRate, lo = an.minDecibels, hi = an.maxDecibels;
    g.fillStyle = '#111214'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#2a2c31'; g.fillStyle = '#6a6d75'; g.font = '9px Inter, sans-serif'; g.lineWidth = 1;
    const xOf = (f: number) => (Math.log10(f / 20) / 3) * W;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, H - 3); }
    for (let d = Math.ceil(lo / 12) * 12; d < hi; d += 12) { const y = Math.round(((hi - d) / (hi - lo)) * H) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(`${d}`, 2, y - 2); }
    const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, '#4c9affcc'); grad.addColorStop(1, '#4c9aff10');
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 1.5) {
      const f = 20 * Math.pow(1000, x / W), bin = Math.min(this.spec.length - 1, Math.round(f / (sr / 2) * this.spec.length));
      const v = Math.max(lo, Math.min(hi, this.spec[bin])); g.lineTo(x, ((hi - v) / (hi - lo)) * H);
    }
    g.lineTo(W, H); g.closePath(); g.fillStyle = grad; g.fill(); g.strokeStyle = '#8fbfff'; g.stroke();
  }

  private freqs = (() => { const f = new Float32Array(240); for (let i = 0; i < f.length; i++) f[i] = 20 * Math.pow(1000, i / (f.length - 1)); return f; })();
  private mag = new Float32Array(240);
  private ph = new Float32Array(240);

  private drawEq(nodes: BiquadFilterNode[]) {
    const c = this.canvas!;
    const dpr = devicePixelRatio || 1, w = c.clientWidth, hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#121316'; g.fillRect(0, 0, w, hh);
    const xOf = (f: number) => Math.log(f / 20) / Math.log(1000) * w, yOf = (db: number) => hh / 2 - db / 20 * (hh / 2 - 8);
    g.font = '10px "JetBrains Mono", monospace'; g.fillStyle = '#7d8088'; g.textBaseline = 'top';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(f)) + 0.5; g.fillStyle = '#24262b'; g.fillRect(x, 0, 1, hh);
      g.fillStyle = '#7d8088'; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, hh - 13);
    }
    for (const db of [-12, -6, 0, 6, 12]) { g.fillStyle = db === 0 ? '#3a3c42' : '#24262b'; g.fillRect(0, Math.round(yOf(db)) + 0.5, w, 1); }
    const total = new Float32Array(this.freqs.length).fill(1);
    for (const n of nodes) { n.getFrequencyResponse(this.freqs, this.mag, this.ph); for (let i = 0; i < total.length; i++) total[i] *= this.mag[i]; }
    const ins = this.ins();
    g.beginPath();
    for (let i = 0; i < total.length; i++) { const x = xOf(this.freqs[i]), y = yOf(Math.max(-24, 20 * Math.log10(total[i] || 1e-6))); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = ins?.bypass ? '#6a6d75' : '#4c9aff'; g.lineWidth = 2; g.stroke();
    g.lineTo(w, yOf(0)); g.lineTo(0, yOf(0)); g.closePath();
    g.fillStyle = ins?.bypass ? '#6a6d7522' : '#4c9aff22'; g.fill();
  }
}
