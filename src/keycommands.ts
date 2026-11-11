// Key Commands (Logic: Option-K): every global shortcut with its default key; people can reassign them in Settings.
import type { Commands } from './commands';

export interface KeyCommand { id: string; name: string; group: string; keys: string[]; run: () => void }

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

const PUNCT: Record<string, string> = { "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote' };
const CODES = Object.values(PUNCT);

/** Normalizes a keyboard event to a binding string like "Mod+Shift+Z", "Alt+Quote", "Space". */
export function eventCombo(e: KeyboardEvent): string {
  let key: string;
  const code = e.code || '';
  if ((e.altKey || e.key.length !== 1 || /[^\x20-\x7e]/.test(e.key)) && /^(Key|Digit)/.test(code)) key = code.replace(/^(Key|Digit)/, '');
  else if (e.key === ' ') key = 'Space';
  else if (e.key === 'Backspace' || e.key === 'Delete') key = 'Delete';
  else if (PUNCT[e.key]) key = PUNCT[e.key];                     // by the character typed (works on any keyboard layout)
  else if (e.altKey && CODES.includes(code)) key = code;          // ⌥ turns punctuation into other symbols on a Mac
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key; // ArrowUp, Enter, Escape, F1…
  const mods = [];
  // Mod = ⌘ on Mac, Ctrl elsewhere; on Mac, Ctrl is its own modifier
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac && e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}

const SYM: Record<string, string> = { Mod: mac ? '⌘' : 'Ctrl+', Ctrl: '⌃', Alt: mac ? '⌥' : 'Alt+', Shift: mac ? '⇧' : 'Shift+', Space: 'Space', Delete: '⌫', Enter: '↩', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Quote: "'", Comma: ',', Period: '.', Slash: '/', Semicolon: ';', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`' };
/** Display form: "⇧⌘Z" on Mac, "Ctrl+Shift+Z" elsewhere. */
export function prettyCombo(c: string) {
  const parts = c.split('+'), key = parts.pop()!;
  const order = mac ? ['Ctrl', 'Alt', 'Shift', 'Mod'] : ['Mod', 'Ctrl', 'Alt', 'Shift'];
  return order.filter(m => parts.includes(m)).map(m => SYM[m]).join('') + (SYM[key] ?? key);
}

const overrides = (): Record<string, string[]> => { try { return JSON.parse(localStorage.getItem('daw.keys') || '{}'); } catch { return {}; } };

export class KeyMap {
  list: KeyCommand[];
  private byCombo = new Map<string, KeyCommand>();

  constructor(cmd: Commands, extra: Record<string, () => void>) {
    const c = cmd, x = extra;
    const k = (id: string, name: string, group: string, keys: string[], run: () => void): KeyCommand => ({ id, name, group, keys, run });
    this.list = [
      k('play', 'Play or Stop', 'Transport', ['Space'], c.togglePlay),
      k('start', 'Go to Beginning', 'Transport', ['Enter'], c.goToStart),
      k('record', 'Record', 'Transport', ['R'], c.record),
      k('capture', 'Capture as Recording', 'Transport', ['Shift+R'], c.captureRecording),
      k('rewind', 'Rewind', 'Transport', ['Comma'], c.rewind),
      k('forward', 'Forward', 'Transport', ['Period'], c.forward),
      k('cycle', 'Cycle Mode', 'Transport', ['C'], c.toggleCycle),
      k('metronome', 'Metronome', 'Transport', ['K'], c.toggleMetronome),
      k('undo', 'Undo', 'Edit', ['Mod+Z'], c.undo),
      k('redo', 'Redo', 'Edit', ['Mod+Shift+Z'], c.redo),
      k('selectAll', 'Select All', 'Edit', ['Mod+A'], c.selectAll),
      k('delete', 'Delete', 'Edit', ['Delete'], c.deleteSelected),
      k('cut', 'Cut', 'Edit', ['Mod+X'], c.cutRegions),
      k('copy', 'Copy', 'Edit', ['Mod+C'], c.copyRegions),
      k('paste', 'Paste at Playhead', 'Edit', ['Mod+V'], c.pasteRegions),
      k('nudgeL', 'Nudge Left', 'Edit', ['Alt+ArrowLeft'], () => c.nudgeRegions(-1)),
      k('nudgeR', 'Nudge Right', 'Edit', ['Alt+ArrowRight'], () => c.nudgeRegions(1)),
      k('transUp', 'Transpose MIDI Regions +1', 'Edit', ['Alt+ArrowUp'], () => c.transposeRegions(1)),
      k('transDown', 'Transpose MIDI Regions −1', 'Edit', ['Alt+ArrowDown'], () => c.transposeRegions(-1)),
      k('octUp', 'Transpose MIDI Regions +12', 'Edit', ['Alt+Shift+ArrowUp'], () => c.transposeRegions(12)),
      k('octDown', 'Transpose MIDI Regions −12', 'Edit', ['Alt+Shift+ArrowDown'], () => c.transposeRegions(-12)),
      k('quantize', 'Quantize MIDI Regions', 'Edit', ['Q'], c.quantizeRegions),
      k('split', 'Split at Playhead', 'Edit', ['Mod+T'], c.splitAtPlayhead),
      k('join', 'Join Regions', 'Edit', ['Mod+J'], c.joinSelected),
      k('repeat', 'Repeat Regions', 'Edit', ['Mod+R'], c.repeat),
      k('regionMute', 'Mute Regions', 'Edit', [mac ? 'Ctrl+M' : 'Mod+M'], c.toggleRegionMute),
      k('save', 'Save Project', 'File', ['Mod+S'], c.saveProject),
      k('open', 'Open Project', 'File', ['Mod+O'], c.openProject),
      k('bounce', 'Bounce to WAV', 'File', ['Mod+B'], c.bounce),
      k('import', 'Import Audio File', 'File', ['Mod+Shift+I'], c.importAudio),
      k('movie', 'Open Movie', 'File', ['Mod+Alt+O'], c.openMovie),
      k('settings', 'Settings', 'File', ['Mod+Comma'], () => c.openSettings()),
      k('newAudio', 'New Audio Track', 'Track', ['Mod+Alt+A', 'Mod+Alt+N'], c.newTrack),
      k('newInst', 'New Software Instrument Track', 'Track', ['Mod+Alt+S'], () => c.newInstrumentTrack('gm')),
      k('stack', 'Create Track Stack', 'Track', ['Mod+Shift+D'], c.createStack),
      k('dupTrack', 'New Track with Duplicate Settings', 'Track', ['Mod+D'], c.duplicateTrack),
      k('bip', 'Bounce in Place', 'Track', [mac ? 'Ctrl+B' : 'Mod+Alt+B'], c.bounceInPlace),
      k('deleteTrack', 'Delete Track', 'Track', ['Mod+Delete'], c.deleteTrack),
      k('mute', 'Mute Track', 'Track', ['M'], () => c.toggleTrack('mute')),
      k('solo', 'Solo Track', 'Track', ['S'], () => c.toggleTrack('solo')),
      k('prevTrack', 'Select Previous Track', 'Track', ['ArrowUp'], () => c.selectTrackOffset(-1)),
      k('nextTrack', 'Select Next Track', 'Track', ['ArrowDown'], () => c.selectTrackOffset(1)),
      k('addMarker', 'Create Marker', 'Markers', ['Alt+Quote'], x.addMarker),
      k('nextMarker', 'Go to Next Marker', 'Markers', ['Alt+Period'], () => c.gotoMarker(1)),
      k('prevMarker', 'Go to Previous Marker', 'Markers', ['Alt+Comma'], () => c.gotoMarker(-1)),
      k('mixer', 'Show/Hide Mixer', 'View', ['X'], c.toggleMixer),
      k('inspector', 'Show/Hide Inspector', 'View', ['I'], c.toggleInspector),
      k('editor', 'Show/Hide Editor', 'View', ['E'], c.toggleEditor),
      k('pianoRoll', 'Piano Roll', 'View', ['P'], x.pianoRoll),
      k('score', 'Score', 'View', ['N'], x.score),
      k('automation', 'Show/Hide Automation', 'View', ['A'], c.toggleAutomation),
      k('typing', 'Musical Typing', 'View', ['Mod+K'], c.toggleKeyboard),
      k('tools', 'Tool Menu', 'View', ['T'], x.tools),
      k('zoomIn', 'Zoom In', 'View', ['Mod+ArrowRight'], () => c.zoom(1.4)),
      k('zoomOut', 'Zoom Out', 'View', ['Mod+ArrowLeft'], () => c.zoom(1 / 1.4)),
      k('browser', 'Plug-in Browser', 'View', ['Mod+Shift+P'], () => c.openPluginBrowser('fx')),
      k('keyCmds', 'Key Commands', 'View', ['Alt+K'], () => c.openSettings('keys')),
    ];
    this.defaults = Object.fromEntries(this.list.map(kc => [kc.id, [...kc.keys]]));
    this.apply();
  }
  private defaults: Record<string, string[]>;

  /** Re-reads the person's reassignments. */
  apply() {
    const o = overrides();
    for (const kc of this.list) kc.keys = o[kc.id] ?? [...this.defaults[kc.id]];
    this.byCombo.clear();
    for (const kc of this.list) for (const key of kc.keys) this.byCombo.set(key, kc);
  }
  find(e: KeyboardEvent) { return this.byCombo.get(eventCombo(e)); }
  owner(combo: string) { return this.byCombo.get(combo); }
  isDefault(id: string) { const kc = this.list.find(x => x.id === id)!; return JSON.stringify(kc.keys) === JSON.stringify(this.defaults[id]); }

  /** Assigns a key to a command; takes the key away from any other command. Empty combo = no key. */
  assign(id: string, combo: string) {
    const o = overrides();
    for (const kc of this.list) if (kc.id !== id && kc.keys.includes(combo)) o[kc.id] = kc.keys.filter(x => x !== combo);
    o[id] = combo ? [combo] : [];
    this.save(o);
  }
  reset(id?: string) { const o = overrides(); if (id) delete o[id]; this.save(id ? o : {}); }
  private save(o: Record<string, string[]>) { try { localStorage.setItem('daw.keys', JSON.stringify(o)); } catch { /* */ } this.apply(); }
}
