// The Audio FX / Instrument menus: Logic-style categories, favorites and Web Audio Modules.
import { Commands } from '../commands';
import { PLUGIN_LIST, CATEGORIES, PluginType } from '../audio/plugins';
import type { WamRef } from '../audio/wam';
import { NativeRef, NativePluginInfo, inDesktopApp, scanNative } from '../audio/native';
import { pluginPrefs } from '../plugin-prefs';
import { GM, GM_CATEGORIES, GM_DRUMS } from '../audio/gm';
import { MenuItem } from './dom';

export type FxPick = (type: PluginType, wam?: WamRef, native?: NativeRef) => void;

/** Native plug-ins found on this computer (desktop app), filled at startup. */
let natives: NativePluginInfo[] = [];
export const refreshNativeList = (rescan = false) => scanNative(rescan).then((l: NativePluginInfo[]) => { natives = l; return l; });
if (inDesktopApp()) refreshNativeList();

/** Menu of every Audio FX: favorites first, then categories (submenus), then Web Audio Modules. */
export function fxMenu(cmd: Commands, pick: FxPick, current?: { type: PluginType; url?: string }): MenuItem[] {
  const shown = PLUGIN_LIST.filter(p => !pluginPrefs.isHidden(p.type));
  const wams = pluginPrefs.wams.filter(w => !w.isInstrument);
  const isCur = (t: PluginType, url?: string) => !!current && current.type === t && current.url === url;
  const favs: MenuItem[] = pluginPrefs.favorites.flatMap(f => {
    const d = shown.find(p => p.type === f); if (d) return [[`★ ${d.name}`, '', () => pick(d.type), isCur(d.type)] as MenuItem];
    const w = wams.find(x => x.url === f); if (w) return [[`★ ${w.name}`, w.vendor ?? '', () => pick('wam', w), isCur('wam', w.url)] as MenuItem];
    return [];
  });
  const cats: MenuItem[] = CATEGORIES.map(c => ({ c, list: shown.filter(p => (p.category ?? 'Utility') === c) })).filter(x => x.list.length)
    .map(({ c, list }) => ({ label: c, sub: list.map(p => [p.name, '', () => pick(p.type), isCur(p.type)] as MenuItem) }));
  const wamSub: MenuItem[] = [
    ...(wams.length ? [{ header: 'My Plug-ins' } as MenuItem, ...wams.map(w => [w.name, w.vendor ?? '', () => pick('wam', w), isCur('wam', w.url)] as MenuItem), '-' as MenuItem] : []),
    ['Browse Plug-ins…', '', () => cmd.openPluginBrowser('fx')],
    ['Add Plug-in from URL…', '', () => cmd.addWamFromUrl()],
  ];
  const fxNatives = natives.filter(n => !n.is_instrument);
  const byVendor = [...new Set(fxNatives.map(n => n.vendor || 'Other'))].sort();
  const nativeSub: MenuItem[] = fxNatives.length
    ? byVendor.map(v => ({ label: v, sub: fxNatives.filter(n => (n.vendor || 'Other') === v).map(n => [n.name, n.format, () => pick('native', undefined, { path: n.path, name: n.name, vendor: n.vendor, format: n.format }), current?.type === 'native' && current.url === n.path] as MenuItem) }))
    : [['No VST3/AU plug-ins found', '', () => cmd.openSettings('wam')]];
  return [...(favs.length ? [{ header: 'Favorites' } as MenuItem, ...favs, '-' as MenuItem] : []), ...cats, '-', { label: 'Web Audio Modules', sub: wamSub },
    ...(inDesktopApp() ? [{ label: 'VST3 / Audio Units', sub: nativeSub } as MenuItem] : [])];
}

/** Sound Library: the 128 General MIDI instruments by family (8 each) and the drum kit. */
export function gmLibraryMenu(pick: (prog: number) => void, current?: number): MenuItem[] {
  return [
    ...GM_CATEGORIES.map((c, ci) => ({ label: c, checked: current != null && current < 128 && Math.floor(current / 8) === ci, sub: GM.slice(ci * 8, ci * 8 + 8).map((g, i) => [g[1], '', () => pick(ci * 8 + i), current === ci * 8 + i] as MenuItem) }) as MenuItem),
    '-',
    [GM[GM_DRUMS][1], '', () => pick(GM_DRUMS), current === GM_DRUMS],
  ];
}

/** Menu for choosing a channel's instrument. */
export function instrumentMenu(cmd: Commands, trackId: string): MenuItem[] {
  const t = cmd.store.track(trackId), cur = t?.instrument;
  const wams = pluginPrefs.wams.filter(w => w.isInstrument);
  return [
    { header: 'Sound Library (real instruments)' },
    ...gmLibraryMenu(p => cmd.setGmProgram(trackId, p), cur?.type === 'gm' ? Math.round(cur.params.program) : undefined),
    '-',
    { header: 'Synthesizers' },
    ['Studio Synth', '', () => cmd.setInstrumentType(trackId, 'synth'), cur?.type === 'synth'],
    ['Electronic Drum Kit', '', () => cmd.setInstrumentType(trackId, 'drums'), cur?.type === 'drums'],
    ['Electric Piano', '', () => cmd.setInstrumentType(trackId, 'epiano'), cur?.type === 'epiano'],
    ['Drawbar Organ', '', () => cmd.setInstrumentType(trackId, 'organ'), cur?.type === 'organ'],
    ['Sampler', '', () => cmd.setInstrumentType(trackId, 'sampler'), cur?.type === 'sampler'],
    '-',
    { label: 'Web Audio Modules', sub: [
      ...(wams.length ? [{ header: 'My Instruments' } as MenuItem, ...wams.map(w => [w.name, w.vendor ?? '', () => cmd.setInstrumentType(trackId, 'wam', w), cur?.type === 'wam' && cur.wam?.url === w.url] as MenuItem), '-' as MenuItem] : []),
      ['Browse Instruments…', '', () => cmd.openPluginBrowser('inst', trackId)],
      ['Add Instrument from URL…', '', () => cmd.addWamFromUrl(trackId)],
    ] },
  ];
}
