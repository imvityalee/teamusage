import { locale, type Lang } from "../lang.js";
import { pluralKey, type PluralKey } from "../site/plural-key.js";
import { tt } from "./strings.js";

/** The members card's counted sentences and sync ages: every number through the plural forms and the language's own grouping. */

type Counted = "memberCount" | "notSyncing" | "moreMachines" | "syncDaysAgo" | "selectedCount" | "membersAcc" | "machineCount" | "removeMore";

/** "21 участник", "2 участника", "5 участников": the sentence of `prefix` for `n`, with `n` written the language's way ("2,000", "2 000"). */
export const countText = (lang: Lang, prefix: Counted, n: number): string =>
  tt(lang, pluralKey(lang, prefix, n) satisfies PluralKey<Counted>, { n: new Intl.NumberFormat(locale(lang)).format(n) });

/** "today", "yesterday", "41 days ago" or "never": how long ago a sync was, from `days` (null when it never happened). */
export function syncText(lang: Lang, days: number | null): string {
  if (days === null) return tt(lang, "syncNever");
  if (days === 0) return tt(lang, "syncToday");
  if (days === 1) return tt(lang, "syncYesterday");
  return countText(lang, "syncDaysAgo", days);
}

/** "512 members, 14 not syncing": the line under the team's name. */
export const summaryText = (lang: Lang, members: number, stale: number): string =>
  tt(lang, "membersSummary", { members: countText(lang, "memberCount", members), stale: countText(lang, "notSyncing", stale) });
