// Track Groups + VCA (Pro Tools style): members share volume/mute/solo/selection edits, and the group's
// VCA level is added to every member's fader (the members' own faders keep their balance).
import { Store, Track, TrackGroup, uid, COLOR_CHOICES } from './model';

export const groupOf = (store: Store, t?: Track | null): TrackGroup | undefined => t?.group ? store.project.groups?.find(g => g.id === t.group) : undefined;
export const vcaOffset = (store: Store, t: Track) => groupOf(store, t)?.vca ?? 0;
export const vcaMuted = (store: Store, t: Track) => !!groupOf(store, t)?.vcaMute;
export const members = (store: Store, g: TrackGroup) => store.project.tracks.filter(t => t.group === g.id);

/** Tracks an edit on `t` should also apply to (itself included), for the given link. */
export function linked(store: Store, t: Track, link: 'linkVol' | 'linkMute' | 'linkSolo' | 'linkSel'): Track[] {
  const g = groupOf(store, t);
  return g && g[link] ? members(store, g) : [t];
}

export function createGroup(store: Store, trackIds: string[], name?: string): TrackGroup {
  const groups = (store.project.groups ??= []);
  const g: TrackGroup = { id: uid('g'), name: name ?? `Group ${groups.length + 1}`, color: COLOR_CHOICES[(groups.length + 2) % COLOR_CHOICES.length][1], vca: 0, linkVol: true, linkMute: true, linkSolo: true, linkSel: true };
  groups.push(g);
  for (const id of trackIds) { const t = store.track(id); if (t && t.kind !== 'aux') t.group = g.id; }
  return g;
}

export function deleteGroup(store: Store, id: string) {
  store.project.groups = (store.project.groups ?? []).filter(g => g.id !== id);
  for (const t of store.project.tracks) if (t.group === id) delete t.group;
}
