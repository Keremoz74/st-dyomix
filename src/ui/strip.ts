// Channel strip used by both the Inspector and the Mixer.
import { Track, dbToFader, faderToDb, fmtDb } from '../model';
import { Commands } from '../commands';
import { h, icon, openMenu, MenuItem } from './dom';
import { MAX_INSERTS } from '../audio/plugins';
import { fxMenu, instrumentMenu } from './pluginmenu';

export interface StripHandle { el: HTMLElement; meter: () => void; refresh: () => void }

const METER_H = 140;
const levelToH = (v: number) => {
  if (v <= 0.0001) return 0;
  const db = 20 * Math.log10(v);
  return Math.max(0, Math.min(1, (db + 60) / 66)) * METER_H;
};

export function channelStrip(cmd: Commands, track: Track | null, opts: { selected?: boolean } = {}): StripHandle {
  const { store, engine } = cmd;
  const isMaster = !track;
  const color = track?.color ?? '#9aa0aa';
  const getDb = () => (track ? track.volume : store.project.masterVolume);
  const setDb = (db: number) => { if (track) { cmd.setTrackVolume(track, db); cmd.gesture(track.id, 'volume', 'value', db); } else store.project.masterVolume = db; };

  const dbLabel = h('span', { class: 'st-val' }, fmtDb(getDb()));
  const peakLabel = h('span', { class: 'st-val' }, '-∞');
  let peakHold = 0;

  // fader
  const thumb = h('div', { class: 'st-thumb' });
  const fader = h('div', { class: 'st-fader', role: 'slider', tabindex: '0', 'aria-label': `${track?.name ?? 'Stereo Out'} volume`, 'aria-valuemin': '-60', 'aria-valuemax': '6' }, h('div', { class: 'st-rail' }), thumb);
  const placeThumb = () => {
    const p = dbToFader(getDb());
    thumb.style.top = `${(1 - p) * (METER_H - 18)}px`;
    fader.setAttribute('aria-valuenow', getDb().toFixed(1));
    dbLabel.textContent = fmtDb(getDb());
  };
  placeThumb();
  const setFromY = (clientY: number) => {
    const r = fader.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, 1 - (clientY - r.top - 9) / (METER_H - 18)));
    let db = faderToDb(p);
    if (!isFinite(db) || db < -60) db = -60;
    if (Math.abs(db) < 0.4) db = 0;
    setDb(Math.round(db * 10) / 10);
    placeThumb();
    store.emit('mix');
  };
  fader.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (e.altKey) { setDb(0); placeThumb(); store.emit('mix'); return; }
    fader.setPointerCapture(e.pointerId);
    if (track) cmd.gesture(track.id, 'volume', 'start');
    const startY = e.clientY, startDb = getDb(), fine = e.shiftKey;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      if (fine) { setDb(Math.max(-60, Math.min(6, Math.round((startDb - (ev.clientY - startY) * 0.05) * 10) / 10))); placeThumb(); store.emit('mix'); }
      else setFromY(ev.clientY);
    };
    const up = () => { fader.removeEventListener('pointermove', move); fader.removeEventListener('pointerup', up); if (!moved && e.target !== thumb) setFromY(e.clientY); if (track) cmd.gesture(track.id, 'volume', 'end'); };
    fader.addEventListener('pointermove', move); fader.addEventListener('pointerup', up);
  });
  fader.addEventListener('dblclick', () => { setDb(0); placeThumb(); store.emit('mix'); });
  fader.addEventListener('keydown', e => {
    const d = e.key === 'ArrowUp' ? 0.5 : e.key === 'ArrowDown' ? -0.5 : 0;
    if (!d) return;
    e.preventDefault(); e.stopPropagation();
    setDb(Math.max(-60, Math.min(6, Math.round((getDb() + d) * 10) / 10))); placeThumb(); store.emit('mix');
  });

  const mL = h('div', { class: 'st-meter-fill' }), mR = h('div', { class: 'st-meter-fill' });
  const scale = h('div', { class: 'st-scale' }, [['+6', 6], ['0', 0], ['-6', -6], ['-12', -12], ['-24', -24], ['-40', -40], ['-60', -60]].map(([l, db]) =>
    h('span', { style: { top: `${(1 - ((db as number) + 60) / 66) * METER_H - 5}px` } }, l as string)));

  // pan knob
  let panEl: HTMLElement | null = null;
  let showPan = () => {};
  if (track) {
    const ind = h('div', { class: 'st-pan-ind' });
    const val = h('span', { class: 'st-pan-val' });
    const show = () => { ind.style.transform = `rotate(${track.pan * 135}deg)`; val.textContent = track.pan === 0 ? 'C' : `${Math.round(Math.abs(track.pan) * 64)}${track.pan < 0 ? 'L' : 'R'}`; };
    show(); showPan = show;
    const knob = h('div', { class: 'st-pan', role: 'slider', tabindex: '0', 'aria-label': `${track.name} pan`, title: 'Pan: drag up/down, double-click to center' }, ind);
    knob.addEventListener('pointerdown', e => {
      e.preventDefault(); knob.setPointerCapture(e.pointerId);
      cmd.gesture(track.id, 'pan', 'start');
      const y0 = e.clientY, p0 = track.pan;
      const move = (ev: PointerEvent) => { track.pan = Math.max(-1, Math.min(1, Math.round((p0 - (ev.clientY - y0) / 100) * 64) / 64)); cmd.gesture(track.id, 'pan', 'value', track.pan); show(); store.emit('mix'); };
      const up = () => { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); cmd.gesture(track.id, 'pan', 'end'); };
      knob.addEventListener('pointermove', move); knob.addEventListener('pointerup', up);
    });
    knob.addEventListener('dblclick', () => { track.pan = 0; show(); store.emit('mix'); });
    knob.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 / 64 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 / 64 : 0;
      if (!d) return; e.preventDefault(); e.stopPropagation();
      track.pan = Math.max(-1, Math.min(1, track.pan + d)); show(); store.emit('mix');
    });
    panEl = h('div', { class: 'st-pan-row' }, knob, val);
  }

  const btn = (label: string, key: 'mute' | 'solo' | 'armed', aria: string) =>
    h('button', { onPointerdown: (e: PointerEvent) => e.stopPropagation(), class: `tb tb-${key}${track![key] ? ' on' : ''}`, 'aria-label': aria, 'aria-pressed': String(track![key]), onClick: () => cmd.toggleTrack(key, track!.id) }, label);

  // insert slots
  const owner = track ? track.id : 'master';
  const inserts = store.insertsOf(owner);
  const addMenu = (anchor: HTMLElement) => openMenu(anchor, fxMenu(cmd, (type, wam, nat) => cmd.addPlugin(owner, type, wam, nat)));
  const slots: HTMLElement[] = [];
  // every strip shows the same number of slots (so strips line up): the longest chain + one free slot
  const longest = Math.max(store.project.masterInserts.length, ...store.channels().map(c => c.inserts.length));
  const nSlots = Math.min(MAX_INSERTS, Math.max(4, longest + 1));
  for (let i = 0; i < nSlots; i++) {
    const ins = inserts[i];
    if (ins) {
      const name = cmd.pluginName(ins);
      const nameBtn = h('button', { class: 'st-fx-name', title: `${name}: click to open`, onClick: () => cmd.togglePlugin(owner, ins.id) }, name);
      const slot = h('div', { class: 'st-slot st-fx' + (ins.bypass ? ' byp' : '') },
        h('button', { class: 'st-fx-pow', 'aria-label': `${ins.bypass ? 'Enable' : 'Bypass'} ${name}`, 'aria-pressed': String(!ins.bypass), title: ins.bypass ? 'Enable' : 'Bypass', onClick: () => cmd.toggleBypass(owner, ins.id) }, icon('power', 10)),
        nameBtn);
      slot.addEventListener('contextmenu', e => {
        e.preventDefault();
        openMenu(slot, [['Open', '', () => cmd.openPlugin(owner, ins.id)], [ins.bypass ? 'Enable' : 'Bypass', '', () => cmd.toggleBypass(owner, ins.id)], ['Remove', '', () => cmd.removePlugin(owner, ins.id)], '-',
          ['Move Up', '', () => cmd.movePlugin(owner, ins.id, -1)], ['Move Down', '', () => cmd.movePlugin(owner, ins.id, 1)], '-',
          { label: 'Replace with', sub: fxMenu(cmd, (type, wam, nat) => cmd.replacePlugin(owner, ins.id, type, wam, nat), { type: ins.type, url: ins.wam?.url ?? ins.native?.path }) }]);
      });
      slots.push(slot);
    } else if (i === inserts.length) {
      const add: HTMLButtonElement = h('button', { class: 'st-slot st-add', 'aria-label': `Add plug-in to ${track?.name ?? 'Stereo Out'}`, title: 'Add Audio FX', onClick: () => addMenu(add) }, '+');
      slots.push(add);
    } else slots.push(h('div', { class: 'st-slot st-empty' }));
  }

  // send slots (post-fader) — audio/instrument channels only; others keep the space so strips line up
  const sendSlots: HTMLElement[] = [];
  const canSend = !!track && track.kind !== 'aux';
  const outName = track?.parent ? store.track(track.parent)?.name ?? 'Stack' : track ? 'Stereo Out' : 'Out 1-2';
  const busMenu = (pick: (bus: number) => void, current?: number): MenuItem[] => [
    ...store.project.auxes.map(a => [`Bus ${a.bus} · ${a.name}`, '', () => pick(a.bus!), a.bus === current] as MenuItem),
    ...(current == null ? ['-', ['New Reverb Bus', '', () => cmd.newBusSend(track!.id, 'reverb')], ['New Delay Bus', '', () => cmd.newBusSend(track!.id, 'delay')], ['New Empty Aux', '', () => cmd.newBusSend(track!.id, null)]] as MenuItem[] : []),
  ];
  for (let i = 0; i < 2; i++) {
    const sd = canSend ? track!.sends?.[i] : undefined;
    if (sd) {
      const aux = store.auxForBus(sd.bus);
      const lvl = h('span', { class: 'st-send-lvl' }, fmtDb(sd.level));
      const slot = h('div', { class: 'st-slot st-send', role: 'slider', tabindex: '0', 'aria-label': `Send to ${aux?.name ?? `Bus ${sd.bus}`} level`, 'aria-valuenow': String(sd.level), title: 'Drag up/down for level · click for options · double-click = 0 dB' },
        h('span', { class: 'st-send-name' }, aux?.name ?? `Bus ${sd.bus}`), lvl);
      slot.addEventListener('pointerdown', e => {
        e.preventDefault(); slot.setPointerCapture(e.pointerId);
        const y0 = e.clientY, l0 = sd.level; let moved = false;
        cmd.gesture(track!.id, `send:${sd.id}`, 'start');
        const move = (ev: PointerEvent) => {
          if (!moved && Math.abs(ev.clientY - y0) < 3) return;
          if (!moved) { store.checkpoint(); moved = true; }
          cmd.setSendLevel(track!.id, sd.id, l0 - (ev.clientY - y0) * (ev.shiftKey ? 0.05 : 0.25)); lvl.textContent = fmtDb(sd.level);
          cmd.gesture(track!.id, `send:${sd.id}`, 'value', sd.level);
        };
        const up = () => {
          slot.removeEventListener('pointermove', move); slot.removeEventListener('pointerup', up);
          cmd.gesture(track!.id, `send:${sd.id}`, 'end');
          if (!moved) openMenu(slot, [...busMenu(b => cmd.setSendBus(track!.id, sd.id, b), sd.bus), '-', ['Remove Send', '', () => cmd.removeSend(track!.id, sd.id)]]);
        };
        slot.addEventListener('pointermove', move); slot.addEventListener('pointerup', up);
      });
      slot.addEventListener('dblclick', () => { store.checkpoint(); cmd.setSendLevel(track!.id, sd.id, 0); lvl.textContent = fmtDb(0); });
      slot.addEventListener('keydown', e => {
        const d = e.key === 'ArrowUp' ? 0.5 : e.key === 'ArrowDown' ? -0.5 : 0; if (!d) return;
        e.preventDefault(); e.stopPropagation(); cmd.setSendLevel(track!.id, sd.id, sd.level + d); lvl.textContent = fmtDb(sd.level);
      });
      sendSlots.push(slot);
    } else if (canSend && i === (track!.sends?.length ?? 0)) {
      const add: HTMLButtonElement = h('button', { class: 'st-slot st-add', 'aria-label': `Add send on ${track!.name}`, title: 'Add send to a bus', onClick: () => openMenu(add, busMenu(b => cmd.addSend(track!.id, b))) }, '+');
      sendSlots.push(add);
    } else sendSlots.push(h('div', { class: 'st-slot st-empty' + (canSend ? '' : ' st-blank') }));
  }

  // EQ thumbnail (Logic style): shows the first EQ's curve; tap opens it, or adds a Pro EQ
  const eqIns = () => (track ? track.inserts : store.project.masterInserts).find(i => i.type === 'peq' || i.type === 'eq' || i.type === 'geq' || i.type === 'veq');
  const owner0 = track ? track.id : 'master';
  const eqCv = h('canvas', { class: 'st-eqthumb', 'aria-label': 'EQ: tap to open', role: 'button', tabindex: '0' }) as HTMLCanvasElement;
  eqCv.addEventListener('click', () => { const e = eqIns(); if (e) cmd.togglePlugin(owner0, e.id); else { cmd.addPlugin(owner0, 'peq'); } });
  const fq = new Float32Array(64).map((_, i) => 20 * Math.pow(1000, i / 63)), mg = new Float32Array(64), ph = new Float32Array(64);
  let eqTick = 0;
  const drawEqThumb = () => {
    const w = eqCv.clientWidth, hh = eqCv.clientHeight; if (!w) return;
    const dpr = devicePixelRatio || 1;
    if (eqCv.width !== Math.round(w * dpr)) { eqCv.width = Math.round(w * dpr); eqCv.height = Math.round(hh * dpr); }
    const g = eqCv.getContext('2d')!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0d0e11'; g.fillRect(0, 0, w, hh);
    g.fillStyle = '#ffffff10'; g.fillRect(0, hh / 2, w, 1);
    const e = eqIns(), inst = e ? engine.plugin(owner0, e.id) : undefined;
    if (!e || !inst?.eqNodes?.length) { g.fillStyle = '#5d6068'; g.font = '700 9px Inter, sans-serif'; g.textAlign = 'center'; g.fillText('EQ', w / 2, hh / 2 + 3); g.textAlign = 'left'; return; }
    const tot = new Float32Array(64).fill(1);
    for (const n of inst.eqNodes) { n.getFrequencyResponse(fq, mg, ph); for (let i = 0; i < 64; i++) tot[i] *= mg[i]; }
    g.beginPath();
    for (let i = 0; i < 64; i++) { const x = i / 63 * w, y = hh / 2 - Math.max(-18, Math.min(18, 20 * Math.log10(tot[i] || 1e-6))) / 18 * (hh / 2 - 2); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = e.bypass ? '#6a6d75' : '#6fb6ff'; g.lineWidth = 1.4; g.stroke();
    g.lineTo(w, hh / 2); g.lineTo(0, hh / 2); g.closePath(); g.fillStyle = e.bypass ? '#6a6d7520' : '#4c9aff2a'; g.fill();
  };
  const el = h('div', { class: 'strip' + (opts.selected ? ' selected' : '') },
    eqCv,
    track?.instrument
      ? (() => { const b: HTMLButtonElement = h('button', { class: 'st-slot st-inst', title: 'Open instrument (right-click to change it)', 'aria-label': `Open instrument on ${track.name}`, onClick: () => cmd.togglePlugin(track.id, 'inst') }, track.instrument.type === 'wam' ? track.instrument.wam?.name ?? 'Plug-in' : track.instrument.preset);
          b.addEventListener('contextmenu', e => { e.preventDefault(); openMenu(b, instrumentMenu(cmd, track.id)); }); return b; })()
      : track && track.kind !== 'aux' && track.kind !== 'folder'
        ? (() => { const b: HTMLButtonElement = h('button', { class: 'st-slot st-in', 'aria-haspopup': 'menu', title: 'Input', onClick: () => openMenu(b, [
            { header: 'Input' }, ['Input 1 (microphone / audio interface)', '', () => {}, true], '-',
            ['Input Monitoring', 'I', () => cmd.toggleTrack('monitor', track.id), !!track.monitor], ['Record Enable', 'R', () => cmd.toggleTrack('armed', track.id), !!track.armed],
            ['Recording Settings…', '', () => cmd.openSettings('recording')],
          ]) }, 'Input 1'); return b; })()
        : h('div', { class: 'st-slot st-in' }, track?.kind === 'aux' ? `Bus ${track.bus}` : track?.kind === 'folder' ? 'Stack' : 'Stereo'),
    h('div', { class: 'st-label' }, 'AUDIO FX'),
    slots,
    h('div', { class: 'st-label' }, canSend ? 'SENDS' : ' '),
    sendSlots,
    (() => { const b: HTMLButtonElement = h('button', { class: 'st-slot st-out' + (track?.parent ? ' st-to-stack' : ''), 'aria-haspopup': 'menu', title: 'Output', onClick: () => openMenu(b, [
        { header: 'Output' }, [outName, '', () => {}, true],
        { header: track ? 'To feed a bus (reverb, delay…), use a Send above' : 'The main output of the song' },
      ]) }, outName); return b; })(),
    track && track.kind !== 'aux'
      ? (() => { const m = track.autoMode ?? 'off'; const b: HTMLButtonElement = h('button', { class: `st-slot st-auto auto-${m}`, title: 'Automation mode', 'aria-label': `Automation mode: ${m}`, onClick: () => openMenu(b, (['off', 'read', 'touch'] as const).map(x => [x[0].toUpperCase() + x.slice(1), '', () => cmd.setAutoMode(track.id, x), x === m] as MenuItem)) }, m[0].toUpperCase() + m.slice(1)); return b; })()
      : h('div', { class: 'st-slot st-blank' }),
    panEl ?? h('div', { class: 'st-pan-row' }),
    h('div', { class: 'st-vals' }, dbLabel, peakLabel),
    h('div', { class: 'st-body' }, scale, fader, h('div', { class: 'st-meter' }, mL), h('div', { class: 'st-meter' }, mR)),
    track ? h('div', { class: 'st-btns' }, btn('M', 'mute', 'Mute'), btn('S', 'solo', 'Solo'), track.kind !== 'aux' && track.kind !== 'folder' ? btn('R', 'armed', 'Record enable') : null) : h('div', { class: 'st-btns' }),
    (() => {
      const nm: HTMLElement = h('div', { class: 'st-name', style: { background: color }, onClick: () => {
        if (!track) return;
        if (track.kind === 'aux') openMenu(nm, [['Select', '', () => { store.ui.selectedTrackId = track.id; store.emit('structure'); }], ['Delete Aux', '', () => cmd.deleteAux(track.id)]]);
        else { store.ui.selectedTrackId = track.id; store.emit('structure'); }
      } }, track?.name ?? 'Stereo Out');
      return nm;
    })(),
  );

  const meter = () => {
    if (++eqTick % 12 === 1) drawEqThumb();
    const [l, r] = engine.levels(track ? track.id : 'master');
    mL.style.height = `${levelToH(l)}px`; mR.style.height = `${levelToH(r)}px`;
    const p = Math.max(l, r);
    if (p > peakHold) { peakHold = p; peakLabel.textContent = fmtDb(20 * Math.log10(p)); peakLabel.classList.toggle('clip', p >= 1); }
  };
  peakLabel.addEventListener('click', () => { peakHold = 0; peakLabel.textContent = '-∞'; peakLabel.classList.remove('clip'); });
  return { el, meter, refresh: () => { placeThumb(); showPan(); } };
}
