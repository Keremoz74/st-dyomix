import { Store } from './model';
import { Engine } from './audio/engine';
import { loadDemo, isOldDemo } from './audio/demo';
import { Commands, loadPrefs } from './commands';
import { h, toast, closeMenus } from './ui/dom';
import { TracksArea } from './ui/tracks';
import { ControlBar, Inspector, Mixer, ToolMenu } from './ui/panels';
import { PluginWindow } from './ui/pluginwin';
import { PianoRoll } from './ui/pianoroll';
import { MusicalTyping } from './ui/keyboard';
import { AudioEditor } from './ui/audioeditor';
import { SessionEditor } from './ui/sessioneditor';
import { ScoreEditor } from './ui/scoreeditor';
import { syncSessions } from './session';
import { syncPatterns } from './pattern';
import { StepSequencer } from './ui/stepseq';
import { MovieWindow } from './ui/moviewin';
import { keepAwake } from './platform';
import { Autosave } from './autosave';
import { MidiInput } from './midi-input';
import { KeyMap } from './keycommands';
import { PluginBrowser } from './ui/pluginbrowser';
import { SettingsWindow } from './ui/settings';
import { applyGeneralPrefs } from './general-prefs';
import { Freezer } from './audio/freeze';
import { onBankState, GM } from './audio/gm';
import { installFit } from './ui/fit';

const store = new Store();
// Session Player regions regenerate their notes after any structural change (resize, undo, open…). Registered first.
store.on(k => { if (k === 'structure') { syncSessions(store); syncPatterns(store); } });
const engine = new Engine(store);
const cmd = new Commands(store, engine);
(window as any).__daw = { store, cmd, engine }; // handy in the browser console

if (innerWidth < 900) store.ui.showInspector = false;
loadPrefs(store.ui);
// touch screens: taller tracks for fingers; phones held sideways get compact ones (and adjust on rotation)
const shortScreen = matchMedia('(pointer: coarse) and (max-height: 500px)');
if (matchMedia('(pointer: coarse)').matches) store.ui.trackH = shortScreen.matches ? 54 : 76;
shortScreen.addEventListener?.('change', () => { if (matchMedia('(pointer: coarse)').matches) { store.ui.trackH = shortScreen.matches ? 54 : 76; if (shortScreen.matches) store.ui.showInspector = false; store.emit('view'); } });
if (shortScreen.matches) store.ui.showInspector = false;

const controlBar = new ControlBar(cmd);
const inspector = new Inspector(cmd);
const tracks = new TracksArea(cmd);
const mixer = new Mixer(cmd);
const toolMenu = new ToolMenu(cmd);
const pluginWin = new PluginWindow(cmd);
cmd.openPlugin = (owner, id) => pluginWin.open(owner, id);
const pianoRoll = new PianoRoll(cmd);
const audioEd = new AudioEditor(cmd);
const sessionEd = new SessionEditor(cmd);
const scoreEd = new ScoreEditor(cmd);
const stepSeq = new StepSequencer(cmd);
const movieWin = new MovieWindow(cmd);
const typing = new MusicalTyping(cmd);
const midiIn = new MidiInput(cmd);
cmd.connectMidi = () => midiIn.connect();

const pluginBrowser = new PluginBrowser(cmd);
cmd.openPluginBrowser = (mode, trackId) => pluginBrowser.open(mode, trackId);
engine.onPluginError = msg => toast(msg);
const warned = new Set<string>();
onBankState((id, s) => { if (s === 'error' && !warned.has(id)) { warned.add(id); toast(`Couldn't download the “${GM.find(g => g[0] === id)?.[1] ?? id}” sounds — an internet connection is needed the first time. A similar built-in instrument plays instead for now.`); } });
const freezer = new Freezer(store, engine);
cmd.freezer = freezer;
freezer.onStatus = m => { if (m) toast(m); };
freezer.onError = m => toast(m);
const keymap = new KeyMap(cmd, {
  addMarker: () => { const m = cmd.addMarker(); if (m) tracks.editMarker(m.id); },
  pianoRoll: () => { if (store.ui.showEditor && store.ui.midiView === 'score') { store.ui.midiView = 'roll'; store.emit('view'); } else { store.ui.midiView = 'roll'; cmd.toggleEditor(); } },
  score: () => { store.ui.midiView = 'score'; if (!store.ui.showEditor) cmd.openEditor(); else store.emit('view'); },
  tools: () => toolMenu.show(mx, my),
});
const settings = new SettingsWindow(cmd, keymap);
cmd.openSettings = tab => settings.open(tab);
applyGeneralPrefs();
// Settings › General › Show help tags: off hides the hover tooltips
document.addEventListener('pointerover', e => {
  if (!document.documentElement.classList.contains('no-tooltips')) return;
  const el = (e.target as Element).closest?.('[title]'); if (el) { el.setAttribute('data-tip', el.getAttribute('title')!); el.removeAttribute('title'); }
}, true);

const app = document.getElementById('app')!;
app.replaceChildren(controlBar.el, h('div', { class: 'workspace' }, inspector.el, h('div', { class: 'center' }, tracks.el, pianoRoll.el, scoreEd.el, audioEd.el, sessionEd.el, stepSeq.el, mixer.el, typing.el)), movieWin.el);

// Pointer position for the T menu.
let mx = innerWidth / 2, my = innerHeight / 2;
addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; }, { passive: true });

// ---------- key commands (Logic defaults) ----------
addEventListener('keydown', e => {
  const tgt = e.target as HTMLElement;
  if (tgt && (tgt.tagName === 'INPUT' && (tgt as HTMLInputElement).type !== 'range' && (tgt as HTMLInputElement).type !== 'checkbox' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  if (toolMenu.open && !e.metaKey && !e.ctrlKey && toolMenu.key(e.key)) { e.preventDefault(); return; }
  if (typing.keyDown(e)) { e.preventDefault(); return; }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  const inScore = store.ui.focus === 'editor' && scoreEd.visible;
  const inEditor = store.ui.focus === 'editor' && store.ui.showEditor && !!pianoRoll.region && !inScore;
  const inAudioEd = store.ui.focus === 'editor' && store.ui.showEditor && !!audioEd.region;
  let handled = true;
  // editor-specific keys first (they depend on which editor has focus)
  if (inScore && mod && k === 'a') scoreEd.selectAll();
  else if (inScore && !mod && (k === 'backspace' || k === 'delete')) scoreEd.deleteSelected();
  else if (inScore && e.altKey && k === 'arrowup') scoreEd.transpose(e.shiftKey ? 12 : 1);
  else if (inScore && e.altKey && k === 'arrowdown') scoreEd.transpose(e.shiftKey ? -12 : -1);
  else if (inAudioEd && mod && k === 'a') audioEd.selectAll();
  else if (inAudioEd && !mod && k === 'escape') audioEd.clearSelection();
  else if (inEditor && mod && k === 'a') pianoRoll.selectAll();
  else if (inEditor && !mod && (k === 'backspace' || k === 'delete')) pianoRoll.deleteSelected();
  else if (inEditor && !mod && k === 'q') pianoRoll.quantize();
  else if (inEditor && e.altKey && k === 'arrowup') pianoRoll.transpose(e.shiftKey ? 12 : 1);
  else if (inEditor && e.altKey && k === 'arrowdown') pianoRoll.transpose(e.shiftKey ? -12 : -1);
  else if (inEditor && e.altKey && k === 'arrowleft') pianoRoll.nudge(-1);
  else if (inEditor && e.altKey && k === 'arrowright') pianoRoll.nudge(1);
  else if (k === 'escape') { closeMenus(); toolMenu.close(); pluginWin.close(); pluginBrowser.close(); settings.close(); }
  else {
    // everything else goes through the (reassignable) key commands
    const kc = keymap.find(e);
    if (kc) kc.run(); else handled = false;
  }
  if (handled) e.preventDefault();
});

addEventListener('keyup', e => typing.keyUp(e));
addEventListener('blur', () => typing.allOff());

// Holding ⌘/Ctrl shows the second tool's cursor, like Logic.
addEventListener('keydown', e => { if (e.key === 'Meta' || e.key === 'Control') tracks.markDirty(); });

// ---------- render loop ----------
function loop() {
  const beat = engine.currentBeat();
  if (store.ui.playing) store.ui.playhead = beat;
  controlBar.frame(beat);
  tracks.frame(beat, store.ui.playing);
  inspector.meters();
  mixer.meters();
  pluginWin.frame();
  pianoRoll.frame(beat);
  scoreEd.frame(beat);
  stepSeq.frame(beat);
  movieWin.frame(beat);
  audioEd.frame(beat);
  requestAnimationFrame(loop);
}
store.on(k => { if (k === 'view') document.body.classList.toggle('mixer-open', store.ui.showMixer); });

// Audio can only start after a user gesture; resume the context on the first one.
// iOS 17+: play through the speaker even when the ring/silent switch is on (like other music apps)
try { const as = (navigator as any).audioSession; if (as && as.type !== 'play-and-record') as.type = 'playback'; } catch { /* not supported */ }
// Mobile OSes suspend/interrupt audio when the app goes to the background or a call comes in,
// so check on every gesture and when the app comes back.
const unlock = () => { if (engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {}); };
addEventListener('pointerdown', unlock, { capture: true });
addEventListener('keydown', unlock, { capture: true });
store.on(k => { if (k === 'transport') keepAwake(store.ui.playing || store.ui.recording); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) unlock(); });

const autosave = new Autosave(store, engine);
cmd.autosave = autosave;
autosave.onSaved = () => { tracks.setSaved(autosave.lastSaved); cmd.refreshRecent(); };

installFit(f => store.on(k => { if (k === 'view' || k === 'structure') f(); }));

// Reopen the last autosaved project; first visit (or no storage) gets the demo song.
(async () => {
  const recent = await autosave.recent();
  cmd.recentList = recent;
  if (recent.length && await autosave.load(recent[0].id)) {
    if (isOldDemo(store)) {
      await loadDemo(store);
      store.emit('structure'); store.emit('view'); requestAnimationFrame(loop);
      toast('Demo song updated: now played by real instruments (drums, bass, piano, Rhodes, strings, sax).');
      return;
    }
    store.emit('structure'); store.emit('view'); store.emit('transport');
    requestAnimationFrame(loop);
    toast(`Welcome back: "${store.project.name}" reopened. File › Open Recent for others.`);
    return;
  }
  await loadDemo(store);
  store.emit('structure'); store.emit('view');
  requestAnimationFrame(loop);
  toast(matchMedia('(pointer: coarse)').matches ? 'Demo song loaded. Tap ▶ to play.' : 'Demo song loaded. Press Space to play.');
})().catch(err => {
  console.error(err);
  store.addTrack(); store.emit('structure'); requestAnimationFrame(loop);
  toast('Could not build the demo song, starting empty.');
});
