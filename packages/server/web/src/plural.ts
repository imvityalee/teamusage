import type { Lang } from "./lang.js";

/** The plural category of a count, shared by every page: nothing here pulls in a page's string tables. */

export type PluralForm = "one" | "few" | "many" | "other";

/** The plural category of a count: English one/other; Russian one/few/many, with 11–14 always many. */
export function pluralForm(lang: Lang, n: number): PluralForm {
  const abs = Math.abs(Math.trunc(n));
  if (lang === "en") return abs === 1 ? "one" : "other";
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "many";
  if (last === 1) return "one";
  if (last >= 2 && last <= 4) return "few";
  return "many";
}
