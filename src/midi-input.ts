// Web MIDI input: plays (and records into) the selected software instrument, with sustain pedal.
import { Commands } from './commands';
import { toast } from './ui/dom';

export class MidiInput {
  private access: MIDIAccess | null = null;
  private held = new Map<number, string>(); // pitch -> trackId
  private sustained = new Set<number>();
  private pedal = false;
  connected: string[] = [];

  constructor(private cmd: Commands) {
    // Connect silently if permission was granted before; otherwise wait for the menu command.
    (navigator.permissions as any)?.query?.({ name: 'midi' }).then((p: PermissionStatus) => { if (p.state === 'granted') this.connect(true); }).catch(() => {});
  }

  async connect(silent = false) {
    if (!('requestMIDIAccess' in navigator)) { if (!silent) toast('This browser has no Web MIDI. Try Chrome or Edge.'); return; }
    try {
      this.access = await navigator.requestMIDIAccess();
    } catch {
      if (!silent) toast(window.self !== window.top ? 'MIDI is blocked in this viewer. Open the standalone file in Chrome to use a MIDI keyboard.' : 'MIDI access was blocked.');
      return;
    }
    this.access.onstatechange = () => this.bind(false);
    this.bind(!silent);
  }

  private bind(announce: boolean) {
    if (!this.access) return;
    const names: string[] = [];
    this.access.inputs.forEach(inp => { inp.onmidimessage = e => this.onMessage(e.data); names.push(inp.name ?? 'MIDI device'); });
    const added = names.filter(n => !this.connected.includes(n));
    this.connected = names;
    if (added.length) toast(`MIDI connected: ${added.join(', ')}`);
    else if (announce) toast(names.length ? `MIDI ready: ${names.join(', ')}` : 'MIDI is on, but no keyboard is connected');
  }

  private onMessage(data: Uint8Array | null) {
    if (!data || data.length < 2) return;
    const type = data[0] & 0xf0, d1 = data[1], d2 = data[2] ?? 0;
    if (type === 0x90 && d2 > 0) {
      const t = this.cmd.liveTarget(); if (!t) return;
      this.sustained.delete(d1);
      this.held.set(d1, t.id);
      this.cmd.engine.noteOn(t.id, d1, d2);
    } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
      if (this.pedal) { this.sustained.add(d1); return; }
      this.release(d1);
    } else if (type === 0xb0 && d1 === 64) {
      this.pedal = d2 >= 64;
      if (!this.pedal) { for (const p of this.sustained) this.release(p); this.sustained.clear(); }
    }
  }

  private release(p: number) {
    const id = this.held.get(p); if (!id) return;
    this.held.delete(p);
    this.cmd.engine.noteOff(id, p);
  }
}
