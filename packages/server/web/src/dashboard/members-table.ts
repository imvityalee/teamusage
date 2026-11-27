import type { Stats } from "@teamusage/shared";
import { locale } from "../i18n.js";
import type { Lang } from "../lang.js";

/** The order of the members table: which column sorts, which way, and what a press on a header does. */

type Member = Stats["members"][number];

export type MemberSort = { by: "tokens" | "cost" | "name" | "lastSync"; dir: "asc" | "desc" };
export const DEFAULT_SORT: MemberSort = { by: "tokens", dir: "desc" };

/** The way a column starts when it is pressed: the largest or newest first, and names from A. */
const FIRST_DIRECTION: Record<MemberSort["by"], MemberSort["dir"]> = { tokens: "desc", cost: "desc", lastSync: "desc", name: "asc" };

/** The sort after a press on a column: the same column turns round; a new one starts with the largest or newest first, and a name from A. */
export function nextSort(current: MemberSort, pressed: MemberSort["by"]): MemberSort {
  if (current.by !== pressed) return { by: pressed, dir: FIRST_DIRECTION[pressed] };
  return { by: pressed, dir: current.dir === "asc" ? "desc" : "asc" };
}

const syncTime = (m: Member): number => (m.lastSyncAt === null ? 0 : Date.parse(m.lastSyncAt));

/** How `a` compares with `b` in the column, from the smallest or oldest. */
function compareColumn(by: MemberSort["by"], a: Member, b: Member, names: Intl.Collator): number {
  switch (by) {
    case "tokens":
      return a.tokens - b.tokens;
    case "cost":
      return a.costUsd - b.costUsd;
    case "name":
      return names.compare(a.name, b.name);
    case "lastSync":
      return syncTime(a) - syncTime(b);
  }
}

/**
 * The members in this order. Names compare in the language's own order; a member who never synced is last in both
 * directions; equal values keep the order of tokens, then id. Does not change its argument.
 */
export function sortMembers(members: Stats["members"], sort: MemberSort, lang: Lang): Stats["members"] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const names = new Intl.Collator(locale(lang));
  return [...members].sort((a, b) => {
    const neverSyncedLast = sort.by === "lastSync" ? Number(a.lastSyncAt === null) - Number(b.lastSyncAt === null) : 0;
    return neverSyncedLast || sign * compareColumn(sort.by, a, b, names) || b.tokens - a.tokens || a.id - b.id;
  });
}
