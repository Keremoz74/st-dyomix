# Ozmix Studio

A browser DAW (TypeScript + Web Audio) with a Logic Pro-style layout and the same key commands.

## Run
Open `dist/index.html` in Chrome, Edge or Safari. It works offline, and recording needs this standalone file because the Claude viewer blocks the microphone.

## Build
```
bun build.mjs        # bundles src/ into dist/index.html (one self-contained file)
tsc -p .             # type-check
```

## Layout
- `src/model.ts`: project, tracks, regions, UI state, undo/redo
- `src/audio/engine.ts`: Web Audio graph, lookahead scheduler (cycle, metronome), meters, recording, bounce
- `src/audio/plugins.ts`: built-in Audio FX (Channel EQ, Compressor, Space Reverb, Tape Delay)
- `src/audio/instruments.ts`: software instruments (Studio Synth with presets, Drum Kit)
- `src/ui/pianoroll.ts`: Piano Roll editor
- `src/audio/plugins2.ts` + `src/audio/worklets.ts`: more Audio FX — Noise Gate, DeEsser, Multipressor, Phaser, Flanger, Ring Modulator, Amp Designer, Bitcrusher, Exciter, Space Designer (convolution), Stereo Delay, Graphic EQ, Stereo Spread, Gain — with factory presets
- `src/audio/plugins3.ts`: Tape Delay, Vintage EQ, Pitch Shifter, Envelope Filter, Transient Designer, Tape Saturator, Fuzz, Wah, Analyzer
- `src/audio/keys.ts`: Electric Piano (FM) and Drawbar Organ instruments
- `src/audio/wam.ts` + `src/ui/pluginbrowser.ts`: Web Audio Modules 2.0 host (effects + instruments, community catalog, add by URL, state saved with the project)
- `src/audio/native.ts` + `src/audio/freeze.ts` + `src-tauri/src/native.rs`: native VST3/AU plug-ins in the desktop app (scan; offline rendering as an auto-updating freeze)
- `src/plugin-prefs.ts`: user presets, favorites, hidden plug-ins, My Plug-ins
- `src/ui/settings.ts`, `src/general-prefs.ts`, `src/audio/prefs.ts`, `src/keycommands.ts`: Settings (General, Audio, Recording & MIDI, Key Commands editor, Plug-in Manager, Web Audio Modules)
- `src/platform.ts`: packaged-app glue (native Save dialog via Tauri, share sheet on tablets, screen wake lock)
- `src/fonts.css` (built by `fonts/make-fonts.py`): embedded font subsets so the app works offline
- `src/movie.ts` + `src/ui/moviewin.ts`: Movie (video) synced to the timeline: floating Movie window with SMPTE timecode, Movie lane with thumbnails (drag to move the movie start), Import Audio from Movie, saved in projects and autosave
- `src/pattern.ts` + `src/ui/stepseq.ts`: Step Sequencer (pattern regions: steps × rows, Note/Velocity/Gate modes, row length/gate/mute/solo, rates 1/8–1/32 incl. triplets, swing, presets)
- `src/ui/scoreeditor.ts` + `src/notation.ts`: Score editor (grand staff / percussion staff, key signatures, beams, ties, rests)
- `src/ui/keyboard.ts`: Musical Typing (computer keyboard + touch)
- `src/automation.ts`: track automation (parameters, curves, Read/Touch)
- `src/ui/audioeditor.ts`: Audio Editor (normalize, gain, fades, reverse, silence on a selection)
- `src/takes.ts`: take folders and comping (pack, swipe comp, flatten, recording passes)
- `src/flex.ts`: Flex Time (WSOLA time-stretch, transients, flex markers, quantize, follow tempo)
- `src/session.ts`, `src/ui/sessioneditor.ts`: Session Players (Drummer, Bass, Keys)
- `src/autosave.ts`: autosave and recent projects (IndexedDB)
- `src/midi-input.ts`: Web MIDI keyboard input (with sustain pedal)
- `src/audio/zip.ts`: zip writer/reader
- `src/project-io.ts`: save/open projects (.zip with project.json + WAVs)
- `src/ui/pluginwin.ts`: plug-in window (knobs, EQ curve, gain reduction)
- `src/audio/demo.ts`: synthesizes the demo song
- `src/commands.ts`: every command (shared by buttons, menus and key commands)
- `src/ui/tracks.ts`: track headers, ruler, canvas timeline, region editing
- `src/ui/strip.ts`: channel strip (Inspector + Mixer)
- `src/ui/panels.ts`: control bar, Inspector, Mixer, Tool menu
- `src/main.ts`: wiring, key commands, render loop

## Key commands
Space play/stop · Enter go to start · R record · , . rewind/forward · C cycle · K metronome
X mixer · I inspector · T tool menu (then T/E/I/J/M) · ⌘-click = second tool
M / S mute/solo track · ↑ ↓ select track · ⌫ delete · ⌘Z / ⇧⌘Z undo/redo
⌘T split at playhead · ⌘J join · ⌘R repeat · ⌥-drag copy · ⌘← ⌘→ zoom · ⌥⌘N new track · ⇧⌘I import · ⌘B bounce · ⌘S save project · ⌘O open project
⌘, Settings · ⌥K Key Commands · ⇧⌘P Plug-in Browser · ⌥⌘O Open Movie · P / E Piano Roll · N Score · ⌘K Musical Typing (A–' play, Z/X octave, C/V velocity) · ⌥⌘S new instrument track
Fades: drag the upper corners of an audio region (or Fade tool, T then A). Sends: SENDS slots on each strip, aux channels in the Mixer.
Automation: A shows lanes · click to add a point, drag to move (⇧ = no snap), double-click to delete · Read plays the curve, Touch records fader/knob moves while playing.
Track Stacks: ⇧-click headers to select several, then ⇧⌘D (or the track icon menu). The stack is a summing channel.
Track menu: click a track's icon or right-click its header (rename, color, stacks, delete).
Markers: ⌥' create at playhead, double-click the Marker lane to add or rename, drag to move, ⌥. / ⌥, next/previous.
Tempo: double-click the Tempo lane to add a change, click a value to edit, drag to move, right-click to delete. Audio keeps its real-time length.
Audio Editor: double-click an audio region (or E). Drag to select; the tools act on the selection or the whole region.
Takes: record with Cycle on (each pass = a take) or record again over a region; or select audio regions on one track and Edit › Pack Take Folder. Double-click the folder: swipe across a take to comp, click a take name to use all of it, Flatten to make plain regions.
Flex: open an audio region (E), press ⇿ Flex. Drag a transient line to move that hit (⇧ = no snap), double-click an orange marker to remove it. Quantize moves every hit to the Grid (1/16). Follow Tempo stretches the audio when the tempo changes.
Recording: gear button = count-in, input device, recording offset (ms). Autopunch button + red ruler range = record only there. I on an audio track = input monitoring (use headphones). ⇧R = Capture as Recording (MIDI you played without recording). Recording over audio makes a take folder.
Touch: pinch with two fingers to zoom; drag empty space to scroll; double-tap a region to edit it; long-press a region or a track header for its menu.
Session Players: + › New Drummer / Session Bass / Session Keys Track. Pick a style, drag the XY pad (Simple↔Complex, Soft↔Loud), set fills/swing or chords; Edit as MIDI converts it.
Plug-ins: Channel EQ, Compressor, Limiter, Space Reverb, Tape Delay, Chorus, Overdrive, Tremolo/Auto Pan, Auto Filter. Sampler: + › New Sampler Track, then Load Sample (or drop a file on its window).
Autosave: work is saved in this browser every few seconds; the last project reopens on load; File › Open Recent switches projects.
In the Piano Roll: double-click add/remove note · ⌥↑↓ transpose (⇧ = octave) · ⌥←→ nudge · Q quantize · ⌫ delete

In the Step Sequencer (Functions › New Step Sequencer Track, or Create Pattern Region): click/drag steps on/off (⇧ = accent) · Velocity mode: drag up/down · Gate mode: drag a row · row name opens row options · Edit as MIDI converts to a normal region

In the Score: pick a note value, click the staff to insert · drag a note to change pitch/position · double-click to delete · ⌥↑↓ transpose · ⌘A select all · Key menu sets the key signature


## Desktop & tablet apps

The app is packaged with Tauri 2 for macOS, Windows, Linux, Android and iPadOS (`src-tauri/`, `.github/workflows/build.yml`). See PACKAGING.md.
