// Freeze for native (VST3/AU) plug-ins: a track whose chain contains native plug-ins is rendered offline
// (sources → built-in/WAM plug-ins → native plug-in via the desktop app → …) and plays back as a freeze file.
// Edits make the freeze stale; it re-renders by itself shortly after the last change.
import type { Store, Track, Insert } from '../model';
import type { Engine } from './engine';
import { renderNative } from './native';

export class Freezer {
  private busy = new Set<string>();
  private timer: number | undefined;
  /** Called with a status line while rendering (null when done). */
  onStatus: (msg: string | null) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor(private store: Store, private engine: Engine) {
    engine.frozenBuffer = t => (this.fresh(t) ? t.freeze!.bufferId : null);
    engine.beforeBounce = () => this.updateAll();
    store.on(k => { if (k === 'structure' || k === 'fx') this.schedule(); });
  }

  static needs(t: Track) { return t.inserts.some(i => i.type === 'native' && !i.bypass && i.native); }

  /** Everything the freeze depends on. */
  sig(t: Track) {
    const st = this.store, p = st.project;
    const regs = p.regions.filter(r => r.trackId === t.id).map(r => [r.start, r.length, r.offset, r.muted, r.bufferId, r.notes, r.gain, r.fadeIn, r.fadeOut, r.takes, r.comp, r.flex, r.kind]);
    const ins = t.inserts.filter(i => !i.bypass).map(i => [i.type, i.params, i.wam?.url, i.native?.path, i.native?.params]);
    return JSON.stringify([regs, ins, t.instrument, p.tempo, p.tempoEvents, p.sigNum]);
  }
  fresh(t: Track) { return !!t.freeze && Freezer.needs(t) && this.store.buffers.has(t.freeze.bufferId) && t.freeze.sig === this.sig(t); }
  stale(t: Track) { return Freezer.needs(t) && !this.fresh(t); }
  rendering(t: Track) { return this.busy.has(t.id); }

  private schedule() {
    clearTimeout(this.timer);
    if (!this.store.project.tracks.some(t => this.stale(t))) return;
    this.timer = window.setTimeout(() => this.updateAll(), 1200);
  }

  async updateAll() {
    for (const t of this.store.project.tracks) if (this.stale(t) && !this.busy.has(t.id)) await this.freeze(t);
  }

  /** Renders a track through its chain, splitting the chain at each native plug-in. */
  async freeze(t: Track) {
    const sig = this.sig(t);
    this.busy.add(t.id);
    this.store.emit('view');
    try {
      const groups: (Insert[] | Insert)[] = [];
      let cur: Insert[] = [];
      for (const i of t.inserts) {
        if (i.bypass) continue;
        if (i.type === 'native' && i.native) { groups.push(cur, i); cur = []; } else cur.push(i);
      }
      groups.push(cur);
      let buf = await this.engine.renderTrack(t, groups[0] as Insert[]);
      for (const g of groups.slice(1)) {
        if (Array.isArray(g)) { if (g.length) buf = await this.engine.processThrough(buf, g); continue; }
        this.onStatus(`Rendering “${t.name}” through ${g.native!.name}…`);
        const input = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
        const res = await renderNative(g.native!, input, buf.length, buf.sampleRate, []);
        if (res.state) g.native!.state = res.state;
        const out = this.engine.ctx.createBuffer(Math.max(1, res.out.length), buf.length, buf.sampleRate);
        res.out.forEach((ch, c) => out.copyToChannel(ch.subarray(0, buf.length) as Float32Array<ArrayBuffer>, c));
        buf = out;
      }
      const id = `frz_${t.id}`;
      this.store.buffers.set(id, buf);
      t.freeze = { bufferId: id, sig };
    } catch (e) {
      this.onError(`Couldn't render “${t.name}” through its native plug-ins: ${(e as Error)?.message ?? e}`);
    } finally {
      this.busy.delete(t.id);
      this.onStatus(null);
      this.store.emit('view');
      if (this.engine.playing) this.engine.resync();
    }
  }
}
