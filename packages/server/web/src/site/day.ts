import type { Lang } from "../lang.js";

/** A day in the page's language: "Dec 4, 2026", "4 дек. 2026 г.". With no `timeZone` the day is the reader's. */
export function shortDay(iso: string, lang: Lang, timeZone?: string): string {
  return new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));
}
