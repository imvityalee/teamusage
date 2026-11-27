import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { expectComplete, expectEnglishInHtml } from "../site/i18n.fixture.js";
import { strings } from "./strings.js";

const landingHtml = readFileSync(new URL("../../landing.html", import.meta.url), "utf8");

test("both tables have the same keys, no empty text and the same placeholders", () => {
  expectComplete(strings);
});

test("the page's HTML already reads in English", () => {
  expectEnglishInHtml(landingHtml, strings);
});

test("the page names every key it fills, and nothing outside the table", () => {
  const used = [...landingHtml.matchAll(/data-i18n(?:-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  expect(used.filter((k) => !Object.hasOwn(strings.en, k as string))).toEqual([]);
});

test("the table holds no key the page does not use (the title key names the <title>)", () => {
  const used = new Set(["title", ...[...landingHtml.matchAll(/data-i18n(?:-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1])]);
  expect(Object.keys(strings.en).filter((k) => !used.has(k))).toEqual([]);
});

test("the <title> of the HTML is the English title", () => {
  expect(/<title>([^<]*)<\/title>/.exec(landingHtml)?.[1]).toBe(strings.en.title);
});
