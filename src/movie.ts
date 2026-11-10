// Movie (video) synced to the timeline, like Logic's Movie window + Movie track.
// The video element follows the playhead: it plays along while the transport runs (re-syncing when it drifts)
// and seeks to the playhead's frame while stopped or scrubbing. Thumbnails feed the Movie lane in the ruler.
import type { Store, MovieInfo } from './model';

export const FPS_OPTIONS: [number, string][] = [[23.976, '23.976'], [24, '24'], [25, '25'], [29.97, '29.97'], [30, '30']];
export const THUMB_H = 30;

export interface MovieMeta { duration: number; w: number; h: number }

/** Reads a movie file's duration and frame size. Rejects if the browser can't play it. */
export function probeMovie(blob: Blob): Promise<MovieMeta> {
  return new Promise((res, rej) => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    const done = (ok: boolean) => { const m = { duration: v.duration, w: v.videoWidth, h: v.videoHeight }; URL.revokeObjectURL(url); v.removeAttribute('src'); ok && isFinite(m.duration) && m.duration > 0 ? res(m) : rej(new Error('unplayable')); };
    v.onloadedmetadata = () => {
      // some files (e.g. MediaRecorder WebM) report Infinity until you seek to the end
      if (isFinite(v.duration)) done(true);
      else { v.ontimeupdate = () => { v.ontimeupdate = null; done(isFinite(v.duration)); }; v.currentTime = 1e9; }
    };
    v.onerror = () => done(false);
    setTimeout(() => done(false), 15000);
    v.src = url;
  });
}

/** SMPTE timecode (hh:mm:ss:ff) for a time in seconds. */
export function smpte(sec: number, fps: number) {
  const neg = sec < 0; sec = Math.abs(sec);
  const f = Math.floor(sec * fps + 1e-6), fr = Math.round(fps);
  const ff = f % fr, s = Math.floor(f / fr), p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

export class MovieController {
  /** The element shown in the Movie window. */
  video: HTMLVideoElement;
  thumbs: (HTMLCanvasElement | null)[] = [];
  onThumbs: () => void = () => {};
  /** True while the playhead is inside the movie (outside it the window shows black). */
  inside = false;
  private blob: Blob | null = null;
  private url = '';
  private gen = 0;

  constructor(private store: Store) {
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true; this.video.preload = 'auto';
    this.video.setAttribute('playsinline', '');
    store.on(k => { if (k === 'structure' || k === 'mix' || k === 'view') this.check(); });
  }

  get info(): MovieInfo | undefined { const m = this.store.project.movie; return m && this.store.movieBlob && m.id === this.store.movieId ? m : undefined; }

  /** Attaches/detaches the file when the project's movie changes (open, remove, undo, project load). */
  check() {
    const m = this.info, b = m ? this.store.movieBlob : null;
    if (b !== this.blob) this.attach(b);
    if (m) { this.video.muted = !m.audio; this.video.volume = Math.max(0, Math.min(1, m.volume)); }
  }

  private attach(b: Blob | null) {
    this.gen++;
    if (this.url) URL.revokeObjectURL(this.url);
    this.blob = b; this.thumbs = []; this.url = '';
    this.video.pause();
    if (!b) { this.video.removeAttribute('src'); this.video.load(); this.onThumbs(); return; }
    this.url = URL.createObjectURL(b);
    this.video.src = this.url;
    this.makeThumbs(this.url, this.gen);
  }

  /** Grabs evenly spaced frames (about one every 2 s, at most 80) for the Movie lane. */
  private async makeThumbs(url: string, gen: number) {
    const m = this.info; if (!m) return;
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = url;
    await new Promise<void>(r => { v.onloadeddata = () => r(); v.onerror = () => r(); setTimeout(r, 8000); });
    const n = Math.max(1, Math.min(80, Math.ceil(m.duration / 2)));
    this.thumbs = new Array(n).fill(null);
    const aspect = m.w && m.h ? m.w / m.h : 16 / 9;
    for (let i = 0; i < n; i++) {
      if (gen !== this.gen) return;
      const t = Math.min(m.duration - 0.05, (i + 0.5) * m.duration / n);
      await new Promise<void>(r => { const to = setTimeout(r, 3000); v.onseeked = () => { clearTimeout(to); r(); }; v.currentTime = Math.max(0, t); });
      const c = document.createElement('canvas'); c.height = THUMB_H * 2; c.width = Math.round(THUMB_H * 2 * aspect);
      try { c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height); } catch { /* frame not ready */ }
      this.thumbs[i] = c;
      if (i % 6 === 5 || i === n - 1) this.onThumbs();
    }
    v.removeAttribute('src'); v.load();
  }

  /** The thumbnail nearest to a movie time (seconds). */
  thumbAt(t: number) {
    const m = this.info; if (!m || !this.thumbs.length) return null;
    const i = Math.max(0, Math.min(this.thumbs.length - 1, Math.floor((t / m.duration) * this.thumbs.length)));
    return this.thumbs[i];
  }

  /** Called every animation frame with the playhead position (beats). */
  frame(beat: number) {
    const m = this.info, v = this.video;
    if (!m || !v.src || v.readyState < 1) { this.inside = false; return; }
    const t = this.store.secAt(beat) - m.start;
    this.inside = t >= 0 && t < m.duration;
    if (this.store.ui.playing && this.inside) {
      if (v.paused) { v.currentTime = t; v.play().catch(() => { /* autoplay blocked: keep seeking instead */ }); }
      else if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
    } else {
      if (!v.paused) v.pause();
      const target = Math.max(0, Math.min(m.duration - 0.001, t));
      if (!v.seeking && Math.abs(v.currentTime - target) > 0.5 / m.fps) v.currentTime = target;
    }
  }
}
