import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Table } from "./i18n.js";
import { expectComplete } from "./i18n.fixture.js";

// Every page's string table, found by listing web/src/*/strings.ts, so that a page added later is covered here
// without editing this test. (The dashboard's older table, web/src/i18n.ts, has its own checks in i18n.test.ts.)

const SRC = fileURLToPath(new URL("..", import.meta.url));
const pages = readdirSync(SRC, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SRC, e.name, "strings.ts")))
  .map((e) => e.name)
  .sort();

/** Placeholders that hold a count. */
const COUNT = /\{(n|max|total|count)\}\s+([\p{L}]+)/gu;
/** Words after a count that are not counted nouns: a preposition and a conjunction; one letter is a unit ("с" for seconds). */
const NOT_A_NOUN = new Set(["из", "и"]);
const PLURAL = /_(one|few|many)$/;
/** A team code (24 hex) or a token (64 hex) written into a message. */
const SECRET_LIKE = /[0-9a-f]{24}/i;

const tableOf = async (page: string): Promise<Table<string>> =>
  ((await import(/* @vite-ignore */ join(SRC, page, "strings.ts"))) as { strings: Table<string> }).strings;

/** The keys of Russian messages whose count stands right before a word that changes with the count. */
const countedKeys = (ru: Record<string, string>): string[] =>
  Object.entries(ru)
    .filter(([, message]) => [...message.matchAll(COUNT)].some((m) => (m[2] ?? "").length > 1 && !NOT_A_NOUN.has(m[2] ?? "")))
    .map(([key]) => key);

test("the listing finds the pages' tables, the team page's assembled from its parts among them, and counts beside nouns in them", async () => {
  expect(pages.length).toBeGreaterThan(1);
  expect(pages).toContain("team");
  const counted = await Promise.all(pages.map(async (page) => countedKeys((await tableOf(page)).ru)));
  expect(counted.flat().length).toBeGreaterThan(0);
});

describe.each(pages)("the string table of %s", (page) => {
  test("is complete: the same keys in both languages, no empty message, the same placeholders", async () => {
    expectComplete(await tableOf(page));
  });

  test("holds no 24-hex or 64-hex string in any message", async () => {
    const table = await tableOf(page);
    for (const lang of ["en", "ru"] as const) {
      for (const [key, message] of Object.entries(table[lang])) expect(message, `${lang}.${key}`).not.toMatch(SECRET_LIKE);
    }
  });

  test("gives every Russian count beside a noun its three forms", async () => {
    const { ru } = await tableOf(page);
    for (const key of countedKeys(ru)) {
      expect(key, `${key} is one of three plural forms`).toMatch(PLURAL);
      const stem = key.replace(PLURAL, "");
      for (const form of ["one", "few", "many"]) expect(Object.hasOwn(ru, `${stem}_${form}`), `${stem}_${form}`).toBe(true);
    }
  });
});
