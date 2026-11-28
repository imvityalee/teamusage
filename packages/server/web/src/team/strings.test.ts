import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CODE_NOT_SHOWN as SERVER_CODE_NOT_SHOWN } from "../../../src/routes-team-settings.js";
import { expectComplete, expectEnglishInHtml } from "../site/i18n.fixture.js";
import { CODE_NOT_SHOWN } from "./code-card.js";
import { parts, strings } from "./strings.js";

const html = readFileSync(new URL("../../team.html", import.meta.url), "utf8");

test("both tables have the same keys, no empty text and the same placeholders", () => {
  expectComplete(strings);
});

test("no two parts of the table share a key, and each part has both languages", () => {
  const keys = Object.values(parts).flatMap((part) => Object.keys(part.en));
  expect(keys.length).toBe(new Set(keys).size);
  for (const part of Object.values(parts)) expect(Object.keys(part.ru).sort()).toEqual(Object.keys(part.en).sort());
});

test("the page's HTML already reads in English", () => {
  expectEnglishInHtml(html, strings);
});

test("the page names every key it fills, and nothing outside the table", () => {
  const used = [...html.matchAll(/data-i18n(?:-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  expect(used.filter((k) => !Object.hasOwn(strings.en, k as string))).toEqual([]);
});

test("the page has no inline script, style attribute or event attribute", () => {
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
});

test("the page's text of a code that can no longer be shown is the server's", () => {
  expect(CODE_NOT_SHOWN).toBe(SERVER_CODE_NOT_SHOWN);
});

test("each counted sentence has its three forms, in both languages", () => {
  for (const table of [strings.en, strings.ru]) {
    const prefixes = Object.keys(table).filter((key) => key.endsWith("_one")).map((key) => key.slice(0, -4));
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) expect(Object.keys(table).filter((key) => key.startsWith(`${prefix}_`)).sort()).toEqual([`${prefix}_few`, `${prefix}_many`, `${prefix}_one`]);
  }
});
