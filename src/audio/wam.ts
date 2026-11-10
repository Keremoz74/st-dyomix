// Web Audio Modules 2.0 host: the open "VST for the web" plug-in standard.
// Plug-ins are ES modules loaded from a URL (the WAM community catalog or any URL the person adds).
// Effects sit in insert slots like built-in plug-ins; instruments play MIDI from regions, Musical Typing and MIDI input.
import type { PluginInstance } from './plugins';
import type { Voice } from './instruments';

export interface WamRef {
  url: string;          // the plug-in's index.js
  name: string;
  vendor?: string;
  isInstrument?: boolean;
  state?: unknown;      // the plug-in's own saved state (getState/setState)
}

export interface CatalogEntry { name: string; vendor: string; url: string; description?: string; category: string; keywords: string[]; isInstrument: boolean; thumbnail?: string }

export const DEFAULT_SDK = 'https://www.webaudiomodules.com/sdk/2.0.0-alpha.6/src/initializeWamHost.js';
export const DEFAULT_CATALOG = 'https://www.webaudiomodules.com/community/plugins.json';
const COMMUNITY_BASE = 'https://www.webaudiomodules.com/community/plugins/';

const prefs = () => { try { return JSON.parse(localStorage.getItem('daw.wam') || '{}'); } catch { return {}; } };
export const wamSettings = {
  get sdk(): string { return prefs().sdk || DEFAULT_SDK; },
  get catalogs(): string[] { const c = prefs().catalogs; return Array.isArray(c) && c.length ? c : [DEFAULT_CATALOG]; },
  get custom(): WamRef[] { return prefs().custom ?? []; },
  save(patch: Record<string, unknown>) { try { localStorage.setItem('daw.wam', JSON.stringify({ ...prefs(), ...patch })); } catch { /* storage off */ } },
};

// ---------- host environment ----------
const groups = new WeakMap<BaseAudioContext, Promise<string>>();
const modules = new Map<string, Promise<any>>();
const dynImport = (u: string) => import(/* @vite-ignore */ u);

function hostGroup(ctx: BaseAudioContext): Promise<string> {
  let g = groups.get(ctx);
  if (!g) {
    g = (async () => {
      const mod = await dynImport(wamSettings.sdk);
      const init = mod.default ?? mod.initializeWamHost;
      const [id] = await init(ctx);
      return id as string;
    })();
    groups.set(ctx, g);
    g.catch(() => groups.delete(ctx));
  }
  return g;
}

function loadModule(url: string): Promise<any> {
  let m = modules.get(url);
  if (!m) {
    m = dynImport(url).then(x => { const W = x.default; if (!W?.isWebAudioModuleConstructor && typeof W?.createInstance !== 'function') throw new Error('Not a Web Audio Module'); return W; });
    modules.set(url, m);
    m.catch(() => modules.delete(url));
  }
  return m;
}

/** Creates a WAM instance (live or offline context) and restores its state. */
export async function createWam(ctx: BaseAudioContext, ref: WamRef): Promise<any> {
  const [gid, W] = await Promise.all([hostGroup(ctx), loadModule(ref.url)]);
  const inst = await W.createInstance(gid, ctx);
  if (ref.state != null) { try { await inst.audioNode.setState(ref.state); } catch (e) { console.warn('WAM setState failed', e); } }
  return inst;
}

/** Reads a plug-in's descriptor (name, vendor, isInstrument) by loading it once. */
export async function describeWam(ctx: BaseAudioContext, url: string): Promise<WamRef> {
  const W = await loadModule(url);
  let d = W.descriptor;
  if (!d) { try { const inst = await createWam(ctx, { url, name: '' }); d = inst.descriptor; inst.audioNode.destroy?.(); } catch { /* keep minimal */ } }
  return { url, name: d?.name || url.split('/').slice(-2, -1)[0] || 'Plug-in', vendor: d?.vendor, isInstrument: !!d?.isInstrument };
}

// ---------- catalog ----------
const resolveUrl = (base: string, p: string) => {
  if (/^https?:/.test(p)) return p.endsWith('/') ? p + 'index.js' : p;
  const u = new URL(p, base).href;
  return u.endsWith('/') ? u + 'index.js' : u.endsWith('.js') ? u : u + '/index.js';
};
/** Downloads the plug-in catalogs (WAM community index by default) and normalizes the entries. */
export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const out: CatalogEntry[] = [];
  for (const src of wamSettings.catalogs) {
    const res = await fetch(src, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    const json = await res.json();
    const list: any[] = Array.isArray(json) ? json : json.plugins ?? Object.values(json);
    const base = src === DEFAULT_CATALOG ? COMMUNITY_BASE : new URL('.', src).href;
    for (const e of list) {
      const p = e.url ?? e.path ?? e.module ?? e.src;
      if (!p || typeof p !== 'string') continue;
      const cat = Array.isArray(e.category) ? e.category[0] : e.category;
      const kw: string[] = Array.isArray(e.keywords) ? e.keywords : [];
      out.push({
        name: e.name ?? e.identifier ?? p, vendor: e.vendor ?? '', url: resolveUrl(base, p), description: e.description,
        category: cat || (e.isInstrument ? 'Instrument' : 'Effect'), keywords: kw,
        isInstrument: !!(e.isInstrument ?? kw.some(k => /instrument|synth/i.test(k)) ?? /synth|instrument/i.test(cat ?? '')),
        thumbnail: e.thumbnail ? resolveUrl(base, e.thumbnail).replace(/\/index\.js$/, '') : undefined,
      });
    }
  }
  return out;
}

// ---------- insert (effect) ----------
/** A WAM effect in an insert slot. Audio passes through until the plug-in has loaded. */
export function wamEffect(ctx: BaseAudioContext, ref: WamRef, onError: (e: unknown) => void): PluginInstance & { wam: Promise<any> } {
  const input = ctx.createGain(), output = ctx.createGain();
  input.connect(output);
  let node: AudioNode | null = null, dead = false;
  const wam = createWam(ctx, ref).then(inst => {
    if (dead) { inst.audioNode.destroy?.(); return inst; }
    node = inst.audioNode as AudioNode;
    input.disconnect(); input.connect(node!); node!.connect(output);
    return inst;
  });
  wam.catch(e => { if (!dead) onError(e); });
  return {
    input, output, wam,
    set() { /* parameters live inside the plug-in */ },
    dispose() { dead = true; try { input.disconnect(); node?.disconnect(); output.disconnect(); } catch { /* */ } wam.then(i => i.audioNode.destroy?.()).catch(() => {}); },
  };
}

// ---------- instrument ----------
/** WAM instruments by the node their audio goes into (the channel input), per context. */
const instrumentAt = new WeakMap<AudioNode, { node: any; ready: Promise<any> }>();

/** Creates (or reuses) a WAM instrument feeding `dest`. */
export function attachInstrument(ctx: BaseAudioContext, dest: AudioNode, ref: WamRef, onError: (e: unknown) => void) {
  const cur = instrumentAt.get(dest);
  if (cur) return cur.ready;
  const holder: { node: any; ready: Promise<any> } = { node: null, ready: null as any };
  holder.ready = createWam(ctx, ref).then(inst => { holder.node = inst.audioNode; inst.audioNode.connect(dest); return inst; });
  holder.ready.catch(e => { instrumentAt.delete(dest); onError(e); });
  instrumentAt.set(dest, holder);
  return holder.ready;
}
export function detachInstrument(dest: AudioNode) {
  const cur = instrumentAt.get(dest); if (!cur) return;
  instrumentAt.delete(dest);
  cur.ready.then(i => { try { i.audioNode.disconnect(); i.audioNode.destroy?.(); } catch { /* */ } }).catch(() => {});
}
export const instrumentInstance = (dest: AudioNode) => instrumentAt.get(dest)?.ready;

const midi = (node: any, time: number, bytes: number[]) => { try { node.scheduleEvents({ type: 'wam-midi', time, data: { bytes } }); } catch { /* not ready */ } };

/** InstDef-compatible note player: sends MIDI note on/off to the WAM instrument at `dest`. */
export function playWamNote(ctx: BaseAudioContext, dest: AudioNode, pitch: number, vel: number, when: number, dur?: number): Voice {
  const holder = instrumentAt.get(dest);
  const env = ctx.createGain();
  const send = (fn: (node: any) => void) => { if (holder?.node) fn(holder.node); else holder?.ready.then(i => fn(i.audioNode)).catch(() => {}); };
  send(n => midi(n, when, [0x90, pitch, Math.max(1, Math.min(127, Math.round(vel)))]));
  if (dur != null) send(n => midi(n, when + dur, [0x80, pitch, 0]));
  return {
    src: [], env,
    release(at: number) { send(n => midi(n, Math.max(at, ctx.currentTime), [0x80, pitch, 0])); },
    kill() { send(n => { try { n.clearEvents?.(); } catch { /* */ } midi(n, ctx.currentTime, [0x80, pitch, 0]); midi(n, ctx.currentTime, [0xb0, 123, 0]); }); },
  } as Voice;
}

/** Tells WAMs about tempo / play state (for synced LFOs, delays, arpeggiators). */
export function sendTransport(node: any, ctx: BaseAudioContext, tempo: number, num: number, den: number, playing: boolean, bar: number) {
  try {
    node.scheduleEvents({ type: 'wam-transport', time: ctx.currentTime, data: { currentBar: bar, currentBarStarted: ctx.currentTime, tempo, timeSigNumerator: num, timeSigDenominator: den, playing } });
  } catch { /* plug-in ignores transport */ }
}
