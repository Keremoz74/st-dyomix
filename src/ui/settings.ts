// Settings window (Logic: Settings / Preferences, ⌘,): General, Audio, Recording & MIDI, Key Commands, Plug-in Manager, Web Audio Modules.
import { Commands } from '../commands';
import { KeyMap, eventCombo, prettyCombo } from '../keycommands';
import { generalPrefs, saveGeneralPrefs, GENERAL_DEFAULTS } from '../general-prefs';
import { audioPrefs, saveAudioPrefs, AUDIO_DEFAULTS } from '../audio/prefs';
import { PLUGIN_LIST, CATEGORIES } from '../audio/plugins';
import { pluginPrefs } from '../plugin-prefs';
import { wamSettings, DEFAULT_SDK, DEFAULT_CATALOG, fetchCatalog } from '../audio/wam';
import { KEY_NAMES } from '../notation';
import { cacheAllInstruments, GM, loadBank, bankInfo } from '../audio/gm';
import { inDesktopApp, hostingAvailable } from '../audio/native';
import { refreshNativeList } from './pluginmenu';
import { h, toast } from './dom';

declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

type Tab = 'general' | 'audio' | 'recording' | 'keys' | 'plugins' | 'wam';
const TABS: [Tab, string][] = [['general', 'General'], ['audio', 'Audio'], ['recording', 'Recording & MIDI'], ['keys', 'Key Commands'], ['plugins', 'Plug-in Manager'], ['wam', 'Web Audio Modules']];

export class SettingsWindow {
  private el: HTMLElement | null = null;
  private tab: Tab = 'general';
  private body!: HTMLElement;
  private keyFilter = '';
  private listening: string | null = null;
  private needsRestart = false;

  constructor(private cmd: Commands, private keymap: KeyMap) {
    // while Settings is open it gets the keyboard first (shortcut capture; app shortcuts stay off)
    addEventListener('keydown', e => {
      if (!this.el) return;
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && !this.listening;
      if (typing && e.key !== 'Escape') return;
      e.stopPropagation();
      this.onKey(e);
    }, true);
  }

  open(tab?: string) {
    if (tab && TABS.some(t => t[0] === tab)) this.tab = tab as Tab;
    this.render();
  }
  close() { this.el?.remove(); this.el = null; this.listening = null; }

  private render() {
    this.body = h('div', { class: 'set-body' });
    const nav = h('nav', { class: 'set-nav', role: 'tablist', 'aria-label': 'Settings sections' },
      TABS.map(([id, label]) => h('button', { class: 'set-tab' + (this.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(this.tab === id), onClick: () => { this.tab = id; this.render(); } }, label)));
    const win = h('div', { class: 'set-win', role: 'dialog', 'aria-label': 'Settings' },
      h('div', { class: 'set-head' }, h('span', { class: 'set-title' }, 'Settings'), h('span', { class: 'grow' }),
        h('button', { class: 'tool-btn', 'aria-label': 'Close settings', onClick: () => this.close() }, '×')),
      h('div', { class: 'set-main' }, nav, this.body));
    const overlay = h('div', { class: 'pb-overlay', onClick: (e: MouseEvent) => { if (e.target === overlay) this.close(); } }, win);
    if (this.el) this.el.replaceWith(overlay); else document.body.appendChild(overlay);
    this.el = overlay;
    ({ general: () => this.general(), audio: () => this.audio(), recording: () => this.recording(), keys: () => this.keys(), plugins: () => this.plugins(), wam: () => this.wam() })[this.tab]();
  }

  // ---------- small form helpers ----------
  private row(label: string, control: Node, hint?: string) {
    return h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, label, hint ? h('div', { class: 'set-hint' }, hint) : null), h('div', { class: 'set-ctl' }, control));
  }
  private select<T extends string | number>(value: T, opts: [T, string][], onChange: (v: T) => void, label: string) {
    const s = h('select', { class: 'set-select', 'aria-label': label }, opts.map(([v, n]) => h('option', { value: String(v), selected: v === value || undefined }, n))) as HTMLSelectElement;
    s.addEventListener('change', () => { const o = opts[s.selectedIndex]; onChange(o[0]); });
    return s;
  }
  private check(value: boolean, onChange: (v: boolean) => void, label: string) {
    const c = h('input', { type: 'checkbox', class: 'set-check', 'aria-label': label, checked: value || undefined }) as HTMLInputElement;
    c.addEventListener('change', () => onChange(c.checked));
    return c;
  }
  private number(value: number, min: number, max: number, step: number, onChange: (v: number) => void, label: string, unit = '') {
    const i = h('input', { type: 'number', class: 'set-num', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label }) as HTMLInputElement;
    i.addEventListener('change', () => { const v = Math.max(min, Math.min(max, parseFloat(i.value))); if (isFinite(v)) { i.value = String(v); onChange(v); } });
    i.addEventListener('keydown', e => e.stopPropagation());
    return h('span', { class: 'set-numwrap' }, i, unit ? h('span', { class: 'set-unit' }, unit) : null);
  }
  private section(title: string, ...rows: (Node | null)[]) { return h('section', { class: 'set-sec' }, h('h3', {}, title), ...rows); }

  // ---------- tabs ----------
  private general() {
    const g = generalPrefs(), s = (p: Partial<typeof g>) => saveGeneralPrefs(p);
    const accents: [string, string][] = [['#4c9aff', 'Blue'], ['#35c46b', 'Green'], ['#ff9f43', 'Orange'], ['#b36bff', 'Purple'], ['#ff5d8f', 'Pink'], ['#f5c542', 'Yellow']];
    this.body.replaceChildren(
      this.section('Appearance',
        this.row('Interface size', this.select(g.uiScale, [[80, '80%'], [90, '90%'], [100, '100%'], [110, '110%'], [125, '125%'], [140, '140%']], v => s({ uiScale: v }), 'Interface size')),
        this.row('Accent color', h('div', { class: 'set-swatches', role: 'radiogroup', 'aria-label': 'Accent color' }, accents.map(([c, n]) => h('button', { class: 'set-swatch' + (g.accent === c ? ' on' : ''), role: 'radio', 'aria-checked': String(g.accent === c), 'aria-label': n, title: n, style: { background: c }, onClick: () => { s({ accent: c }); this.render(); } })))),
        this.row('Show help tags', this.check(g.showTooltips, v => s({ showTooltips: v }), 'Show help tags'), 'Tooltips when hovering buttons'),
        this.row('Follow playhead', this.check(g.followPlayhead, v => s({ followPlayhead: v }), 'Follow playhead'), 'Scroll the tracks along while playing')),
      this.section('Project handling',
        this.row('Autosave', this.check(g.autosave, v => s({ autosave: v }), 'Autosave'), 'Keep the project saved in this browser/app automatically'),
        this.row('Autosave after', this.number(g.autosaveDelay, 1, 60, 0.5, v => s({ autosaveDelay: v }), 'Autosave delay', 's'), 'Seconds after the last change'),
        this.row('Undo steps', this.number(g.undoSteps, 20, 1000, 10, v => s({ undoSteps: v }), 'Undo steps'))),
      this.section('New projects',
        this.row('Tempo', this.number(g.newTempo, 20, 300, 1, v => s({ newTempo: v }), 'Default tempo', 'BPM')),
        this.row('Time signature', this.select(g.newSigNum, [[2, '2/4'], [3, '3/4'], [4, '4/4'], [5, '5/4'], [6, '6/4'], [7, '7/4']], v => s({ newSigNum: v }), 'Default time signature')),
        this.row('Key', this.select(g.newKey, Array.from({ length: 13 }, (_, i) => [i - 6, KEY_NAMES[i - 6]] as [number, string]), v => s({ newKey: v }), 'Default key'))),
      this.section('Metronome',
        this.row('Sound', this.select(g.clickSound, [['beep', 'Beep'], ['wood', 'Woodblock'], ['hihat', 'Hi-Hat']], v => s({ clickSound: v }), 'Metronome sound')),
        this.row('Level', this.number(g.clickLevel, 0, 100, 5, v => s({ clickLevel: v }), 'Metronome level', '%'))),
      h('div', { class: 'set-foot' }, h('button', { class: 'tool-btn', onClick: () => { saveGeneralPrefs({ ...GENERAL_DEFAULTS }); this.render(); } }, 'Reset General Settings'),
        h('span', { class: 'grow' }), h('img', { class: 'set-logo', alt: '', src: (document.querySelector('link[rel=icon]') as HTMLLinkElement | null)?.href ?? '' }), h('span', { class: 'set-hint' }, `Ozmix Studio ${APP_VERSION}`)));
  }

  private async audio() {
    const a = audioPrefs(), ctx = this.cmd.engine.ctx;
    let outs: MediaDeviceInfo[] = [];
    try { outs = (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default'); } catch { /* */ }
    const canSink = typeof (ctx as any).setSinkId === 'function';
    const restart = (p: Partial<typeof a>) => { saveAudioPrefs(p); this.needsRestart = true; this.render(); };
    const lat = (ctx.baseLatency + ((ctx as any).outputLatency || 0)) * 1000;
    this.body.replaceChildren(
      this.section('Device',
        this.row('Output device', canSink
          ? this.select(a.outputId, [['', 'System Default'], ...outs.map((d, i) => [d.deviceId, d.label || `Output ${i + 1}`] as [string, string])], v => { saveAudioPrefs({ outputId: v }); (ctx as any).setSinkId(v).then(() => toast('Output device changed')).catch((e: Error) => toast(`Couldn't switch output: ${e.message}`)); }, 'Output device')
          : h('span', { class: 'set-hint' }, 'Chosen by the system on this platform'), outs.length || !canSink ? undefined : 'Device names appear after allowing microphone access once'),
        this.row('Sample rate', this.select(a.sampleRate, [[0, `Device default (${ctx.sampleRate} Hz)`], [44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz']], v => restart({ sampleRate: v }), 'Sample rate')),
        this.row('Buffer / latency', this.select(String(a.latency), [['interactive', 'Low (interactive)'], ['balanced', 'Medium (balanced)'], ['playback', 'Large (most stable)']], v => restart({ latency: v as any }), 'Latency'),
          `Current output latency ≈ ${lat.toFixed(1)} ms. Larger buffers avoid crackles with many plug-ins.`),
        this.needsRestart ? h('div', { class: 'set-note' }, 'Sample rate and buffer changes take effect after restarting the audio engine. ',
          h('button', { class: 'tool-btn', onClick: async () => { await this.cmd.autosave?.save(); location.reload(); } }, 'Restart Now')) : null),
      this.section('Sound Library',
        h('p', { class: 'set-hint' }, `${GM.length - 1} real instruments + a GM drum kit, sampled from the FluidR3 GM SoundFont by Frank Wen (MIT / CC-BY 3.0). Each instrument downloads the first time it is used and is then kept on this device. Grand Piano, Electric Piano 1 and Acoustic Bass play high-quality multi-velocity recordings: Splendid Grand Piano (Public Domain), jRhodes3d by J. Learman (CC0) and D. Smolken's double bass (CC0).`),
        (() => {
          const status = h('span', { class: 'set-hint' });
          const btn: HTMLButtonElement = h('button', { class: 'tool-btn', onClick: async () => {
            btn.disabled = true;
            const bad = await cacheAllInstruments((d, n, f) => { status.textContent = `${d} / ${n}${f ? ` (${f} failed)` : ''}`; });
            status.textContent = bad ? `Done, ${bad} couldn't be downloaded — try again later.` : 'All instruments are available offline.';
            btn.disabled = false;
          } }, 'Download All Instruments for Offline Use');
          const tStatus = h('span', { class: 'set-hint' });
          const test: HTMLButtonElement = h('button', { class: 'tool-btn', onClick: async () => {
            test.disabled = true; tStatus.textContent = 'Testing Grand Piano and the drum kit…';
            const t0 = performance.now();
            const r = await Promise.all([0, 128, 32, 4].map(p => loadBank(p).then(b => `${GM[p][1]}: ${b.size} samples, ${bankInfo.get(`${GM[p][0]}-mp3.js`) ?? 'built in'}`).catch(e => `${GM[p][1]}: ${bankInfo.get(`${GM[p][0]}-mp3.js`) ?? (e as Error).message}`)));
            tStatus.textContent = `${r.join(' · ')} (${Math.round(performance.now() - t0)} ms)`;
            const sm = this.cmd.engine; const tr = this.cmd.store.project.tracks.find(x => x.instrument?.type === 'gm');
            if (tr) sm.audition(tr.id, 60, 100);
            test.disabled = false;
          } }, 'Test Sounds');
          return h('div', {}, h('div', { class: 'set-foot' }, btn, status), h('div', { class: 'set-foot' }, test, tStatus));
        })()),
      this.section('Bounce (File › Bounce)',
        this.row('Sample rate', this.select(a.bounceRate, [[44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz']], v => saveAudioPrefs({ bounceRate: v }), 'Bounce sample rate')),
        this.row('Bit depth', this.select(a.bounceBits, [[16, '16-bit'], [24, '24-bit'], [32, '32-bit float']], v => saveAudioPrefs({ bounceBits: v }), 'Bounce bit depth')),
        this.row('Extra tail', this.number(a.bounceTail, 0, 30, 0.5, v => saveAudioPrefs({ bounceTail: v }), 'Bounce tail', 's'), 'Rendered after the song end, plus reverb/delay tails'),
        this.row('Normalize', this.check(a.normalize, v => saveAudioPrefs({ normalize: v }), 'Normalize'), 'Raise or lower the bounce so its peak is −1 dBFS')),
      h('div', { class: 'set-foot' }, h('button', { class: 'tool-btn', onClick: () => { saveAudioPrefs({ ...AUDIO_DEFAULTS }); this.needsRestart = true; this.render(); } }, 'Reset Audio Settings')));
  }

  private async recording() {
    const ui = this.cmd.store.ui;
    let ins: MediaDeviceInfo[] = [];
    try { ins = (await navigator.mediaDevices?.enumerateDevices?.() ?? []).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default'); } catch { /* */ }
    const midiOk = typeof (navigator as any).requestMIDIAccess === 'function';
    this.body.replaceChildren(
      this.section('Recording',
        this.row('Input device', this.select(ui.inputDeviceId ?? '', [['', 'System Default'], ...ins.map((d, i) => [d.deviceId, d.label || `Microphone ${i + 1}`] as [string, string])], v => this.cmd.setInputDevice(v || null), 'Input device')),
        this.row('Count-in', this.select(ui.countIn, [[0, 'Off'], [1, '1 bar'], [2, '2 bars']], v => this.cmd.setCountIn(v), 'Count-in')),
        this.row('Recording offset', this.number(ui.latencyMs, -500, 500, 1, v => this.cmd.setLatency(v), 'Recording offset', 'ms'), 'Shifts new recordings to compensate for interface latency')),
      this.section('MIDI',
        this.row('MIDI input', midiOk ? h('button', { class: 'tool-btn', onClick: () => this.cmd.connectMidi() }, 'Connect MIDI Devices') : h('span', { class: 'set-hint' }, 'Web MIDI is not available on this platform (iPad/Android). Use Musical Typing or the Step Sequencer.'),
          midiOk ? 'Plays the selected instrument track; records when the track is armed' : undefined)));
  }

  private keys() {
    const filter = h('input', { type: 'search', class: 'pb-search', placeholder: 'Search commands or keys', value: this.keyFilter, 'aria-label': 'Search key commands' }) as HTMLInputElement;
    const table = h('div', { class: 'kc-table' });
    const fill = () => {
      const q = this.keyFilter.toLowerCase();
      const groups = [...new Set(this.keymap.list.map(k => k.group))];
      table.replaceChildren(...groups.flatMap(g => {
        const items = this.keymap.list.filter(k => k.group === g && (!q || k.name.toLowerCase().includes(q) || k.keys.some(x => prettyCombo(x).toLowerCase().includes(q))));
        if (!items.length) return [];
        return [h('div', { class: 'kc-group' }, g), ...items.map(kc => {
          const listening = this.listening === kc.id;
          return h('div', { class: 'kc-row' },
            h('span', { class: 'kc-name' }, kc.name),
            h('button', { class: 'kc-key' + (listening ? ' listening' : '') + (this.keymap.isDefault(kc.id) ? '' : ' changed'), 'aria-label': `Key for ${kc.name}: ${kc.keys.map(prettyCombo).join(' or ') || 'none'}. Activate to change.`,
              onClick: () => { this.listening = listening ? null : kc.id; fill(); } }, listening ? 'Press a key…' : (kc.keys.map(prettyCombo).join('  ') || '—')),
            h('button', { class: 'kc-act', title: 'Remove key', 'aria-label': `Remove key for ${kc.name}`, onClick: () => { this.keymap.assign(kc.id, ''); fill(); } }, '⌫'),
            h('button', { class: 'kc-act', title: 'Reset to default', 'aria-label': `Reset ${kc.name}`, disabled: this.keymap.isDefault(kc.id) || undefined, onClick: () => { this.keymap.reset(kc.id); fill(); } }, '↺'));
        })];
      }));
    };
    this.refillKeys = fill;
    filter.addEventListener('input', () => { this.keyFilter = filter.value; fill(); });
    filter.addEventListener('keydown', e => e.stopPropagation());
    fill();
    this.body.replaceChildren(
      h('p', { class: 'set-hint' }, 'Click a key, then press the new shortcut. A key used by another command moves to this one. Esc cancels.'),
      filter, table,
      h('div', { class: 'set-foot' }, h('button', { class: 'tool-btn', onClick: () => { this.keymap.reset(); fill(); toast('All key commands reset'); } }, 'Reset All to Defaults')));
  }
  private refillKeys = () => {};

  private onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (this.listening) {
      e.preventDefault();
      if (e.key === 'Escape') { this.listening = null; this.refillKeys(); return; }
      if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return;
      const combo = eventCombo(e), prev = this.keymap.owner(combo);
      this.keymap.assign(this.listening, combo);
      if (prev && prev.id !== this.listening) toast(`${prettyCombo(combo)} was moved from “${prev.name}”`);
      this.listening = null; this.refillKeys();
      return;
    }
    if (e.key === 'Escape') this.close();
  }

  private plugins() {
    const rows = CATEGORIES.flatMap(c => {
      const list = PLUGIN_LIST.filter(p => (p.category ?? 'Utility') === c);
      if (!list.length) return [];
      return [h('div', { class: 'kc-group' }, c), ...list.map(p => {
        const presets = Object.keys(pluginPrefs.userPresets(p.type)).length;
        return h('div', { class: 'kc-row' },
          h('span', { class: 'kc-name' }, p.name, h('span', { class: 'set-hint' }, ` ${Object.keys(p.presets ?? {}).length} factory · ${presets} user preset${presets === 1 ? '' : 's'}`)),
          h('label', { class: 'pm-ctl' }, this.check(!pluginPrefs.isHidden(p.type), v => pluginPrefs.setHidden(p.type, !v), `Show ${p.name} in menus`), 'Show'),
          h('button', { class: 'pb-fav' + (pluginPrefs.isFavorite(p.type) ? ' on' : ''), 'aria-label': `Favorite ${p.name}`, 'aria-pressed': String(pluginPrefs.isFavorite(p.type)), onClick: () => { pluginPrefs.toggleFavorite(p.type); this.render(); } }, pluginPrefs.isFavorite(p.type) ? '★' : '☆'));
      })];
    });
    const wams = pluginPrefs.wams;
    this.body.replaceChildren(
      this.section('Built-in plug-ins', h('p', { class: 'set-hint' }, 'Choose which plug-ins appear in the Audio FX menus. Favorites are listed first.'), ...rows),
      this.section('My Web Audio Modules',
        ...(wams.length ? wams.map(w => h('div', { class: 'kc-row' }, h('span', { class: 'kc-name' }, w.name, h('span', { class: 'set-hint' }, ` ${w.isInstrument ? 'Instrument' : 'Effect'}${w.vendor ? ' · ' + w.vendor : ''}`)),
          h('button', { class: 'pb-fav' + (pluginPrefs.isFavorite(w.url) ? ' on' : ''), 'aria-label': `Favorite ${w.name}`, onClick: () => { pluginPrefs.toggleFavorite(w.url); this.render(); } }, pluginPrefs.isFavorite(w.url) ? '★' : '☆'),
          h('button', { class: 'tool-btn', onClick: () => { pluginPrefs.removeWam(w.url); this.render(); } }, 'Remove')))
          : [h('p', { class: 'set-hint' }, 'None yet. Open the Plug-in Browser to add some.')]),
        h('div', { class: 'set-foot' }, h('button', { class: 'tool-btn', onClick: () => { this.close(); this.cmd.openPluginBrowser('fx'); } }, 'Open Plug-in Browser…'))),
      h('div', { class: 'set-foot' }, h('button', { class: 'tool-btn', onClick: () => { pluginPrefs.reset(); this.render(); toast('Plug-in Manager reset'); } }, 'Reset Plug-in Manager')));
  }

  private wam() {
    const cat = h('textarea', { class: 'set-text', rows: '3', 'aria-label': 'Catalog URLs' }, wamSettings.catalogs.join('\n')) as HTMLTextAreaElement;
    const sdk = h('input', { class: 'set-input', type: 'url', value: wamSettings.sdk, 'aria-label': 'WAM SDK URL' }) as HTMLInputElement;
    [cat, sdk].forEach(x => x.addEventListener('keydown', e => e.stopPropagation()));
    const status = h('span', { class: 'set-hint' });
    const save = () => { wamSettings.save({ catalogs: cat.value.split(/\s+/).filter(Boolean), sdk: sdk.value.trim() }); toast('Saved. Reopen the Plug-in Browser to use the new catalog.'); };
    this.body.replaceChildren(
      this.section('Web Audio Modules (WAM 2.0)',
        h('p', { class: 'set-hint' }, 'WAMs are the open plug-in standard for web audio apps — the web’s answer to VST/AU. They load from the internet and run on every platform this app runs on, including iPad and Android tablets.'),
        this.row('Plug-in catalogs', cat, 'One JSON index per line. The WAM community catalog is the default.'),
        this.row('Host SDK', sdk, 'The WAM host library the plug-ins run in'),
        h('div', { class: 'set-foot' },
          h('button', { class: 'tool-btn', onClick: save }, 'Save'),
          h('button', { class: 'tool-btn', onClick: () => { cat.value = DEFAULT_CATALOG; sdk.value = DEFAULT_SDK; save(); } }, 'Use Defaults'),
          h('button', { class: 'tool-btn', onClick: async () => { status.textContent = 'Testing…'; try { const c = await fetchCatalog(); status.textContent = `OK: ${c.length} plug-ins found`; } catch (e) { status.textContent = `Failed: ${(e as Error).message}`; } } }, 'Test Connection'), status)),
      this.nativeSection());
  }

  private nativeSection() {
    const sec = this.section('Native plug-ins (VST3 / Audio Units)');
    if (!inDesktopApp()) {
      sec.append(h('p', { class: 'set-hint' }, 'VST3 and Audio Unit plug-ins installed on a computer run in the desktop app for Mac and Windows. Browsers, iPad and Android tablets can’t run them; use Web Audio Modules there.'));
      return sec;
    }
    const info = h('p', { class: 'set-hint' }, 'Looking for plug-ins…');
    const list = h('div', {});
    const scan = async (re: boolean) => {
      info.textContent = 'Scanning…';
      const [l, ok] = await Promise.all([refreshNativeList(re), hostingAvailable()]);
      info.textContent = `${l.length} plug-in${l.length === 1 ? '' : 's'} found in the standard VST3${navigator.platform.includes('Mac') ? ' and Audio Units' : ''} folders. ` +
        (ok ? 'Tracks that use them are rendered through them offline and play back as a freeze (re-rendered automatically after edits).' : 'This build can list them but not run them: build the desktop app with the “native-plugins” feature.');
      list.replaceChildren(...l.slice(0, 300).map((p: import('../audio/native').NativePluginInfo) => h('div', { class: 'kc-row' }, h('span', { class: 'kc-name' }, p.name, h('span', { class: 'set-hint' }, ` ${[p.vendor, p.format, p.is_instrument ? 'Instrument' : 'Effect'].filter(Boolean).join(' · ')}`)))));
    };
    sec.append(info, h('div', { class: 'set-foot' }, h('button', { class: 'tool-btn', onClick: () => scan(true) }, 'Rescan Plug-ins')), list);
    scan(false);
    return sec;
  }
}
