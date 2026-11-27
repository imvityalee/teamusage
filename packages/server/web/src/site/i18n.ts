import { loadLang, pickLang, saveLang, type Lang } from "../lang.js";

/** A page's strings: one message for each key, in English and in Russian. */
export type Table<K extends string> = { en: Record<K, string>; ru: Record<K, string> };

/** A page's `t`: the message of `key` with each `{name}` replaced literally. The result is text, never markup. */
export function translator<K extends string>(table: Table<K>): (lang: Lang, key: K, vars?: Record<string, string | number>) => string {
  return (lang, key, vars = {}) =>
    table[lang][key].replace(/\{(\w+)\}/g, (hole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : hole));
}

/** The three attributes that name a key, and how each puts its message on the element. */
const TARGETS: [string, (el: Element, text: string) => void][] = [
  ["data-i18n", (el, text) => (el.textContent = text)],
  ["data-i18n-label", (el, text) => el.setAttribute("aria-label", text)],
  ["data-i18n-placeholder", (el, text) => el.setAttribute("placeholder", text)],
];

/** Fills every `data-i18n` (text), `data-i18n-label` (aria-label) and `data-i18n-placeholder` element from `table`, and sets `<html lang>` and the title. */
export function applyText<K extends string>(doc: Document, table: Table<K>, lang: Lang, titleKey: K): void {
  const t = translator(table);
  const isKey = (k: string | null): k is K => k !== null && Object.hasOwn(table.en, k);
  doc.documentElement.lang = lang;
  doc.title = t(lang, titleKey);
  for (const [attr, put] of TARGETS) {
    for (const el of doc.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (isKey(key)) put(el, t(lang, key));
    }
  }
}

function markPressed(group: Element, lang: Lang): void {
  for (const b of group.querySelectorAll<HTMLElement>("button[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

/** Wires the EN/RU control `#lang`: marks the pressed button, stores a choice, calls `onChange`. Returns the language to start with. */
export function languageSwitch(doc: Document, onChange: (lang: Lang) => void): Lang {
  const lang = pickLang(loadLang(), navigator.language);
  const group = doc.getElementById("lang");
  if (group === null) return lang;
  markPressed(group, lang);
  group.addEventListener("click", (e) => {
    const value = (e.target as Element | null)?.closest<HTMLElement>("button[data-lang]")?.dataset.lang;
    if (value !== "en" && value !== "ru") return;
    markPressed(group, value);
    saveLang(value);
    onChange(value);
  });
  return lang;
}
