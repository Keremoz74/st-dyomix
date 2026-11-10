// Platform glue for the packaged apps (Tauri 2 on macOS / Windows / Linux / Android / iPadOS).
// In a plain browser none of this is active and the app falls back to normal web behavior.

/** Tauri's global API (enabled with app.withGlobalTauri in tauri.conf.json). */
const T = () => (window as any).__TAURI__;

export const isTauri = () => !!T() || '__TAURI_INTERNALS__' in window;
export const isTouch = () => matchMedia('(pointer: coarse)').matches;

/**
 * Saves a file with the system's Save dialog (desktop) or document picker (Android / iPadOS).
 * Returns true when saved, false when the person cancelled, null when no native dialog is available here.
 */
export async function nativeSave(blob: Blob, filename: string): Promise<boolean | null> {
  const t = T();
  if (!t?.dialog?.save || !t?.fs?.writeFile) return null;
  const ext = filename.includes('.') ? filename.split('.').pop()! : '';
  const path: string | null = await t.dialog.save({ defaultPath: filename, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
  if (!path) return false;
  await t.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

/** Share sheet (iPadOS / Android): "Save to Files", AirDrop, Drive… Returns null if sharing files isn't supported. */
export async function shareFile(blob: Blob, filename: string): Promise<boolean | null> {
  const nav = navigator as any;
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (!nav.share || !nav.canShare?.({ files: [file] })) return null;
  try { await nav.share({ files: [file], title: filename }); return true; }
  catch (e: any) { return e?.name === 'AbortError' ? false : null; }
}

/** Keeps the screen awake while playing or recording (tablets dim the screen otherwise). */
let lock: any = null;
export async function keepAwake(on: boolean) {
  try {
    const wl = (navigator as any).wakeLock;
    if (on && wl && !lock) { lock = await wl.request('screen'); lock.addEventListener?.('release', () => { lock = null; }); }
    else if (!on && lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}
