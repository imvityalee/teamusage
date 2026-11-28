import { locale, type Lang } from "../lang.js";
import { matchMembers } from "../search.js";
import { pageOf, type Page, type PageSize } from "../site/paging.js";
import type { Sort, SortDir } from "../site/sort-head.js";
import { daysSince, isStale } from "../site/sync-age.js";
import type { ApiMember, Machine } from "./api.js";

/** What the team page decides about its members, with no page in it: last sync, search, filter, order, page and ticks. */

/** A member with the newest sync of their machines and whether they are not syncing. */
export type MemberRow = ApiMember & { lastSyncAt: string | null; days: number | null; stale: boolean };

const newestSync = (machines: Machine[]): string | null =>
  machines.reduce<string | null>((newest, { lastSyncAt }) => (lastSyncAt !== null && (newest === null || Date.parse(lastSyncAt) > Date.parse(newest)) ? lastSyncAt : newest), null);

/** Each member with the newest sync of their machines and whether they are not syncing; `today` is a local ISO date. */
export function toRows(members: ApiMember[], today: string): MemberRow[] {
  return members.map((member) => {
    const lastSyncAt = newestSync(member.machines);
    const days = daysSince(lastSyncAt, today);
    return { ...member, lastSyncAt, days, stale: isStale(days) };
  });
}

export type MemberListSort = Sort<"name" | "machines" | "lastSync" | "joined">;
export type MemberListView = { query: string; onlyStale: boolean; sort: MemberListSort; page: number; size: PageSize };

/** The way a column starts when it is pressed: names from A, the rest largest or newest first. */
export const FIRST_DIRECTION: Record<MemberListSort["by"], SortDir> = { name: "asc", machines: "desc", lastSync: "desc", joined: "desc" };

const time = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso));

function compareColumn(by: MemberListSort["by"], a: MemberRow, b: MemberRow, names: Intl.Collator): number {
  switch (by) {
    case "name":
      return names.compare(a.name, b.name);
    case "machines":
      return a.machines.length - b.machines.length;
    case "lastSync":
      return time(a.lastSyncAt) - time(b.lastSyncAt);
    case "joined":
      return time(a.joinedAt) - time(b.joinedAt);
  }
}

/** The rows in this order; names compare in the language's own order, a member who never synced is last either way, ties go by id. */
function sortRows(rows: MemberRow[], sort: MemberListSort, lang: Lang): MemberRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const names = new Intl.Collator(locale(lang));
  return [...rows].sort((a, b) => {
    const neverLast = sort.by === "lastSync" ? Number(a.lastSyncAt === null) - Number(b.lastSyncAt === null) : 0;
    return neverLast || sign * compareColumn(sort.by, a, b, names) || a.id - b.id;
  });
}

/**
 * The rows this view shows: `matching` is everyone the search and the filter leave, in order; `page` is the part drawn;
 * `staleCount` is the people not syncing in the whole team, whatever the search.
 */
export function visible(rows: MemberRow[], view: MemberListView, lang: Lang): { matching: MemberRow[]; page: Page<MemberRow>; staleCount: number } {
  const searched = matchMembers(rows, view.query);
  const matching = sortRows(view.onlyStale ? searched.filter((r) => r.stale) : searched, view.sort, lang);
  return { matching, page: pageOf(matching, view.page, view.size), staleCount: rows.filter((r) => r.stale).length };
}

/** At most this many members are ticked at a time: one removal names no more. */
export const MAX_TICKED = 500;
export type Ticked = ReadonlySet<number>;

/** Adds or removes `id`; adds nothing beyond MAX_TICKED. */
export function tick(ticked: Ticked, id: number): Ticked {
  const next = new Set(ticked);
  if (next.delete(id)) return next;
  if (ticked.size >= MAX_TICKED) return ticked;
  return next.add(id);
}

/** What was ticked, and every matching row after it in order, up to MAX_TICKED. */
export function tickAll(ticked: Ticked, matching: MemberRow[]): Ticked {
  const next = new Set(ticked);
  for (const { id } of matching) {
    if (next.size >= MAX_TICKED) break;
    next.add(id);
  }
  return next;
}

/** What was ticked, without the matching rows. */
export function untickAll(ticked: Ticked, matching: MemberRow[]): Ticked {
  const gone = new Set(matching.map((r) => r.id));
  return new Set([...ticked].filter((id) => !gone.has(id)));
}

/** After a reload: the ticks of people who are still there. */
export function keepExisting(ticked: Ticked, rows: MemberRow[]): Ticked {
  const there = new Set(rows.map((r) => r.id));
  return new Set([...ticked].filter((id) => there.has(id)));
}

/** The header's box: nothing ticked, everyone the search and filter leave (up to MAX_TICKED) ticked, or something in between. */
export function tickState(ticked: Ticked, matching: MemberRow[]): "none" | "some" | "all" {
  if (ticked.size === 0) return "none";
  const target = matching.slice(0, MAX_TICKED);
  return target.length > 0 && target.every((r) => ticked.has(r.id)) ? "all" : "some";
}
