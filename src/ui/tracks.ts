// Tracks area: local menu bar, track headers, ruler and the canvas timeline with region editing.
import { PlayLine } from './playline';
import { Region, TOOLS, ToolId, SnapMode, PEAK_BUCKET, uid, cloneRegion, isMidi, Note } from '../model';
import { isDrumKit } from '../audio/instruments';
import { Commands } from '../commands';
import { h, icon, openMenu, toast, MenuItem, inlineEdit } from './dom';
import { Track, AutoPoint, COLOR_CHOICES } from '../model';
import { autoParams, findParam, sortPoints, valueAt } from '../automation';
import { isFolder, expandRegion, compOf, trimFolderStart, folderMaxEnd } from '../takes';
import { Take, CompSeg } from '../model';

const RULER_H = 72;
const CYCLE_H = 16;
const BAR_Y = 16, MARK_Y = 40, TEMPO_Y = 56, LANE_H = 16, MOVIE_Y = 72, MOVIE_H = 34;
const MARKER_COLORS = ['#5aa9e6', '#f08a5d', '#9b7bff', '#5fc77f', '#e8c547', '#e86ba8'];
const HDR_W = 236;
import { generalPrefs } from '../general-prefs';
const EDGE = 8;
/** Touch: how long to hold a region before it can be moved (ms). */
const HOLD_MS = 380;
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const K = (s: string) => (mac ? s : s.replace('⌘', 'Ctrl+').replace('⌥', 'Alt+').replace('⇧', 'Shift+'));

type Drag =
  | { kind: 'move'; anchor: Region; orig: Map<string, { start: number; track: number }>; x0: number; y0: number; copy: boolean; started: boolean; lastDr?: number }
  | { kind: 'resizeR' | 'resizeL'; r: Region; origStart: number; origLen: number; origOffset: number; origNotes?: Note[]; origTakes?: Take[]; origComp?: CompSeg[]; x0: number; started: boolean }
  | { kind: 'marquee'; bx: number; by: number; x: number; y: number; base: Set<string> }
  | { kind: 'fade'; r: Region; side: 'in' | 'out'; started: boolean }
  | { kind: 'auto'; t: Track; key: string; pt: AutoPoint; row: number; started: boolean }
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; y: number; sl: number; st: number }
  | { kind: 'cycle'; b0: number; moved: boolean; wasOn: boolean }
  | { kind: 'marker'; id: string; orig: number; x0: number; moved: boolean }
  | { kind: 'punch'; b0: number }
  | { kind: 'tempo'; id: string; orig: number; x0: number; moved: boolean }
  | { kind: 'movie'; orig: number; b0: number; x0: number; moved: boolean };

export class TracksArea {
  el: HTMLElement;
  private hdrList: HTMLElement;
  private hdrCount: HTMLElement;
  private ruler: HTMLCanvasElement;
  private hdrTop!: HTMLElement;
  private movieLabel!: HTMLElement;
  private lanes: HTMLCanvasElement;
  private scroller: HTMLElement;
  private spacer: HTMLElement;
  private toolBtn: HTMLButtonElement;
  private cmdToolBtn: HTMLButtonElement;
  private snapBtn: HTMLButtonElement;
  private drag: Drag | null = null;
  private dirty = true;
  private playLine!: PlayLine;
  private seenLocate = 0;
  private hoverCursor = '';
  private volInputs = new Map<string, HTMLInputElement>();
  private projName!: HTMLInputElement;
  private autoBtn!: HTMLButtonElement;
  private savedEl!: HTMLElement;
  setSaved(t: number) { this.savedEl.textContent = `✓ Saved ${new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`; }
  private hoverPt: AutoPoint | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { d0: number; ppb0: number; beat: number; x: number } | null = null;
  private pressTimer: number | undefined;
  private pressAt: { x: number; y: number } | null = null;
  private lastTap: { id: string; t: number } | null = null;

  constructor(private cmd: Commands) {
    cmd.movie.onThumbs = () => { this.dirty = true; };
    const { store } = cmd;
    const menuBtn = (label: string, items: () => MenuItem[]) => {
      const b: HTMLButtonElement = h('button', { class: 'lm-btn', 'aria-haspopup': 'menu', onClick: () => openMenu(b, items()) }, label);
      return b;
    };
    const fileMenu = menuBtn('File', () => [
      ['New Project', '', cmd.newProject], ['Open Project…', K('⌘O'), cmd.openProject], ['Save Project', K('⌘S'), cmd.saveProject], '-',
      ['Settings…', K('⌘,'), () => cmd.openSettings()], '-',
      ['Open Movie…', K('⌥⌘O'), cmd.openMovie], ...(store.project.movie ? [['Import Audio from Movie', '', cmd.importMovieAudio] as MenuItem, ['Remove Movie', '', cmd.removeMovie] as MenuItem] : []), '-',
      ...(cmd.recentList.filter(r => r.id !== store.project.id).slice(0, 8).map(r => [`Open Recent: ${r.name}`, new Date(r.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), () => cmd.openRecent(r.id)] as MenuItem)),
      ['Demo Song', '', cmd.loadDemoSong],
      ...(cmd.recentList.length ? [['Clear Recent Projects', '', cmd.clearRecent] as MenuItem] : []), '-',
      ['Import Audio File…', K('⇧⌘I'), cmd.importAudio], ['Bounce Project to WAV…', K('⌘B'), cmd.bounce],
    ]);
    const editMenu = menuBtn('Edit', () => [
      ['Undo', K('⌘Z'), cmd.undo], ['Redo', K('⇧⌘Z'), cmd.redo], '-',
      ['Cut', K('⌘X'), cmd.cutRegions], ['Copy', K('⌘C'), cmd.copyRegions], ['Paste at Playhead', K('⌘V'), cmd.pasteRegions],
      ['Delete', '⌫', cmd.deleteSelected], ['Select All', K('⌘A'), cmd.selectAll], '-',
      ['Nudge Left', K('⌥←'), () => cmd.nudgeRegions(-1)], ['Nudge Right', K('⌥→'), () => cmd.nudgeRegions(1)], '-',
      ['Split Regions at Playhead', K('⌘T'), cmd.splitAtPlayhead],
      ['Pack Take Folder', K('⌃⌘F'), cmd.packTakeFolder], ['Flatten Take Folder', '', () => cmd.flattenTakeFolder()], ['Join Regions', K('⌘J'), () => cmd.joinSelected()],
      ['Repeat Regions Once', K('⌘R'), cmd.repeat], ['Mute Regions On/Off', K('⌃M'), cmd.toggleRegionMute],
    ]);
    const fnMenu = menuBtn('Functions', () => [
      ...cmd.newTrackMenu().map(([l, k, f]) => [l, K(k), f] as MenuItem), ['Delete Track', K('⌘⌫'), cmd.deleteTrack], '-',
      ['Connect MIDI Keyboard', '', () => cmd.connectMidi()], '-',
      ['Create Empty MIDI Region', '', () => { const t = store.track(store.ui.selectedTrackId); if (t) cmd.createMidiRegion(t.id, Math.floor(store.ui.playhead / store.beatsPerBar) * store.beatsPerBar); }],
      ['Create Pattern Region', '', () => { const t = store.track(store.ui.selectedTrackId); if (t) cmd.createPatternRegion(t.id, Math.floor(store.ui.playhead / store.beatsPerBar) * store.beatsPerBar); }], '-',
      { label: 'MIDI', sub: [
        ['Transpose +1', K('⌥↑'), () => cmd.transposeRegions(1)], ['Transpose −1', K('⌥↓'), () => cmd.transposeRegions(-1)],
        ['Transpose +12', K('⇧⌥↑'), () => cmd.transposeRegions(12)], ['Transpose −12', K('⇧⌥↓'), () => cmd.transposeRegions(-12)], '-',
        ['Quantize', 'Q', cmd.quantizeRegions],
      ] },
      { label: 'Audio', sub: [['Reverse', '', () => cmd.processAudioRegions('reverse')], ['Normalize', '', () => cmd.processAudioRegions('normalize')]] },
      ['New Track with Duplicate Settings', K('⌘D'), cmd.duplicateTrack],
      ['Bounce in Place', mac ? '⌃B' : K('⌥⌘B'), cmd.bounceInPlace], '-',
      ['Import Audio File…', K('⇧⌘I'), cmd.importAudio], ['Bounce Project to WAV…', K('⌘B'), cmd.bounce],
    ]);
    const viewMenu = menuBtn('View', () => [
      ['Inspector', 'I', cmd.toggleInspector, store.ui.showInspector], ['Mixer', 'X', cmd.toggleMixer, store.ui.showMixer],
      ['Piano Roll', 'P', cmd.toggleEditor, store.ui.showEditor], ['Track Automation', 'A', cmd.toggleAutomation, store.ui.showAuto], ['Musical Typing', K('⌘K'), cmd.toggleKeyboard, store.ui.showKeyboard], ['Movie Window', '', cmd.toggleMovieWindow, !!store.ui.showMovie && !!store.project.movie], '-',
      ['Plug-in Browser…', K('⇧⌘P'), () => cmd.openPluginBrowser('fx')], ['Key Commands…', K('⌥K'), () => cmd.openSettings('keys')], '-',
      ['Zoom In', K('⌘→'), () => cmd.zoom(1.4)], ['Zoom Out', K('⌘←'), () => cmd.zoom(1 / 1.4)], '-',
      ['Taller Tracks', '', () => { store.ui.trackH = Math.min(140, store.ui.trackH + 12); store.emit('view'); }],
      ['Shorter Tracks', '', () => { store.ui.trackH = Math.max(40, store.ui.trackH - 12); store.emit('view'); }],
    ]);

    this.savedEl = h('span', { class: 'saved-badge', title: 'Your work is saved automatically in this browser' });
    this.projName = h('input', { class: 'proj-name', 'aria-label': 'Project name', title: 'Project name' }) as HTMLInputElement;
    this.projName.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') this.projName.blur(); });
    this.projName.addEventListener('change', () => cmd.renameProject(this.projName.value));
    const toolMenu = (cmdSlot: boolean) => (anchor: HTMLButtonElement) => openMenu(anchor,
      TOOLS.map(t => [t.label, cmdSlot ? '' : t.key, () => cmd.setTool(t.id, cmdSlot), (cmdSlot ? store.ui.cmdTool : store.ui.tool) === t.id] as MenuItem));
    this.toolBtn = h('button', { class: 'tool-btn', title: 'Left-click Tool (T)', onClick: () => toolMenu(false)(this.toolBtn) });
    this.cmdToolBtn = h('button', { class: 'tool-btn', title: `${mac ? 'Command' : 'Ctrl'}-click Tool`, onClick: () => toolMenu(true)(this.cmdToolBtn) });
    const snaps: [SnapMode, string][] = [['smart', 'Smart'], ['bar', 'Bar'], ['beat', 'Beat'], ['div', '1/16'], ['off', 'Off']];
    this.snapBtn = h('button', { class: 'sel-btn', onClick: () => openMenu(this.snapBtn, snaps.map(([m, l]) => [l, '', () => { store.ui.snap = m; store.emit('view'); }, store.ui.snap === m] as MenuItem)) });

    this.autoBtn = h('button', { class: 'tool-btn', title: 'Show/hide automation (A)', 'aria-pressed': 'false', onClick: cmd.toggleAutomation }, 'Automation');
    const toolbar = h('div', { class: 'lm-bar' },
      this.projName, this.savedEl, fileMenu, editMenu, fnMenu, viewMenu,
      h('span', { class: 'grow' }),
      this.autoBtn,
      h('span', { class: 'lm-label' }, 'Snap'), this.snapBtn,
      h('span', { class: 'lm-div' }),
      this.toolBtn, this.cmdToolBtn,
      h('span', { class: 'lm-div' }),
      h('button', { class: 'tool-btn', 'aria-label': 'Zoom out', title: 'Zoom out (⌘←)', onClick: () => cmd.zoom(1 / 1.4) }, icon('zoomOut', 16)),
      h('button', { class: 'tool-btn', 'aria-label': 'Zoom in', title: 'Zoom in (⌘→)', onClick: () => cmd.zoom(1.4) }, icon('zoomIn', 16)),
    );

    this.hdrCount = h('span', { class: 'hdr-count' });
    this.hdrList = h('div', { class: 'hdr-list' });
    const hdrCol = h('div', { class: 'hdr-col', style: { width: `${HDR_W}px` } },
      this.hdrTop = h('div', { class: 'hdr-top', style: { height: `${RULER_H}px` } },
       h('div', { class: 'hdr-top-row' },
        (() => { const b: HTMLButtonElement = h('button', { class: 'tool-btn', 'aria-label': 'New Track', 'aria-haspopup': 'menu', title: 'New Track', onClick: () => openMenu(b, cmd.newTrackMenu().map(([l, k, f]) => [l, K(k), f] as MenuItem)) }, icon('plus', 16)); return b; })(),
        this.hdrCount),
       h('div', { class: 'hdr-lane-label' }, 'Marker', h('button', { class: 'hdr-lane-add', 'aria-label': 'Create marker at playhead', title: 'Create marker (⌥\')', onClick: () => { const m = cmd.addMarker(); if (m) this.editMarker(m.id); } }, '+')),
       h('div', { class: 'hdr-lane-label' }, 'Tempo', h('button', { class: 'hdr-lane-add', 'aria-label': 'Add tempo change at playhead', title: 'Add tempo change at playhead', onClick: () => { const e = cmd.addTempoEvent(Math.max(1, Math.round(store.ui.playhead))); if (e) this.editTempo(e.id); } }, '+')),
       this.movieLabel = h('div', { class: 'hdr-lane-label hdr-movie', hidden: true }, 'Movie', (() => { const b: HTMLButtonElement = h('button', { class: 'hdr-lane-add', 'aria-label': 'Movie options', title: 'Movie options', 'aria-haspopup': 'menu', onClick: () => openMenu(b, this.movieMenu()) }, '⋯'); return b; })())),
      this.hdrList);

    this.ruler = h('canvas', { class: 'ruler', style: { height: `${RULER_H}px` } });
    this.lanes = h('canvas', { class: 'lanes' });
    this.spacer = h('div', { class: 'spacer' });
    this.scroller = h('div', { class: 'lanes-scroll' }, this.spacer);
    const tlCol = h('div', { class: 'tl-col' }, this.ruler, h('div', { class: 'lanes-wrap' }, this.lanes, this.scroller));
    this.playLine = new PlayLine(tlCol, 'tl');

    this.el = h('section', { class: 'tracks-area', 'aria-label': 'Tracks' }, toolbar, h('div', { class: 'tracks-main' }, hdrCol, tlCol));

    this.scroller.addEventListener('scroll', () => { this.hdrList.scrollTop = this.scroller.scrollTop; this.dirty = true; });
    this.hdrList.addEventListener('wheel', e => { this.scroller.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    this.scroller.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.scroller.addEventListener('pointerdown', e => this.onDown(e));
    this.scroller.addEventListener('contextmenu', e => { e.preventDefault(); const r = this.hit(e.clientX, e.clientY); if (r) this.regionMenu(r, e.clientX, e.clientY); });
    this.scroller.addEventListener('dblclick', e => {
      if (store.ui.showAuto) {
        const row = this.rowAt(e.clientY), t = store.visibleTracks()[row];
        const pt = t ? this.autoHit(t, row, e.clientX, e.clientY) : null;
        if (t && pt) { store.checkpoint(); const key = t.autoShow ?? 'volume'; t.auto![key] = t.auto![key].filter(x => x !== pt); store.emit('structure'); cmd.autoEdited(); }
        return;
      }
      const r = this.hit(e.clientX, e.clientY); if (r) cmd.openEditor(r.id); });
    this.scroller.addEventListener('pointermove', e => this.onMove(e));
    this.scroller.addEventListener('pointerup', e => this.onUp(e));
    this.scroller.addEventListener('pointercancel', e => this.onUp(e));
    this.scroller.addEventListener('dragover', e => { e.preventDefault(); this.scroller.classList.add('drop'); });
    this.scroller.addEventListener('dragleave', () => this.scroller.classList.remove('drop'));
    this.scroller.addEventListener('drop', e => this.onDrop(e));
    this.ruler.addEventListener('pointerdown', e => this.onRulerDown(e));
    this.ruler.addEventListener('pointermove', e => this.onRulerMove(e));
    this.ruler.addEventListener('pointerup', e => this.onRulerUp(e));
    this.ruler.addEventListener('dblclick', e => this.onRulerDbl(e));
    this.ruler.addEventListener('contextmenu', e => this.onRulerMenu(e));
    new ResizeObserver(() => { this.dirty = true; }).observe(tlCol);

    store.on(k => { if (k === 'structure') this.renderHeaders(); if (k === 'mix') this.refreshVolumes(); if (k === 'view') { this.renderHeaders(); this.renderToolbar(); } this.dirty = true; });
    this.renderHeaders(); this.renderToolbar();
  }

  // ---------- headers ----------
  renderHeaders() {
    const { store } = this.cmd;
    const all = store.project.tracks;
    const tracks = store.visibleTracks();
    const H = store.ui.trackH;
    const n = all.filter(t => t.kind !== 'folder').length;
    this.hdrCount.textContent = `${n} track${n === 1 ? '' : 's'}`;
    const scroll = this.hdrList.scrollTop;
    this.volInputs.clear();
    this.hdrList.replaceChildren(
      ...tracks.map(t => {
        const num = all.indexOf(t) + 1;
        const sel = store.ui.selectedTrackIds.has(t.id) || t.id === store.ui.selectedTrackId;
        const b = (label: string, key: 'mute' | 'solo' | 'armed' | 'monitor', aria: string) =>
          h('button', { class: `tb tb-${key}${t[key] ? ' on' : ''}`, 'aria-label': `${aria} ${t.name}`, 'aria-pressed': String(t[key]), title: aria, onPointerdown: (e: PointerEvent) => e.stopPropagation(), onClick: (e: MouseEvent) => { e.stopPropagation(); this.cmd.toggleTrack(key, t.id); } }, label);
        const name = h('button', { class: 'hdr-name', title: 'Double-click to rename' }, t.name);
        name.addEventListener('dblclick', e => { e.stopPropagation(); this.rename(name, t.id); });
        const vol = h('input', { type: 'range', min: '-60', max: '6', step: '0.5', value: String(t.volume), 'aria-label': `${t.name} volume`, title: 'Volume', class: 'hdr-vol' }) as HTMLInputElement;
        vol.addEventListener('input', () => { t.volume = parseFloat(vol.value); store.emit('mix'); });
        vol.addEventListener('pointerdown', e => e.stopPropagation());
        this.volInputs.set(t.id, vol);
        const dim = t.mute || (all.some(x => x.solo) && !t.solo && !(t.parent && store.track(t.parent)?.solo) && !(t.kind === 'folder' && all.some(x => x.parent === t.id && x.solo)));
        const isFolder = t.kind === 'folder';
        const iconName = isFolder ? 'folder' : t.kind === 'inst' ? (isDrumKit(t.instrument) ? 'drum' : t.instrument?.type === 'sampler' ? 'wave' : 'keys') : 'wave';
        const iconBtn: HTMLButtonElement = h('button', { class: 'hdr-icon', style: { color: t.color, background: t.color + '26' }, 'aria-label': `Track menu for ${t.name}`, title: 'Track menu (or right-click the header)',
          onPointerdown: (e: PointerEvent) => e.stopPropagation(), onClick: (e: MouseEvent) => { e.stopPropagation(); this.trackMenu(iconBtn, t.id, name); } }, icon(iconName, 16));
        const row = h('div', { class: 'hdr' + (sel ? ' selected' : '') + (dim ? ' dim' : '') + (isFolder ? ' folder' : '') + (t.parent ? ' child' : ''), style: { height: `${H}px` },
          onPointerdown: (e: PointerEvent) => { const add = e.shiftKey || e.metaKey || e.ctrlKey; if (add || store.ui.selectedTrackId !== t.id || store.ui.selectedTrackIds.size !== 1) this.cmd.selectTrack(t.id, add); } },
          h('div', { class: 'hdr-color', style: { background: t.color } }),
          isFolder
            ? h('button', { class: 'hdr-disc', 'aria-label': t.collapsed ? `Expand ${t.name}` : `Collapse ${t.name}`, 'aria-expanded': String(!t.collapsed), onPointerdown: (e: PointerEvent) => e.stopPropagation(), onClick: (e: MouseEvent) => { e.stopPropagation(); this.cmd.toggleCollapse(t.id); } }, t.collapsed ? '▸' : '▾')
            : h('span', { class: 'hdr-num' }, String(num)),
          iconBtn,
          h('div', { class: 'hdr-main' }, name, h('div', { class: 'hdr-ctrls' }, b('M', 'mute', 'Mute'), b('S', 'solo', 'Solo'), isFolder ? h('span', { class: 'hdr-stack-n' }, `${store.children(t.id).length} in stack`) : b('R', 'armed', 'Record enable'), t.kind === 'audio' ? b('I', 'monitor', 'Input monitoring') : null, vol),
            store.ui.showAuto ? this.autoRow(t) : null));
        row.addEventListener('contextmenu', e => { e.preventDefault(); this.trackMenu(row, t.id, name); });
        let lp: number | undefined;
        row.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') return; const x0 = e.clientX, y0 = e.clientY; lp = window.setTimeout(() => this.trackMenu(row, t.id, name), 550); const cancel = (ev: PointerEvent) => { if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) { clearTimeout(lp); row.removeEventListener('pointermove', cancel); row.removeEventListener('pointerup', cancel); } }; row.addEventListener('pointermove', cancel); row.addEventListener('pointerup', cancel); });
        return row;
      }),
      h('div', { style: { height: `${H * 3}px` } }));
    this.hdrList.scrollTop = scroll;
  }

  private trackMenu(anchor: HTMLElement, id: string, nameEl: HTMLElement) {
    const { store } = this.cmd;
    const t = store.track(id); if (!t) return;
    const folders = store.project.tracks.filter(x => x.kind === 'folder' && x.id !== t.parent);
    const nSel = new Set([...store.ui.selectedTrackIds, id]).size;
    if (!store.ui.selectedTrackIds.has(id)) this.cmd.selectTrack(id, false);
    openMenu(anchor, [
      ['Rename', '', () => { const el = this.hdrList.querySelectorAll('.hdr-name')[store.visibleTracks().indexOf(t)] as HTMLElement | undefined; this.rename(el ?? nameEl, id); }],
      '-',
      ...COLOR_CHOICES.map(([n, c]) => [`● ${n}`, '', () => this.cmd.setTrackColor(id, c), t.color === c] as MenuItem),
      '-',
      ...(t.kind !== 'folder' ? [[nSel > 1 ? `Create Track Stack (${nSel} tracks)` : 'Create Track Stack', '⇧⌘D', this.cmd.createStack] as MenuItem] : []),
      ...(t.kind !== 'folder' ? folders.map(f => [`Move to “${f.name}”`, '', () => this.cmd.moveToStack(id, f.id)] as MenuItem) : []),
      ...(t.parent ? [['Remove from Stack', '', () => this.cmd.moveToStack(id, null)] as MenuItem] : []),
      '-',
      [t.kind === 'folder' ? 'Delete Stack (keeps its tracks)' : 'Delete Track', '⌘⌫', () => { store.ui.selectedTrackId = id; this.cmd.deleteTrack(); }],
    ]);
  }

  private autoRow(t: Track) {
    const { store } = this.cmd;
    const key = t.autoShow ?? 'volume';
    const params = autoParams(store, t);
    const cur = params.find(p => p.key === key) ?? params[0];
    const mode = t.autoMode ?? 'off';
    const stop = (e: Event) => e.stopPropagation();
    const pb: HTMLButtonElement = h('button', { class: 'auto-btn auto-param', title: 'Automated parameter', onPointerdown: stop, onClick: (e: MouseEvent) => { e.stopPropagation(); openMenu(pb, params.map(p => [`${t.auto?.[p.key]?.length ? '• ' : ''}${p.label}`, '', () => this.cmd.setAutoShow(t.id, p.key), p.key === cur.key] as MenuItem)); } }, cur.label);
    const mb: HTMLButtonElement = h('button', { class: `auto-btn auto-${mode}`, title: 'Automation mode', onPointerdown: stop, onClick: (e: MouseEvent) => { e.stopPropagation(); openMenu(mb, (['off', 'read', 'touch'] as const).map(m => [m[0].toUpperCase() + m.slice(1), '', () => this.cmd.setAutoMode(t.id, m), m === mode] as MenuItem)); } }, mode[0].toUpperCase() + mode.slice(1));
    return h('div', { class: 'hdr-auto' }, mb, pb);
  }

  private refreshVolumes() {
    for (const t of this.cmd.store.project.tracks) {
      const v = this.volInputs.get(t.id);
      if (v && v !== document.activeElement) v.value = String(t.volume);
    }
  }

  private rename(btn: HTMLElement, id: string) {
    const { store } = this.cmd;
    const t = store.track(id); if (!t) return;
    const inp = h('input', { class: 'hdr-rename', value: t.name, 'aria-label': 'Track name' }) as HTMLInputElement;
    btn.replaceWith(inp); inp.focus(); inp.select();
    const done = (save: boolean) => {
      if (save && inp.value.trim() && inp.value.trim() !== t.name) { store.checkpoint(); t.name = inp.value.trim().slice(0, 32); }
      store.emit('structure');
    };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true), { once: true });
  }

  renderToolbar() {
    const { ui } = this.cmd.store;
    this.autoBtn.classList.toggle('on', ui.showAuto); this.autoBtn.setAttribute('aria-pressed', String(ui.showAuto));
    if (document.activeElement !== this.projName) this.projName.value = this.cmd.store.project.name;
    const lab = (id: ToolId) => TOOLS.find(t => t.id === id)!.label;
    this.toolBtn.replaceChildren(icon(ui.tool, 16), h('span', {}, lab(ui.tool)), icon('chevron', 10));
    this.toolBtn.setAttribute('aria-label', `Left-click tool: ${lab(ui.tool)}`);
    this.cmdToolBtn.replaceChildren(h('span', { class: 'cmd-mark' }, '⌘'), icon(ui.cmdTool, 16), icon('chevron', 10));
    this.cmdToolBtn.setAttribute('aria-label', `Command-click tool: ${lab(ui.cmdTool)}`);
    const snapLabels: Record<SnapMode, string> = { smart: 'Smart', bar: 'Bar', beat: 'Beat', div: '1/16', off: 'Off' };
    this.snapBtn.replaceChildren(h('span', {}, snapLabels[ui.snap]), icon('chevron', 10));
  }

  // ---------- geometry ----------
  private get ppb() { return this.cmd.store.ui.pxPerBeat; }
  private beatAt(clientX: number) { const r = this.scroller.getBoundingClientRect(); return Math.max(0, (clientX - r.left + this.scroller.scrollLeft) / this.ppb); }
  private rowAt(clientY: number) { const r = this.scroller.getBoundingClientRect(); return Math.floor((clientY - r.top + this.scroller.scrollTop) / this.cmd.store.ui.trackH); }
  private hit(clientX: number, clientY: number): Region | null {
    const { store } = this.cmd;
    const row = this.rowAt(clientY), t = store.visibleTracks()[row];
    if (!t) return null;
    const b = this.beatAt(clientX);
    const rs = store.project.regions.filter(r => r.trackId === t.id && b >= r.start && b < r.start + r.length);
    return rs[rs.length - 1] ?? null;
  }
  private edgeZone(r: Region, clientX: number): 'L' | 'R' | null {
    const rect = this.scroller.getBoundingClientRect();
    const x = clientX - rect.left + this.scroller.scrollLeft;
    const x0 = r.start * this.ppb, x1 = (r.start + r.length) * this.ppb;
    if (x1 - x0 < EDGE * 3) return null;
    if (x1 - x < EDGE) return 'R';
    if (x - x0 < EDGE) return 'L';
    return null;
  }
  private contentX(clientX: number) { return clientX - this.scroller.getBoundingClientRect().left + this.scroller.scrollLeft; }
  private upperHalf(clientY: number) {
    const H = this.cmd.store.ui.trackH;
    const y = clientY - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    return (y % H) < H / 2;
  }

  scrollToBeat(beat: number) {
    const x = beat * this.ppb, w = this.scroller.clientWidth;
    if (x > this.scroller.scrollLeft + w - 40 || x < this.scroller.scrollLeft) this.scroller.scrollLeft = Math.max(0, x - 40);
  }

  // ---------- pointer: lanes ----------
  private activeTool(e: PointerEvent | MouseEvent): ToolId { const ui = this.cmd.store.ui; return e.metaKey || e.ctrlKey ? ui.cmdTool : ui.tool; }

  private onDown(e: PointerEvent) {
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) { this.startPinch(); return; }
      if (this.touches.size > 2) return;
    }
    if (e.button !== 0) return;
    const { store } = this.cmd, ui = store.ui;
    if (ui.focus !== 'tracks') { ui.focus = 'tracks'; store.emit('view'); }
    const r = this.hit(e.clientX, e.clientY);
    const row = this.rowAt(e.clientY);
    const t = store.visibleTracks()[row];
    if (t && ui.selectedTrackId !== t.id) { ui.selectedTrackId = t.id; store.emit('structure'); }
    const tool = this.activeTool(e);
    if (ui.showAuto && tool === 'pointer' && t && t.kind !== 'aux') { this.autoDown(e, t, row); return; }
    if (tool === 'scissors') { if (r) { const at = store.snapBeat(this.beatAt(e.clientX)); store.checkpoint(); if (this.cmd.splitRegion(r, at)) { store.emit('structure'); this.cmd.engine.resync(); } } return; }
    if (tool === 'eraser') { if (r) { store.checkpoint(); store.project.regions = store.project.regions.filter(x => x.id !== r.id); ui.selectedRegionIds.delete(r.id); store.emit('structure'); this.cmd.engine.resync(); } return; }
    if (tool === 'mute') { if (r) { store.checkpoint(); r.muted = !r.muted; store.emit('structure'); this.cmd.engine.resync(); } return; }
    if (tool === 'fade') {
      if (r && !isMidi(r)) { const mid = (r.start + r.length / 2) * this.ppb; this.scroller.setPointerCapture(e.pointerId); this.drag = { kind: 'fade', r, side: this.contentX(e.clientX) < mid ? 'in' : 'out', started: false }; }
      else if (r) toast('Fades work on audio regions');
      return;
    }
    if (tool === 'pencil' && !r) {
      if (t?.kind === 'inst') { const bpb = store.beatsPerBar; const nr = this.cmd.createMidiRegion(t.id, Math.floor(this.beatAt(e.clientX) / bpb) * bpb); if (nr) this.cmd.openEditor(nr.id); }
      else toast('The Pencil creates MIDI regions on software instrument tracks');
      return;
    }
    if (tool === 'join') {
      if (r && ui.selectedRegionIds.has(r.id) && ui.selectedRegionIds.size > 1) this.cmd.joinSelected();
      else if (r) { ui.selectedRegionIds.add(r.id); store.emit('structure'); toast('Click another selected region with Join to merge'); }
      return;
    }
    // pointer tool
    this.scroller.setPointerCapture(e.pointerId);
    if (r && e.pointerType === 'touch') {
      // Touch: a finger on a region scrolls like anywhere else. Holding still for a moment "picks up" the
      // region (it can then be moved, trimmed or faded); releasing a picked-up region without moving opens its menu.
      // A quick tap selects it, a double tap opens the editor.
      const now = performance.now();
      if (this.lastTap && this.lastTap.id === r.id && now - this.lastTap.t < 350) { this.lastTap = null; this.cmd.openEditor(r.id); return; }
      this.lastTap = { id: r.id, t: now };
      const x0 = e.clientX, y0 = e.clientY;
      this.drag = { kind: 'pan', x: x0, y: y0, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop };
      this.hold = { r, x: x0, y: y0, armed: false };
      clearTimeout(this.pressTimer);
      this.pressTimer = window.setTimeout(() => {
        const hd = this.hold; if (!hd || hd.r !== r) return;
        hd.armed = true;
        try { navigator.vibrate?.(18); } catch { /* not supported */ }
        if (!ui.selectedRegionIds.has(r.id)) ui.selectedRegionIds = new Set([r.id]);
        this.lifted = r.id;
        store.emit('structure');
        this.regionPress(r, x0, y0, false, false);
      }, HOLD_MS);
      return;
    }
    if (r) this.regionPress(r, e.clientX, e.clientY, e.shiftKey, e.altKey);
    else if (e.pointerType === 'touch') {
      this.drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: this.scroller.scrollLeft, st: this.scroller.scrollTop };
    } else {
      const base = e.shiftKey ? new Set(ui.selectedRegionIds) : new Set<string>();
      if (!e.shiftKey && ui.selectedRegionIds.size) { ui.selectedRegionIds = new Set(); store.emit('structure'); }
      const rect = this.scroller.getBoundingClientRect();
      const bx = e.clientX - rect.left + this.scroller.scrollLeft, by = e.clientY - rect.top + this.scroller.scrollTop;
      this.drag = { kind: 'marquee', bx, by, x: bx, y: by, base };
    }
  }

  /** Touch hold state: the region under the finger, and whether the hold time has passed. */
  private hold: { r: Region; x: number; y: number; armed: boolean } | null = null;
  /** Region shown "picked up" (touch). */
  lifted: string | null = null;

  /** Starts moving / trimming / fading a region from a press at (x, y) (mouse down, or a touch hold). */
  private regionPress(r: Region, x: number, y: number, shift: boolean, alt: boolean) {
    const { store } = this.cmd, ui = store.ui;
    {
      if (shift) { ui.selectedRegionIds.has(r.id) ? ui.selectedRegionIds.delete(r.id) : ui.selectedRegionIds.add(r.id); }
      else if (!ui.selectedRegionIds.has(r.id)) ui.selectedRegionIds = new Set([r.id]);
      store.emit('structure');
      const edge = this.edgeZone(r, x);
      if (edge && !isMidi(r) && this.upperHalf(y)) { this.drag = { kind: 'fade', r, side: edge === 'L' ? 'in' : 'out', started: false }; return; }
      if (edge === 'L' && r.flex?.on && !isMidi(r)) { toast('Turn Flex off to trim the start of this region'); return; }
      if (edge) { this.drag = { kind: edge === 'R' ? 'resizeR' : 'resizeL', r, origStart: r.start, origLen: r.length, origOffset: r.offset, origNotes: r.notes?.map(n => ({ ...n })), origTakes: r.takes?.map(t => ({ ...t })), origComp: r.takes ? compOf(r).map(c => ({ ...c })) : undefined, x0: x, started: false }; return; }
      const idx = new Map(store.visibleTracks().map((t, i) => [t.id, i]));
      const orig = new Map(store.selectedRegions().map(x => [x.id, { start: x.start, track: idx.get(x.trackId)! }]));
      this.drag = { kind: 'move', anchor: r, orig, x0: x, y0: y, copy: alt, started: false };
    }
  }

  private onMove(e: PointerEvent) {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) { this.movePinch(); return; }
    }
    if (this.pressAt && Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) > 8) { clearTimeout(this.pressTimer); this.pressAt = null; }
    // touch: moving before the hold time means scrolling, not picking up the region
    if (this.hold && !this.hold.armed && Math.hypot(e.clientX - this.hold.x, e.clientY - this.hold.y) > 8) { clearTimeout(this.pressTimer); this.hold = null; }
    const { store } = this.cmd;
    const d = this.drag;
    if (!d) { this.updateCursor(e); return; }
    if (d.kind === 'auto') {
      const p = findParam(store, d.t, d.key); if (!p) return;
      if (!d.started) { d.started = true; }
      const b = this.beatAt(e.clientX);
      d.pt.b = Math.max(0, e.shiftKey ? b : store.snapBeat(b));
      d.pt.v = p.denorm(this.normAt(e.clientY, d.row));
      sortPoints(d.t.auto![d.key]);
      this.dirty = true;
      return;
    }
    if (d.kind === 'pan') {
      this.scroller.scrollLeft = d.sl - (e.clientX - d.x);
      this.scroller.scrollTop = d.st - (e.clientY - d.y);
      return;
    }
    if (d.kind === 'move') {
      if (!d.started) {
        if (Math.abs(e.clientX - d.x0) < 4 && Math.abs(e.clientY - d.y0) < 4) return;
        d.started = true; store.checkpoint();
        if (d.copy) {
          const copies = new Map<string, { start: number; track: number }>();
          const sel = new Set<string>();
          for (const [id, o] of d.orig) {
            const src = store.region(id)!; const c = cloneRegion(src, { id: uid('r') });
            store.project.regions.push(c); copies.set(c.id, o); sel.add(c.id);
            if (id === d.anchor.id) d.anchor = c;
          }
          d.orig = copies; store.ui.selectedRegionIds = sel;
        }
      }
      const ao = d.orig.get(d.anchor.id)!;
      const newAnchor = Math.max(0, store.snapBeat(ao.start + (e.clientX - d.x0) / this.ppb));
      let db = newAnchor - ao.start;
      const minStart = Math.min(...[...d.orig.values()].map(o => o.start));
      if (minStart + db < 0) db = -minStart;
      const vis = store.visibleTracks();
      const nT = vis.length;
      let dr = Math.round((e.clientY - d.y0) / store.ui.trackH);
      const rows = [...d.orig.values()].map(o => o.track);
      dr = Math.max(-Math.min(...rows), Math.min(nT - 1 - Math.max(...rows), dr));
      // only onto tracks of the right kind (audio -> audio, MIDI -> instrument)
      const fits = (k: number) => [...d.orig.entries()].every(([id, o]) => { const r = store.region(id); const t = vis[o.track + k]; return !!r && !!t && (isMidi(r) ? t.kind === 'inst' : t.kind === 'audio'); });
      if (!fits(dr)) dr = fits(d.lastDr ?? 0) ? (d.lastDr ?? 0) : 0;
      d.lastDr = dr;
      for (const [id, o] of d.orig) { const r = store.region(id); if (r) { r.start = o.start + db; r.trackId = vis[o.track + dr].id; } }
      this.dirty = true;
    } else if (d.kind === 'fade') {
      if (!d.started) { store.checkpoint(); d.started = true; }
      const r = d.r, b = this.contentX(e.clientX) / this.ppb;
      if (d.side === 'in') r.fadeIn = Math.max(0, Math.min(r.length - (r.fadeOut ?? 0), Math.round((b - r.start) * 100) / 100));
      else r.fadeOut = Math.max(0, Math.min(r.length - (r.fadeIn ?? 0), Math.round((r.start + r.length - b) * 100) / 100));
      this.dirty = true;
    } else if (d.kind === 'resizeR' || d.kind === 'resizeL') {
      if (!d.started) { if (Math.abs(e.clientX - d.x0) < 3) return; d.started = true; store.checkpoint(); }
      const r = d.r;
      const buf = store.buffers.get(r.bufferId);
      const maxLen = isFolder(r) ? folderMaxEnd(store, { ...r, start: d.origStart }) - d.origStart : buf && !isMidi(r) ? store.beatAfter(d.origStart, buf.duration - d.origOffset) - d.origStart : Infinity;
      const minLen = Math.max(0.05, store.snapUnit() || 0.05);
      if (d.kind === 'resizeR') {
        const end = store.snapBeat(d.origStart + d.origLen + (e.clientX - d.x0) / this.ppb);
        r.length = Math.max(minLen, Math.min(maxLen, end - d.origStart));
      } else {
        const end = d.origStart + d.origLen;
        let s = store.snapBeat(d.origStart + (e.clientX - d.x0) / this.ppb);
        s = isMidi(r) || isFolder(r) ? Math.max(s, 0) : Math.max(s, store.beatAfter(d.origStart, -d.origOffset), 0);
        s = Math.min(s, end - minLen);
        r.start = s; r.length = end - s;
        if (isMidi(r) && d.origNotes) r.notes = d.origNotes.map(n => ({ ...n, s: n.s + d.origStart - s }));
        else if (isFolder(r) && d.origTakes) trimFolderStart(store, r, d.origStart, d.origTakes, d.origComp!, s);
        else r.offset = Math.max(0, d.origOffset + store.secs(d.origStart, s));
      }
      this.dirty = true;
    } else if (d.kind === 'marquee') {
      const rect = this.scroller.getBoundingClientRect();
      d.x = e.clientX - rect.left + this.scroller.scrollLeft; d.y = e.clientY - rect.top + this.scroller.scrollTop;
      const H = store.ui.trackH, ppb = this.ppb;
      const x0 = Math.min(d.bx, d.x), x1 = Math.max(d.bx, d.x), y0 = Math.min(d.by, d.y), y1 = Math.max(d.by, d.y);
      const sel = new Set(d.base);
      store.visibleTracks().forEach((t, i) => {
        if ((i + 1) * H < y0 || i * H > y1) return;
        for (const r of store.project.regions) if (r.trackId === t.id && r.start * ppb < x1 && (r.start + r.length) * ppb > x0) sel.add(r.id);
      });
      store.ui.selectedRegionIds = sel;
      this.dirty = true;
    }
  }

  private onUp(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    clearTimeout(this.pressTimer); this.pressAt = null;
    if (this.pinch) { if (this.touches.size < 2) this.pinch = null; return; }
    const d = this.drag; this.drag = null;
    const hd = this.hold; this.hold = null;
    if (this.lifted) { this.lifted = null; this.dirty = true; }
    if (hd) {
      const { store } = this.cmd;
      if (!hd.armed && d?.kind === 'pan') {
        // quick tap: select the region
        if (store.ui.selectedRegionIds.size !== 1 || !store.ui.selectedRegionIds.has(hd.r.id)) { store.ui.selectedRegionIds = new Set([hd.r.id]); store.emit('structure'); }
        return;
      }
      if (hd.armed && !(d && 'started' in d && d.started)) { this.regionMenu(hd.r, hd.x, hd.y); return; }
    }
    if (!d) return;
    const { store } = this.cmd;
    if ((d.kind === 'resizeR' || d.kind === 'resizeL') && d.started) { const r = d.r; r.fadeIn = Math.min(r.fadeIn ?? 0, r.length); r.fadeOut = Math.min(r.fadeOut ?? 0, r.length - (r.fadeIn ?? 0)); }
    if ((d.kind === 'move' || d.kind === 'resizeR' || d.kind === 'resizeL' || d.kind === 'fade') && d.started) { store.emit('structure'); this.cmd.engine.resync(); }
    if (d.kind === 'marquee') store.emit('structure');
    if (d.kind === 'auto') { store.emit('structure'); this.cmd.autoEdited(); }
    this.dirty = true;
  }

  // ---------- touch: pinch zoom ----------
  private startPinch() {
    const [a, b] = [...this.touches.values()];
    // a pinch cancels whatever the first finger started
    const d = this.drag; this.drag = null;
    if (d && 'started' in d && d.started) { this.cmd.store.undo(); }
    clearTimeout(this.pressTimer); this.pressAt = null; this.hold = null; this.lifted = null;
    const rect = this.scroller.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - rect.left;
    this.pinch = { d0: Math.max(10, Math.abs(a.x - b.x)), ppb0: this.ppb, beat: (mx + this.scroller.scrollLeft) / this.ppb, x: mx };
  }
  private movePinch() {
    const p = this.pinch!; const [a, b] = [...this.touches.values()]; if (!b) return;
    const ui = this.cmd.store.ui;
    ui.pxPerBeat = Math.max(4, Math.min(320, p.ppb0 * Math.max(10, Math.abs(a.x - b.x)) / p.d0));
    this.syncSize();
    const mx = (a.x + b.x) / 2 - this.scroller.getBoundingClientRect().left;
    this.scroller.scrollLeft = Math.max(0, p.beat * ui.pxPerBeat - mx);
    this.cmd.store.emit('view');
  }

  /** Region context menu: right-click, or long-press on touch screens. */
  regionMenu(r: Region, x: number, y: number) {
    const { store } = this.cmd, cmd = this.cmd;
    if (!store.ui.selectedRegionIds.has(r.id)) { store.ui.selectedRegionIds = new Set([r.id]); store.emit('structure'); }
    const sel = store.selectedRegions();
    const anchor = h('div', { style: { position: 'fixed', left: `${x}px`, top: `${y}px`, width: '1px', height: '1px' } });
    document.body.appendChild(anchor);
    openMenu(anchor, [
      [r.session ? 'Open Session Player' : r.pattern ? 'Open in Step Sequencer' : isMidi(r) ? 'Open in Piano Roll' : 'Open in Audio Editor', isMidi(r) ? 'P' : 'E', () => cmd.openEditor(r.id)],
      ...(r.session ? [['Convert to MIDI Region', '', () => cmd.sessionToMidi(r)] as MenuItem] : []),
      ...(r.pattern ? [['Convert to MIDI Region', '', () => cmd.patternToMidi(r)] as MenuItem] : []),
      ...(isMidi(r) && !r.session && !r.pattern ? [['Convert to Pattern Region', '', () => cmd.midiToPattern(r)] as MenuItem] : []),
      '-',
      ['Cut', K('⌘X'), cmd.cutRegions], ['Copy', K('⌘C'), cmd.copyRegions], ['Paste at Playhead', K('⌘V'), cmd.pasteRegions], '-',
      ['Split at Playhead', '⌘T', cmd.splitAtPlayhead], ['Repeat Once', '⌘R', cmd.repeat],
      [r.muted ? 'Unmute' : 'Mute', '⌃M', cmd.toggleRegionMute],
      ...(isMidi(r) && !r.session && !r.pattern ? [{ label: 'Transpose', sub: [['+1', '', () => cmd.transposeRegions(1)], ['−1', '', () => cmd.transposeRegions(-1)], ['+12 (octave up)', '', () => cmd.transposeRegions(12)], ['−12 (octave down)', '', () => cmd.transposeRegions(-12)]] } as MenuItem, ['Quantize', 'Q', cmd.quantizeRegions] as MenuItem] : []),
      ...(!isMidi(r) && !isFolder(r) ? [['Reverse', '', () => cmd.processAudioRegions('reverse')] as MenuItem, ['Normalize', '', () => cmd.processAudioRegions('normalize')] as MenuItem] : []),
      ...(sel.length > 1 && sel.every(x => !isMidi(x)) ? [['Pack Take Folder', '', cmd.packTakeFolder] as MenuItem] : []),
      ...(isFolder(r) ? [['Flatten Take Folder', '', () => cmd.flattenTakeFolder(r)] as MenuItem] : []),
      '-',
      [sel.length > 1 ? `Delete ${sel.length} Regions` : 'Delete', '⌫', cmd.deleteSelected],
    ]);
    setTimeout(() => anchor.remove(), 0);
  }

  private updateCursor(e: PointerEvent) {
    const tool = this.activeTool(e);
    let c = 'default';
    if (this.cmd.store.ui.showAuto && tool === 'pointer') {
      const row = this.rowAt(e.clientY), t = this.cmd.store.visibleTracks()[row];
      const hit = t ? this.autoHit(t, row, e.clientX, e.clientY) : null;
      if (hit !== this.hoverPt) { this.hoverPt = hit; this.dirty = true; }
      c = hit ? 'move' : t ? 'crosshair' : 'default';
      if (c !== this.hoverCursor) { this.scroller.style.cursor = c; this.hoverCursor = c; }
      return;
    }
    if (tool === 'scissors' || tool === 'pencil') c = 'crosshair';
    else if (tool === 'eraser' || tool === 'mute' || tool === 'join') c = 'pointer';
    else if (tool === 'fade') c = 'col-resize';
    else { const r = this.hit(e.clientX, e.clientY); if (r && this.edgeZone(r, e.clientX)) c = !isMidi(r) && this.upperHalf(e.clientY) ? 'col-resize' : 'ew-resize'; }
    if (c !== this.hoverCursor) { this.scroller.style.cursor = c; this.hoverCursor = c; }
  }

  private onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const b = this.beatAt(e.clientX);
    const rect = this.scroller.getBoundingClientRect();
    this.cmd.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    this.syncSize();
    this.scroller.scrollLeft = Math.max(0, b * this.ppb - (e.clientX - rect.left));
  }

  private onDrop(e: DragEvent) {
    e.preventDefault(); this.scroller.classList.remove('drop');
    const files = [...(e.dataTransfer?.files ?? [])].filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|aif|aiff|flac|ogg)$/i.test(f.name));
    if (!files.length) { toast('Drop audio files here'); return; }
    const t = this.cmd.store.visibleTracks()[this.rowAt(e.clientY)];
    this.cmd.importFiles(files, this.beatAt(e.clientX), t?.id ?? null);
  }

  // ---------- automation ----------
  private laneBox(row: number) { const H = this.cmd.store.ui.trackH; return { top: row * H + 6, h: H - 12 }; }
  private normAt(clientY: number, row: number) {
    const y = clientY - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    const { top, h: hh } = this.laneBox(row);
    return Math.max(0, Math.min(1, 1 - (y - top) / hh));
  }
  private autoHit(t: Track, row: number, clientX: number, clientY: number): AutoPoint | null {
    const key = t.autoShow ?? 'volume', pts = t.auto?.[key]; if (!pts?.length) return null;
    const p = findParam(this.cmd.store, t, key); if (!p) return null;
    const rect = this.scroller.getBoundingClientRect();
    const x = clientX - rect.left + this.scroller.scrollLeft, y = clientY - rect.top + this.scroller.scrollTop;
    const { top, h: hh } = this.laneBox(row);
    let best: AutoPoint | null = null, bd = 9;
    for (const pt of pts) { const d = Math.hypot(pt.b * this.ppb - x, top + (1 - p.norm(pt.v)) * hh - y); if (d < bd) { bd = d; best = pt; } }
    return best;
  }
  private autoDown(e: PointerEvent, t: Track, row: number) {
    const { store } = this.cmd;
    const key = t.autoShow ?? 'volume';
    const p = findParam(store, t, key); if (!p) return;
    this.scroller.setPointerCapture(e.pointerId);
    store.checkpoint();
    let pt = this.autoHit(t, row, e.clientX, e.clientY);
    if (!pt) {
      t.auto ??= {};
      const pts = (t.auto[key] ??= []);
      const b = Math.max(0, e.shiftKey ? this.beatAt(e.clientX) : store.snapBeat(this.beatAt(e.clientX)));
      if (!pts.length) pts.push({ b: 0, v: p.get() });
      pt = { b, v: p.denorm(this.normAt(e.clientY, row)) };
      pts.push(pt); sortPoints(pts);
      if (!t.autoMode || t.autoMode === 'off') t.autoMode = 'read';
      t.autoShow = key;
      store.emit('structure');
    }
    this.drag = { kind: 'auto', t, key, pt, row, started: false };
    this.dirty = true;
  }

  private drawAutomation(g: CanvasRenderingContext2D, w: number, H: number) {
    const { store } = this.cmd;
    const sx = this.scroller.scrollLeft, sy = this.scroller.scrollTop, ppb = this.ppb;
    store.visibleTracks().forEach((t, i) => {
      const { top, h: hh } = this.laneBox(i);
      const y0 = top - sy; if (y0 > H || y0 + hh < 0) return;
      const key = t.autoShow ?? 'volume';
      const p = findParam(store, t, key); if (!p) return;
      const pts = t.auto?.[key] ?? [];
      const on = (t.autoMode === 'read' || t.autoMode === 'touch');
      const col = !pts.length ? '#9a9da5' : on ? (t.autoMode === 'touch' ? '#ffd166' : '#5fe39a') : '#8b8e96';
      const yOf = (v: number) => y0 + (1 - p.norm(v)) * hh;
      g.fillStyle = '#00000059'; g.fillRect(0, y0 - 4, w, hh + 8);
      g.strokeStyle = col; g.lineWidth = 1.6;
      if (!pts.length) {
        g.setLineDash([4, 4]); g.beginPath(); const y = yOf(p.get()); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#9a9da5'; g.font = '11px Inter, sans-serif'; g.textBaseline = 'bottom';
        g.fillText(`${p.label}: ${p.fmt(p.get())} · click to add a point`, 8, y - 3);
        return;
      }
      const b0 = sx / ppb, b1 = (sx + w) / ppb;
      g.beginPath();
      g.moveTo(0, yOf(valueAt(pts, b0)!));
      for (const pt of pts) if (pt.b >= b0 && pt.b <= b1) g.lineTo(pt.b * ppb - sx, yOf(pt.v));
      g.lineTo(w, yOf(valueAt(pts, b1)!));
      g.stroke();
      g.lineTo(w, y0 + hh); g.lineTo(0, y0 + hh); g.closePath();
      g.fillStyle = col + '22'; g.fill();
      for (const pt of pts) {
        if (pt.b < b0 - 1 || pt.b > b1 + 1) continue;
        const x = pt.b * ppb - sx, y = yOf(pt.v);
        const hot = pt === this.hoverPt || (this.drag?.kind === 'auto' && this.drag.pt === pt);
        g.fillStyle = hot ? '#ffffff' : col; g.beginPath(); g.arc(x, y, hot ? 4.5 : 3.5, 0, Math.PI * 2); g.fill();
        if (hot) { g.font = '600 11px Inter, sans-serif'; g.textBaseline = 'bottom'; const txt = p.fmt(pt.v); const tw = g.measureText(txt).width; g.fillStyle = '#111214cc'; g.fillRect(x + 6, y - 18, tw + 8, 16); g.fillStyle = '#fff'; g.fillText(txt, x + 10, y - 4); }
      }
    });
  }

  // ---------- pointer: ruler ----------
  private markerAt(beat: number) {
    const ms = this.cmd.store.project.markers, bpb = this.cmd.store.beatsPerBar;
    for (let i = ms.length - 1; i >= 0; i--) { const end = ms[i + 1]?.b ?? ms[i].b + 8 * bpb; if (beat >= ms[i].b && beat < end) return ms[i]; }
    return null;
  }
  private tempoAt(clientX: number) {
    const { store } = this.cmd;
    const x = clientX - this.ruler.getBoundingClientRect().left + this.scroller.scrollLeft;
    const evs = [{ id: 'base', b: 0, bpm: store.project.tempo }, ...store.project.tempoEvents];
    for (let i = evs.length - 1; i >= 0; i--) { const ex = evs[i].b * this.ppb; if (x >= ex - 2 && x < ex + 58) return evs[i]; }
    return null;
  }
  editMarker(id: string) {
    const { store } = this.cmd;
    const m = store.project.markers.find(x => x.id === id); if (!m) return;
    const r = this.ruler.getBoundingClientRect();
    inlineEdit(r.left + m.b * this.ppb - this.scroller.scrollLeft, r.top + MARK_Y - 4, m.name, v => this.cmd.renameMarker(id, v));
  }
  editTempo(id: string) {
    const { store } = this.cmd;
    const ev = id === 'base' ? { b: 0, bpm: store.project.tempo } : store.project.tempoEvents.find(x => x.id === id); if (!ev) return;
    const r = this.ruler.getBoundingClientRect();
    inlineEdit(r.left + ev.b * this.ppb - this.scroller.scrollLeft, r.top + TEMPO_Y - 4, String(ev.bpm), v => this.cmd.setTempoEvent(id, parseFloat(v)), 70, true);
  }

  private onRulerDown(e: PointerEvent) {
    const { store } = this.cmd;
    if (e.button !== 0) return;
    this.ruler.setPointerCapture(e.pointerId);
    const y = e.clientY - this.ruler.getBoundingClientRect().top;
    const b = this.beatAt(e.clientX);
    if (y < CYCLE_H + 2 && store.ui.punch.on && y >= 8) { this.drag = { kind: 'punch', b0: store.snapBeat(b) }; return; }
    if (y < CYCLE_H + 2) { this.drag = { kind: 'cycle', b0: store.snapBeat(b), moved: false, wasOn: store.ui.cycle.on }; return; }
    if (y >= MARK_Y && y < TEMPO_Y) {
      const m = this.markerAt(b);
      if (m) this.drag = { kind: 'marker', id: m.id, orig: m.b, x0: e.clientX, moved: false };
      return;
    }
    if (y >= MOVIE_Y) {
      const m = store.project.movie;
      if (m) this.drag = { kind: 'movie', orig: m.start, b0: store.beatAtSec(m.start), x0: e.clientX, moved: false };
      return;
    }
    if (y >= TEMPO_Y) {
      const ev = this.tempoAt(e.clientX);
      if (ev) this.drag = { kind: 'tempo', id: ev.id, orig: ev.b, x0: e.clientX, moved: false };
      return;
    }
    this.drag = { kind: 'scrub' }; this.cmd.locate(store.snapBeat(b));
  }
  private onRulerMove(e: PointerEvent) {
    const d = this.drag; if (!d) return;
    const { store } = this.cmd;
    const b = store.snapBeat(this.beatAt(e.clientX));
    if (d.kind === 'scrub') { store.ui.playhead = b; store.emit('transport'); }
    else if (d.kind === 'punch') { if (Math.abs(b - d.b0) >= (store.snapUnit() || 0.25)) { store.ui.punch.start = Math.min(d.b0, b); store.ui.punch.end = Math.max(d.b0, b); store.emit('transport'); } }
    else if (d.kind === 'cycle' && Math.abs(b - d.b0) >= (store.snapUnit() || 0.25)) {
      d.moved = true;
      store.ui.cycle = { on: true, start: Math.min(d.b0, b), end: Math.max(d.b0, b) };
      store.emit('transport');
    } else if (d.kind === 'movie') {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
      const m = store.project.movie; if (!m) return;
      if (!d.moved) store.checkpoint();
      d.moved = true;
      const nb = Math.max(0, store.snapBeat(d.b0 + (e.clientX - d.x0) / this.ppb));
      m.start = Math.round(store.secAt(nb) * 1000) / 1000;
      this.dirty = true;
    } else if (d.kind === 'marker' || d.kind === 'tempo') {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
      if (d.kind === 'tempo' && d.id === 'base') return;
      if (!d.moved && d.kind === 'marker') store.checkpoint();
      d.moved = true;
      const bpb = store.beatsPerBar;
      if (d.kind === 'marker') { const m = store.project.markers.find(x => x.id === d.id); if (m) m.b = Math.max(0, Math.round(this.beatAt(e.clientX) / bpb) * bpb); }
      else { const ev = store.project.tempoEvents.find(x => x.id === d.id); if (ev) ev.b = Math.max(1, Math.round(this.beatAt(e.clientX))); }
      this.dirty = true;
    }
  }
  private onRulerUp(_e: PointerEvent) {
    const d = this.drag; this.drag = null;
    if (!d) return;
    const { store } = this.cmd;
    if (d.kind === 'scrub' && this.cmd.engine.playing) this.cmd.locate(store.ui.playhead);
    if (d.kind === 'cycle') { if (!d.moved) this.cmd.toggleCycle(); else this.cmd.engine.resync(); }
    if (d.kind === 'movie') { if (d.moved) store.emit('structure'); else { store.ui.showMovie = true; store.emit('view'); } }
    if (d.kind === 'marker') {
      const m = store.project.markers.find(x => x.id === d.id);
      if (!d.moved && m) this.cmd.locate(m.b);
      else { store.project.markers.sort((a, b) => a.b - b.b); store.emit('structure'); }
    }
    if (d.kind === 'tempo') {
      if (!d.moved) { this.editTempo(d.id); return; }
      const ev = store.project.tempoEvents.find(x => x.id === d.id);
      if (ev) { const nb = ev.b; ev.b = d.orig; this.cmd.moveTempoEvent(d.id, nb); }
    }
    this.dirty = true;
  }
  private onRulerDbl(e: MouseEvent) {
    const { store } = this.cmd;
    const y = e.clientY - this.ruler.getBoundingClientRect().top;
    const b = this.beatAt(e.clientX);
    if (y >= MARK_Y && y < TEMPO_Y) {
      const m = this.markerAt(b);
      if (m && Math.abs(m.b - b) < 8 * store.beatsPerBar) { this.editMarker(m.id); return; }
    }
    if (y >= MARK_Y && y < TEMPO_Y) { const m = this.cmd.addMarker(b); if (m) this.editMarker(m.id); }
    else if (y >= TEMPO_Y && y < TEMPO_Y + LANE_H && !this.tempoAt(e.clientX)) { const ev = this.cmd.addTempoEvent(store.snapBeat(b)); if (ev) this.editTempo(ev.id); }
  }
  private onRulerMenu(e: MouseEvent) {
    const { store } = this.cmd;
    const y = e.clientY - this.ruler.getBoundingClientRect().top;
    const b = this.beatAt(e.clientX);
    const anchor = h('div', { style: { position: 'fixed', left: `${e.clientX}px`, top: `${e.clientY}px` } }); document.body.appendChild(anchor); setTimeout(() => anchor.remove(), 0);
    if (y >= MARK_Y && y < TEMPO_Y) {
      e.preventDefault();
      const m = this.markerAt(b);
      openMenu(anchor, m ? [['Rename Marker', '', () => this.editMarker(m.id)], ['Go to Marker', '', () => this.cmd.locate(m.b)], ['Delete Marker', '', () => this.cmd.deleteMarker(m.id)]]
        : [['Create Marker Here', '', () => { const nm = this.cmd.addMarker(b); if (nm) this.editMarker(nm.id); }]]);
    } else if (y >= MOVIE_Y) {
      e.preventDefault();
      openMenu(anchor, this.movieMenu());
    } else if (y >= TEMPO_Y) {
      e.preventDefault();
      const ev = this.tempoAt(e.clientX);
      openMenu(anchor, ev ? [['Edit Tempo', '', () => this.editTempo(ev.id)], ...(ev.id !== 'base' ? [['Delete Tempo Change', '', () => this.cmd.deleteTempoEvent(ev.id)] as MenuItem] : [])]
        : [['Add Tempo Change Here', '', () => { const ne = this.cmd.addTempoEvent(store.snapBeat(b)); if (ne) this.editTempo(ne.id); }]]);
    }
  }

  movieMenu(): MenuItem[] {
    const c = this.cmd, m = c.store.project.movie;
    if (!m) return [['Open Movie…', K('⌥⌘O'), c.openMovie]];
    return [
      [c.store.ui.showMovie ? 'Hide Movie Window' : 'Show Movie Window', '', c.toggleMovieWindow],
      ['Import Audio from Movie', '', c.importMovieAudio],
      ['Movie Start at Playhead', '', c.movieStartAtPlayhead], ['Movie Start at 0', '', () => c.setMovieStart(0)], '-',
      ['Open Another Movie…', K('⌥⌘O'), c.openMovie], ['Remove Movie', '', c.removeMovie],
    ];
  }

  // ---------- drawing ----------
  private syncSize() {
    const { store } = this.cmd;
    const totalBeats = Math.max(store.songEndBeats() + 32 * store.beatsPerBar, 64 * store.beatsPerBar);
    const H = store.ui.trackH;
    this.spacer.style.width = `${totalBeats * this.ppb}px`;
    this.spacer.style.height = `${(store.visibleTracks().length + 3) * H}px`;
  }

  markDirty() { this.dirty = true; }

  frame(playheadBeat: number, playing: boolean) {
    const seq = this.cmd.store.ui.locateSeq ?? 0, jumped = seq !== this.seenLocate;
    this.seenLocate = seq;
    if (jumped || (playing && generalPrefs().followPlayhead)) {
      const x = playheadBeat * this.ppb, w = this.scroller.clientWidth;
      if (x > this.scroller.scrollLeft + w - 20 || x < this.scroller.scrollLeft) { this.scroller.scrollLeft = Math.max(0, x - 40); this.dirty = true; }
    }
    const px = playheadBeat * this.ppb - this.scroller.scrollLeft;
    this.playLine.set(px >= 0 && px <= this.scroller.clientWidth ? px : null, this.cmd.store.ui.recording);
    if (!this.dirty && !this.drag) return;
    this.dirty = false;
    this.syncSize();
    this.drawRuler(playheadBeat);
    this.drawLanes(playheadBeat);
  }

  private prep(c: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h: hh };
  }

  private barStep() {
    const barPx = this.ppb * this.cmd.store.beatsPerBar;
    let step = 1; while (barPx * step < 36) step *= 2;
    return step;
  }

  private drawRuler(ph: number) {
    const { store } = this.cmd;
    const movie = this.cmd.movie.info;
    const want = `${RULER_H + (movie ? MOVIE_H : 0)}px`;
    if (this.ruler.style.height !== want) { this.ruler.style.height = want; this.hdrTop.style.height = want; this.movieLabel.hidden = !movie; }
    const { g, w, h: H } = this.prep(this.ruler);
    const sx = this.scroller.scrollLeft, ppb = this.ppb, bpb = store.beatsPerBar;
    g.fillStyle = '#25262a'; g.fillRect(0, 0, w, H);
    g.fillStyle = '#1e1f22'; g.fillRect(0, 0, w, CYCLE_H);
    const c = store.ui.cycle, pu = store.ui.punch;
    const cx0 = c.start * ppb - sx, cx1 = c.end * ppb - sx;
    g.fillStyle = c.on ? '#f5c542' : '#4a4d55';
    g.fillRect(cx0, 2, Math.max(2, cx1 - cx0), pu.on ? 5 : CYCLE_H - 4);
    if (pu.on) { g.fillStyle = '#ff4d4f'; g.fillRect(pu.start * ppb - sx, 9, Math.max(2, (pu.end - pu.start) * ppb), 5); }
    const b0 = Math.floor(sx / ppb), b1 = Math.ceil((sx + w) / ppb);
    const step = this.barStep();
    g.font = '11px "JetBrains Mono", ui-monospace, monospace'; g.textBaseline = 'top';
    for (let b = b0 - (b0 % bpb); b <= b1; b++) {
      const x = Math.round(b * ppb - sx) + 0.5;
      const isBar = b % bpb === 0, bar = b / bpb;
      if (isBar && bar % step === 0) {
        g.strokeStyle = '#6a6d75'; g.beginPath(); g.moveTo(x, BAR_Y); g.lineTo(x, MARK_Y); g.stroke();
        g.fillStyle = '#c4c6cc'; g.fillText(String(bar + 1), x + 4, BAR_Y + 3);
      } else if (ppb >= 10) {
        g.strokeStyle = '#45484f'; g.beginPath(); g.moveTo(x, MARK_Y - (isBar ? 10 : 5)); g.lineTo(x, MARK_Y); g.stroke();
      }
    }
    // marker lane
    g.fillStyle = '#1d1e21'; g.fillRect(0, MARK_Y, w, LANE_H);
    const ms = store.project.markers;
    g.font = '600 10px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    ms.forEach((m, i) => {
      const end = ms[i + 1]?.b ?? m.b + 8 * bpb;
      const x0 = m.b * ppb - sx, x1 = end * ppb - sx; if (x1 < 0 || x0 > w) return;
      const col = MARKER_COLORS[i % MARKER_COLORS.length];
      g.fillStyle = col + '33'; g.fillRect(x0, MARK_Y + 1, x1 - x0 - 1, LANE_H - 2);
      g.fillStyle = col; g.fillRect(x0, MARK_Y + 1, 2, LANE_H - 2);
      g.save(); g.beginPath(); g.rect(x0, MARK_Y, Math.max(0, x1 - x0 - 2), LANE_H); g.clip();
      g.fillStyle = '#e6e7ea'; g.fillText(m.name, Math.max(x0, 0) + 6, MARK_Y + LANE_H / 2 + 0.5); g.restore();
    });
    // tempo lane
    g.fillStyle = '#202125'; g.fillRect(0, TEMPO_Y, w, LANE_H);
    const evs = [{ b: 0, bpm: store.project.tempo }, ...[...store.project.tempoEvents].sort((a, b) => a.b - b.b)];
    g.font = '10px "JetBrains Mono", monospace';
    evs.forEach((ev, i) => {
      const x = ev.b * ppb - sx, next = evs[i + 1] ? evs[i + 1].b * ppb - sx : w;
      if (next < 0 || x > w) return;
      g.fillStyle = i ? '#ff9f43' : '#9a9da5'; g.fillRect(x, TEMPO_Y + 2, 1.5, LANE_H - 4);
      g.fillStyle = i ? '#ffc285' : '#c4c6cc'; g.fillText(`♩${ev.bpm}`, Math.max(x, 0) + 4, TEMPO_Y + LANE_H / 2 + 0.5);
    });
    if (movie) this.drawMovieLane(g, w, sx);
    g.fillStyle = '#0f1012'; g.fillRect(0, MARK_Y, w, 1); g.fillRect(0, TEMPO_Y, w, 1); g.fillRect(0, H - 1, w, 1);
    if (movie) g.fillRect(0, MOVIE_Y, w, 1);
  }

  /** Movie lane: thumbnails laid out on the timeline from the movie's start to its end. */
  private drawMovieLane(g: CanvasRenderingContext2D, w: number, sx: number) {
    const { store } = this.cmd, m = this.cmd.movie.info!, ppb = this.ppb;
    g.fillStyle = '#18191c'; g.fillRect(0, MOVIE_Y, w, MOVIE_H);
    const x0 = store.beatAtSec(m.start) * ppb - sx, x1 = store.beatAtSec(m.start + m.duration) * ppb - sx;
    if (x1 < 0 || x0 > w) return;
    const top = MOVIE_Y + 2, th = MOVIE_H - 4, tw = Math.max(16, Math.round(th * (m.w && m.h ? m.w / m.h : 16 / 9)));
    g.save(); g.beginPath(); g.rect(Math.max(0, x0), top, Math.min(w, x1) - Math.max(0, x0), th); g.clip();
    g.fillStyle = '#2b2d33'; g.fillRect(x0, top, x1 - x0, th);
    const startX = x0 + Math.max(0, Math.floor((0 - x0) / tw)) * tw;
    for (let x = startX; x < Math.min(w, x1); x += tw) {
      const t = store.secAt((x + tw / 2 + sx) / ppb) - m.start;
      const img = this.cmd.movie.thumbAt(Math.max(0, t));
      if (img) g.drawImage(img, x, top, tw, th);
      g.fillStyle = '#0f1012'; g.fillRect(x, top, 1, th);
    }
    g.restore();
    g.strokeStyle = '#7d8fb3'; g.lineWidth = 1; g.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.round(x1 - x0) - 1, th - 1);
    g.font = '600 10px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    const label = `🎬 ${m.name}`, lx = Math.max(x0, 0) + 4, lw = g.measureText(label).width + 8;
    g.fillStyle = '#000000a0'; g.fillRect(lx - 2, top + 2, lw, 14); g.fillStyle = '#e6e7ea'; g.fillText(label, lx + 2, top + 9.5);
  }

  private drawLanes(ph: number) {
    const { store } = this.cmd;
    const { g, w, h: H } = this.prep(this.lanes);
    const sx = this.scroller.scrollLeft, sy = this.scroller.scrollTop, ppb = this.ppb, bpb = store.beatsPerBar;
    const TH = store.ui.trackH;
    const tracks = store.visibleTracks();
    g.fillStyle = '#1a1b1e'; g.fillRect(0, 0, w, H);
    tracks.forEach((t, i) => {
      const y = i * TH - sy;
      if (y > H || y + TH < 0) return;
      if (t.id === store.ui.selectedTrackId) { g.fillStyle = '#ffffff0a'; g.fillRect(0, y, w, TH); }
      g.fillStyle = '#111214'; g.fillRect(0, y + TH - 1, w, 1);
    });
    // grid
    const b0 = Math.floor(sx / ppb), b1 = Math.ceil((sx + w) / ppb), step = this.barStep();
    for (let b = b0; b <= b1; b++) {
      const isBar = b % bpb === 0;
      if (!isBar && ppb < 12) continue;
      if (isBar && (b / bpb) % step !== 0 && ppb * bpb < 36) continue;
      g.fillStyle = isBar ? '#2e3036' : '#222328';
      g.fillRect(Math.round(b * ppb - sx), 0, 1, H);
    }
    const c = store.ui.cycle;
    if (c.on) { g.fillStyle = '#f5c5420d'; g.fillRect(c.start * ppb - sx, 0, (c.end - c.start) * ppb, H); }
    // Track Stack lanes: a summary of the regions inside the stack
    tracks.forEach((f, i) => {
      if (f.kind !== 'folder') return;
      const y = i * TH - sy; if (y > H || y + TH < 0) return;
      const kids = store.children(f.id);
      g.fillStyle = '#ffffff08'; g.fillRect(0, y + 2, w, TH - 4);
      const lh = Math.max(3, Math.min(10, (TH - 10) / Math.max(1, kids.length)));
      kids.forEach((k, j) => {
        for (const r of store.project.regions) {
          if (r.trackId !== k.id) continue;
          const x = r.start * ppb - sx, rw = r.length * ppb; if (x > w || x + rw < 0) continue;
          g.fillStyle = k.color + (r.muted ? '55' : 'cc'); g.fillRect(x, y + 5 + j * lh, Math.max(1, rw - 1), lh - 1);
        }
      });
    });
    // regions
    const idx = new Map(tracks.map((t, i) => [t.id, i]));
    const anySolo = tracks.some(t => t.solo);
    for (const r of store.project.regions) {
      const i = idx.get(r.trackId); if (i == null) continue;
      const t = tracks[i];
      const x = r.start * ppb - sx, rw = r.length * ppb, y = i * TH - sy + 2, rh = TH - 4;
      if (x > w || x + rw < 0 || y > H || y + rh < 0) continue;
      const sel = store.ui.selectedRegionIds.has(r.id);
      const dim = r.muted || t.mute || (anySolo && !t.solo);
      const col = r.muted ? '#7a7d85' : t.color;
      g.save();
      g.globalAlpha = (dim ? 0.45 : 1) * (store.ui.showAuto ? 0.55 : 1);
      g.beginPath(); g.roundRect(x, y, Math.max(2, rw), rh, 4); g.clip();
      g.fillStyle = col + (sel ? '70' : '42'); g.fillRect(x, y, rw, rh);
      const headH = rh >= 34 ? 15 : 0;
      if (headH) {
        g.fillStyle = col; g.fillRect(x, y, rw, headH);
        g.fillStyle = '#111214'; g.font = '600 11px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
        g.fillText((r.muted ? '● ' : '') + (r.session ? '✦ ' : '') + (r.pattern ? '▦ ' : '') + (r.flex?.on ? '⇿ ' : '') + (isFolder(r) ? `⧉ ${r.takes!.length} takes · ` : '') + r.name + (r.gain ? `  ${r.gain > 0 ? '+' : ''}${r.gain.toFixed(1)} dB` : ''), Math.max(x, 0) + 5, y + headH / 2 + 0.5);
      }
      if (isMidi(r)) this.drawNotes(g, r, x, y + headH, rw, rh - headH, col);
      else {
        if (isFolder(r)) {
          for (const vr of expandRegion(store, r)) this.drawWave(g, vr, vr.start * ppb - sx, y + headH, vr.length * ppb, rh - headH, col, sx, w);
          g.fillStyle = '#ffffffaa';
          for (const sg of compOf(r)) if (sg.s > 0.001) g.fillRect(x + sg.s * ppb, y + headH, 1, rh - headH);
        } else this.drawWave(g, r, x, y + headH, rw, rh - headH, col, sx, w);
        const fi = (r.fadeIn ?? 0) * ppb, fo = (r.fadeOut ?? 0) * ppb;
        g.fillStyle = '#00000080'; g.strokeStyle = '#ffffffcc'; g.lineWidth = 1.2;
        if (fi > 1) { g.beginPath(); g.moveTo(x, y + rh); g.lineTo(x + fi, y + headH); g.lineTo(x, y + headH); g.closePath(); g.fill(); g.beginPath(); g.moveTo(x, y + rh); g.lineTo(x + fi, y + headH); g.stroke(); }
        if (fo > 1) { const xe = x + rw; g.beginPath(); g.moveTo(xe, y + rh); g.lineTo(xe - fo, y + headH); g.lineTo(xe, y + headH); g.closePath(); g.fill(); g.beginPath(); g.moveTo(xe, y + rh); g.lineTo(xe - fo, y + headH); g.stroke(); }
      }
      g.restore();
      const lifted = this.lifted === r.id || (!!this.lifted && sel);
      g.strokeStyle = lifted ? '#ffd166' : sel ? '#ffffff' : col; g.lineWidth = lifted ? 3 : sel ? 1.5 : 1;
      g.beginPath(); g.roundRect(x + 0.5, y + 0.5, Math.max(1, rw - 1), rh - 1, 4); g.stroke();
    }
    if (store.ui.showAuto) this.drawAutomation(g, w, H);
    // marquee
    const d = this.drag;
    if (d && d.kind === 'marquee') {
      g.fillStyle = '#4c9aff22'; g.strokeStyle = '#4c9aff'; g.lineWidth = 1;
      const x0 = Math.min(d.bx, d.x) - sx, y0 = Math.min(d.by, d.y) - sy;
      g.fillRect(x0, y0, Math.abs(d.x - d.bx), Math.abs(d.y - d.by)); g.strokeRect(x0 + 0.5, y0 + 0.5, Math.abs(d.x - d.bx), Math.abs(d.y - d.by));
    }
    if (!tracks.length) {
      g.fillStyle = '#9a9da5'; g.font = '13px Inter, system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('Drop audio files here, or add a track with +', w / 2, 60); g.textAlign = 'left';
    }
  }

  private drawNotes(g: CanvasRenderingContext2D, r: Region, x: number, y: number, rw: number, rh: number, col: string) {
    const notes = r.notes ?? [];
    if (!notes.length || rh < 6) return;
    let lo = 127, hi = 0;
    for (const n of notes) { if (n.p < lo) lo = n.p; if (n.p > hi) hi = n.p; }
    lo -= 2; hi += 2;
    const span = Math.max(12, hi - lo), ppb = this.ppb;
    const nh = Math.max(1.5, Math.min(4, (rh - 4) / span));
    g.fillStyle = col;
    for (const n of notes) {
      if (n.s >= r.length || n.s < 0) continue;
      const nx = x + n.s * ppb, nw = Math.max(1.5, Math.min(n.l, r.length - n.s) * ppb - 1);
      const ny = y + 2 + (1 - (n.p - lo) / span) * (rh - 4 - nh);
      g.fillRect(nx, ny, nw, nh);
    }
  }

  private drawWave(g: CanvasRenderingContext2D, r: Region, x: number, y: number, rw: number, rh: number, col: string, _sx: number, viewW: number) {
    const { store } = this.cmd;
    const peaks = store.peaks.get(r.bufferId), buf = store.buffers.get(r.bufferId);
    if (!peaks || !buf || rh < 6) return;
    const ppb = this.ppb, sr = buf.sampleRate;
    const mid = y + rh / 2, amp = rh / 2 - 1;
    const px0 = Math.max(0, Math.floor(-x)), px1 = Math.min(rw, viewW - x);
    g.fillStyle = col;
    g.beginPath();
    const base = store.secAt(r.start);
    let tPrev = r.offset + store.secAt(r.start + px0 / ppb) - base;
    for (let px = px0; px < px1; px++) {
      const tNext = r.offset + store.secAt(r.start + (px + 1) / ppb) - base;
      let i0 = Math.floor(tPrev * sr / PEAK_BUCKET);
      const i1 = Math.max(i0 + 1, Math.ceil(tNext * sr / PEAK_BUCKET));
      let m = 0;
      for (; i0 < i1 && i0 < peaks.length; i0++) if (peaks[i0] > m) m = peaks[i0];
      const hh = Math.max(0.5, Math.min(1, m) * amp);
      g.rect(x + px, mid - hh, 1, hh * 2);
      tPrev = tNext;
    }
    g.fill();
  }
}
