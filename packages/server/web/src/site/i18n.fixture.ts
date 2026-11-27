import { Window } from "happy-dom";
import { expect } from "vitest";
import type { Table } from "./i18n.js";

const placeholders = (message: string): string[] => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

/** Fails unless both tables have the same keys, no empty message and the same placeholders in each message. */
export function expectComplete(table: Table<string>): void {
  expect(Object.keys(table.ru).sort()).toEqual(Object.keys(table.en).sort());
  for (const lang of ["en", "ru"] as const) {
    for (const [key, message] of Object.entries(table[lang])) expect(message.trim(), `${lang}.${key}`).not.toBe("");
  }
  for (const [key, message] of Object.entries(table.en)) {
    expect(placeholders(table.ru[key] ?? ""), `placeholders of ${key}`).toEqual(placeholders(message));
  }
}

/** Fails unless every `data-i18n` element of the page's HTML already holds the English message of its key. */
export function expectEnglishInHtml(html: string, table: Table<string>): void {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? html;
    for (const el of doc.querySelectorAll("[data-i18n]")) {
      const key = el.getAttribute("data-i18n") ?? "";
      expect(Object.hasOwn(table.en, key), `the key ${key} is in the table`).toBe(true);
      expect(el.textContent?.replace(/\s+/g, " ").trim(), `the English of ${key}`).toBe(table.en[key]);
    }
  } finally {
    void win.happyDOM.close();
  }
}
