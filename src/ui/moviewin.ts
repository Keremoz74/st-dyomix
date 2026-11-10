// Floating Movie window (Logic: Window › Show Movie). Drag the title bar to move it, the corner to resize it.
import { Commands } from '../commands';
import { FPS_OPTIONS, smpte } from '../movie';
import { h, icon, openMenu, MenuItem } from './dom';

export class MovieWindow {
  el: HTMLElement;
  private tc: HTMLElement;
  private title: HTMLElement;
  private audioBtn: HTMLButtonElement;
  private stage: HTMLElement;
  private lastTc = '';

  constructor(private cmd: Commands) {
    const v = cmd.movie.video;
    v.className = 'mw-video';
    this.tc = h('span', { class: 'mw-tc', title: 'Project timecode (SMPTE)' });
    this.title = h('span', { class: 'mw-title' });
    this.audioBtn = h('button', { class: 'mw-btn', title: 'Play the movie’s own sound', 'aria-label': 'Movie sound', onClick: () => cmd.toggleMovieAudio() });
    const menu: HTMLButtonElement = h('button', { class: 'mw-btn', 'aria-label': 'Movie options', title: 'Movie options', 'aria-haspopup': 'menu', onClick: () => openMenu(menu, this.menu()) }, '⋯');
    this.stage = h('div', { class: 'mw-stage' }, v, h('div', { class: 'mw-off' }, 'Outside the movie'));
    const bar = h('div', { class: 'mw-bar' }, icon('film', 14), this.title, h('span', { class: 'grow' }), this.tc, this.audioBtn, menu,
      h('button', { class: 'mw-btn', 'aria-label': 'Close movie window', title: 'Close', onClick: () => { cmd.store.ui.showMovie = false; cmd.store.emit('view'); } }, '×'));
    this.el = h('div', { class: 'movie-win', role: 'dialog', 'aria-label': 'Movie', hidden: true }, bar, this.stage);

    // move by dragging the title bar
    bar.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('button')) return;
      const r = this.el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      const mv = (ev: PointerEvent) => {
        const x = Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)), y = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy));
        Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
      };
      const up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); };
      bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up);
    });
    cmd.store.on(k => { if (k === 'view' || k === 'structure' || k === 'mix') this.sync(); });
  }

  private menu(): MenuItem[] {
    const c = this.cmd, m = c.store.project.movie!;
    return [
      ['Open Movie…', '⌥⌘O', c.openMovie],
      ['Import Audio from Movie', '', c.importMovieAudio],
      ['Movie Start at Playhead', '', c.movieStartAtPlayhead],
      ['Movie Start at 0', '', () => c.setMovieStart(0)], '-',
      ...FPS_OPTIONS.map(([f, n]) => [`${n} fps`, '', () => c.setMovieFps(f), Math.abs(m.fps - f) < 0.01] as MenuItem), '-',
      ['Sound Volume 100%', '', () => c.setMovieVolume(1), m.volume === 1], ['Sound Volume 50%', '', () => c.setMovieVolume(0.5), m.volume === 0.5], '-',
      ['Remove Movie', '', c.removeMovie],
    ];
  }

  private sync() {
    const m = this.cmd.movie.info;
    this.el.hidden = !(m && this.cmd.store.ui.showMovie);
    if (!m) return;
    this.title.textContent = m.name;
    this.title.title = `${m.name} · ${m.w}×${m.h} · ${m.fps} fps · starts at ${smpte(m.start, m.fps)}`;
    this.audioBtn.replaceChildren(m.audio ? '🔊' : '🔇');
    this.audioBtn.setAttribute('aria-pressed', String(m.audio));
    if (m.w && m.h) this.stage.style.aspectRatio = `${m.w} / ${m.h}`;
  }

  frame(beat: number) {
    const m = this.cmd.movie.info;
    this.cmd.movie.frame(beat);
    if (!m || this.el.hidden) return;
    const tc = smpte(this.cmd.store.secAt(beat), m.fps);
    if (tc !== this.lastTc) { this.lastTc = tc; this.tc.textContent = tc; }
    this.stage.classList.toggle('outside', !this.cmd.movie.inside);
  }
}
