// Plug-in Browser: the Web Audio Module catalog (internet), the person's own plug-ins, and "add by URL".
import { Commands } from '../commands';
import { fetchCatalog, describeWam, CatalogEntry, WamRef } from '../audio/wam';
import { pluginPrefs } from '../plugin-prefs';
import { h, toast } from './dom';

type Tab = 'fx' | 'inst' | 'mine';

export class PluginBrowser {
  private el: HTMLElement | null = null;
  private tab: Tab = 'fx';
  private trackId?: string;
  private query = '';
  private catalog: CatalogEntry[] | null = null;
  private error = '';
  private loading = false;
  private list!: HTMLElement;

  constructor(private cmd: Commands) {}

  open(mode: 'fx' | 'inst', trackId?: string) {
    this.tab = mode; this.trackId = trackId;
    this.render();
    if (!this.catalog && !this.loading) this.load();
  }
  close() { this.el?.remove(); this.el = null; }

  private async load() {
    this.loading = true; this.error = ''; this.fill();
    try { this.catalog = await fetchCatalog(); }
    catch (e) { this.error = `Couldn't load the plug-in catalog (${(e as Error)?.message ?? e}). An internet connection is needed; you can still add a plug-in by its URL.`; }
    this.loading = false; this.fill();
  }

  private target() {
    const st = this.cmd.store;
    return this.trackId ?? st.ui.selectedTrackId ?? undefined;
  }

  private use(ref: WamRef) {
    pluginPrefs.addWam(ref);
    const st = this.cmd.store;
    if (ref.isInstrument) {
      const t = st.track(this.target() ?? '');
      if (t?.kind === 'inst') this.cmd.setInstrumentType(t.id, 'wam', ref);
      else this.cmd.newWamInstrumentTrack(ref);
    } else {
      const t = st.track(this.target() ?? '');
      const owner = t && t.kind !== 'folder' ? t.id : 'master';
      this.cmd.addPlugin(owner, 'wam', ref);
      toast(`${ref.name} inserted on ${owner === 'master' ? 'Stereo Out' : t!.name}`);
    }
    this.close();
  }

  private async addUrl(url: string, btn: HTMLButtonElement) {
    url = url.trim(); if (!url) return;
    if (!/^https?:\/\//.test(url)) { toast('Enter the full https:// address of the plug-in (its index.js or folder)'); return; }
    if (url.endsWith('/')) url += 'index.js';
    btn.disabled = true; btn.textContent = 'Loading…';
    try { const ref = await describeWam(this.cmd.engine.ctx, url); this.use(ref); }
    catch (e) { toast(`Couldn't load that plug-in: ${(e as Error)?.message ?? e}`); btn.disabled = false; btn.textContent = 'Add'; }
  }

  private render() {
    const tabBtn = (t: Tab, label: string) => h('button', { class: 'pb-tab' + (this.tab === t ? ' on' : ''), role: 'tab', 'aria-selected': String(this.tab === t), onClick: () => { this.tab = t; this.render(); } }, label);
    const search = h('input', { class: 'pb-search', type: 'search', placeholder: 'Search plug-ins', value: this.query, 'aria-label': 'Search plug-ins' }) as HTMLInputElement;
    search.addEventListener('input', () => { this.query = search.value; this.fill(); });
    search.addEventListener('keydown', e => e.stopPropagation());
    const url = h('input', { class: 'pb-url', type: 'url', placeholder: 'https://…/my-plugin/index.js', 'aria-label': 'Plug-in URL' }) as HTMLInputElement;
    const addBtn: HTMLButtonElement = h('button', { class: 'tool-btn', onClick: () => this.addUrl(url.value, addBtn) }, 'Add');
    url.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') this.addUrl(url.value, addBtn); });
    this.list = h('div', { class: 'pb-list', role: 'list' });
    const t = this.cmd.store.track(this.target() ?? '');
    const dest = this.tab === 'inst' ? (t?.kind === 'inst' ? `Instrument slot of “${t.name}”` : 'a new instrument track') : (t && t.kind !== 'folder' ? `“${t.name}”` : 'Stereo Out');
    const win = h('div', { class: 'pb-win', role: 'dialog', 'aria-label': 'Plug-in Browser' },
      h('div', { class: 'pb-head' },
        h('span', { class: 'pb-title' }, 'Plug-in Browser'),
        h('div', { class: 'pb-tabs', role: 'tablist' }, tabBtn('fx', 'Effects'), tabBtn('inst', 'Instruments'), tabBtn('mine', 'My Plug-ins')),
        h('span', { class: 'grow' }), search,
        h('button', { class: 'tool-btn', title: 'Reload the catalog', onClick: () => this.load() }, 'Reload'),
        h('button', { class: 'tool-btn', 'aria-label': 'Close', onClick: () => this.close() }, '×')),
      h('div', { class: 'pb-sub' }, h('span', {}, `Web Audio Modules (WAM 2.0) — the open plug-in format for the web. Goes to ${dest}.`),
        h('span', { class: 'grow' }), h('label', { class: 'pb-urlrow' }, 'Add by URL', url, addBtn)),
      this.list);
    const overlay = h('div', { class: 'pb-overlay', onClick: (e: MouseEvent) => { if (e.target === overlay) this.close(); } }, win);
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); e.stopPropagation(); });
    if (this.el) this.el.replaceWith(overlay); else document.body.appendChild(overlay);
    this.el = overlay;
    this.fill();
    if (innerWidth > 760) search.focus();
  }

  private fill() {
    if (!this.el) return;
    const q = this.query.toLowerCase();
    const match = (e: { name: string; vendor?: string; description?: string; category?: string; keywords?: string[] }) => !q || [e.name, e.vendor, e.description, e.category, ...(e.keywords ?? [])].some(x => x?.toLowerCase().includes(q));
    if (this.tab === 'mine') {
      const mine = pluginPrefs.wams.filter(match);
      this.list.replaceChildren(...(mine.length ? mine.map(w => this.card({ name: w.name, vendor: w.vendor ?? '', url: w.url, category: w.isInstrument ? 'Instrument' : 'Effect', keywords: [], isInstrument: !!w.isInstrument }, true))
        : [h('p', { class: 'pb-empty' }, 'Plug-ins you use from the catalog or add by URL appear here.')]));
      return;
    }
    if (this.loading) { this.list.replaceChildren(h('p', { class: 'pb-empty' }, 'Loading the plug-in catalog…')); return; }
    if (this.error) { this.list.replaceChildren(h('p', { class: 'pb-empty pb-err' }, this.error)); return; }
    const items = (this.catalog ?? []).filter(e => (this.tab === 'inst') === e.isInstrument).filter(match);
    const cats = [...new Set(items.map(e => e.category))].sort();
    this.list.replaceChildren(...(items.length ? cats.flatMap(c => [h('div', { class: 'pb-cat' }, c), ...items.filter(e => e.category === c).map(e => this.card(e, false))])
      : [h('p', { class: 'pb-empty' }, q ? 'No plug-ins match the search.' : 'No plug-ins in this list.')]));
  }

  private card(e: CatalogEntry, mine: boolean) {
    const ref: WamRef = { url: e.url, name: e.name, vendor: e.vendor, isInstrument: e.isInstrument };
    const fav = pluginPrefs.isFavorite(e.url);
    return h('div', { class: 'pb-card', role: 'listitem' },
      e.thumbnail ? h('img', { class: 'pb-thumb', src: e.thumbnail, alt: '', loading: 'lazy', onError: (ev: Event) => (ev.target as HTMLElement).remove() }) : h('div', { class: 'pb-thumb pb-noimg' }, e.isInstrument ? '🎹' : '🎛'),
      h('div', { class: 'pb-info' },
        h('div', { class: 'pb-name' }, e.name), h('div', { class: 'pb-vendor' }, [e.vendor, e.category].filter(Boolean).join(' · ')),
        e.description ? h('div', { class: 'pb-desc' }, e.description) : null),
      h('div', { class: 'pb-actions' },
        h('button', { class: 'tool-btn pb-use', onClick: () => this.use(ref) }, e.isInstrument ? 'Use Instrument' : 'Insert'),
        h('button', { class: 'pb-fav' + (fav ? ' on' : ''), 'aria-pressed': String(fav), title: fav ? 'Remove from favorites' : 'Add to favorites', 'aria-label': 'Favorite', onClick: () => { pluginPrefs.addWam(ref); pluginPrefs.toggleFavorite(e.url); this.fill(); } }, fav ? '★' : '☆'),
        mine ? h('button', { class: 'pb-fav', title: 'Remove from My Plug-ins', 'aria-label': 'Remove', onClick: () => { pluginPrefs.removeWam(e.url); this.fill(); } }, '🗑') : null));
  }
}
