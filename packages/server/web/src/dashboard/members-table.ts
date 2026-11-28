import type { Stats } from "@teamusage/shared";
import { locale, type Lang } from "../lang.js";
import { nextSort as nextOf, type Sort, type SortDir } from "../site/sort-head.js";

/** The order of the members table: which column sorts, which way, and what a press on a header does. */

type Member = Stats["members"][number];

export type MemberSort = Sort<"tokens" | "cost" | "name" | "lastSync">;
export const DEFAULT_SORT: MemberSort = { by: "tokens", dir: "desc" };

/** The way a column starts when it is pressed: the largest or newest first, and names from A. */
const FIRST_DIRECTION: Record<MemberSort["by"], SortDir> = { tokens: "desc", cost: "desc", lastSync: "desc", name: "asc" };

/** The sort after a press on a column (see `nextSort` of the shared header module). */
export const nextSort = (current: MemberSort, pressed: MemberSort["by"]): MemberSort => nextOf(current, pressed, FIRST_DIRECTION);

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
