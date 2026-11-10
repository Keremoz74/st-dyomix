// Native VST3 / Audio Unit plug-ins (desktop app only, Tauri side in src-tauri/src/native.rs).
// The web view can't run native code in real time, so tracks with native plug-ins are rendered
// through them offline and played back as a freeze file (like Logic's Freeze), re-rendered after edits.

export interface NativeRef {
  path: string;          // the .vst3 / .component bundle
  name: string;
  vendor?: string;
  format?: 'VST3' | 'AU';
  isInstrument?: boolean;
  state?: string;        // base64 plug-in state
  params?: Record<string, number>; // parameter id -> normalized value 0..1
}
export interface NativePluginInfo { name: string; vendor: string; path: string; format: 'VST3' | 'AU'; is_instrument: boolean; category: string }
export interface NativeParam { id: number; name: string; value: number; display: string }

const T = () => (window as any).__TAURI__;
const invoke = (cmd: string, args?: any, opts?: any) => T().core.invoke(cmd, args, opts);
export const inDesktopApp = () => !!T()?.core?.invoke && !/Android|iPhone|iPad/i.test(navigator.userAgent);

let scanCache: Promise<NativePluginInfo[]> | null = null;
let hostCache: Promise<boolean> | null = null;
/** Whether this build can run native plug-ins (the scan works in every desktop build). */
export const hostingAvailable = (): Promise<boolean> => (hostCache ??= inDesktopApp() ? invoke('native_hosting_available').then(Boolean).catch(() => false) : Promise.resolve(false));
export const scanNative = (rescan = false) => {
  if (rescan) scanCache = null;
  return (scanCache ??= inDesktopApp() ? invoke('native_scan').catch(() => []) : Promise.resolve([]));
};
export const nativeParams = (ref: NativeRef): Promise<NativeParam[]> => invoke('native_params', { path: ref.path, state: ref.state ?? null });

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

/**
 * Renders audio through a native plug-in. `input` = planar channels (empty for instruments),
 * `midi` = events by frame. Returns the output channels and the plug-in's state afterwards.
 */
export async function renderNative(ref: NativeRef, input: Float32Array[], frames: number, sampleRate: number, midi: { frame: number; status: number; d1: number; d2: number }[]): Promise<{ out: Float32Array[]; state: string | null }> {
  const meta = { path: ref.path, sample_rate: sampleRate, channels: input.length, frames, block: 512, params: Object.entries(ref.params ?? {}).map(([k, v]) => [Number(k), v]), state: ref.state ?? null, midi };
  const body = new Uint8Array(input.length * frames * 4);
  input.forEach((ch, c) => body.set(new Uint8Array(ch.buffer, ch.byteOffset, frames * 4), c * frames * 4));
  const res: ArrayBuffer = await invoke('native_render', body, { headers: { 'x-meta': b64(JSON.stringify(meta)) } });
  // response: u32 state length, state bytes, u32 channel count, then planar f32 channels
  const dv = new DataView(res);
  const sl = dv.getUint32(0, true);
  const stateBytes = new Uint8Array(res, 4, sl);
  let o = 4 + sl;
  const ch = dv.getUint32(o, true); o += 4;
  const n = (res.byteLength - o) / 4 / Math.max(1, ch);
  const out: Float32Array[] = [];
  for (let c = 0; c < ch; c++) { out.push(new Float32Array(res.slice(o, o + n * 4))); o += n * 4; }
  let state: string | null = null;
  if (sl) { let s = ''; for (let i = 0; i < stateBytes.length; i++) s += String.fromCharCode(stateBytes[i]); state = btoa(s); }
  return { out, state };
}
