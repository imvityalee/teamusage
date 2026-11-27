/** The language choice: which languages exist, which one a visitor gets, and the one thing a page stores. */

export type Lang = "en" | "ru";

/** A stored choice wins; otherwise Russian for a Russian browser, English for everything else. */
export function pickLang(stored: string | null, navigatorLang: string): Lang {
  if (stored === "en" || stored === "ru") return stored;
  return navigatorLang.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export const LANG_KEY = "teamusage.lang";

/** The stored language, or null when there is none or storage is blocked. */
export function loadLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

/** Remembers the language. The only thing this page ever stores. */
export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Storage blocked or full: the choice simply lasts for this visit.
  }
}
