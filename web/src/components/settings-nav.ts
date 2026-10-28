import type { NavItem } from './api';

/** The settings list as the sidebar shows it: "You" (personal) then "Workspace" (admin, only when the user has any of it). `nav` is already filtered by permission and ordered. */
export function settingsGroups(nav: NavItem[]): { label: string; items: NavItem[] }[] {
  const links = nav.filter((n) => n.place === 'settings');
  const work = links.filter((n) => n.group === 'workspace');
  // A page can have a personal and a workspace entry (Usage, Agents & keys); whoever holds the workspace one sees only that.
  const you = links.filter((n) => n.group !== 'workspace' && !work.some((w) => w.href === n.href));
  return [{ label: 'You', items: you }, { label: 'Workspace', items: work }].filter((g) => g.items.length);
}
