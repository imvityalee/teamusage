import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { expectComplete, expectEnglishInHtml } from "../site/i18n.fixture.js";
import { strings } from "./strings.js";

const openHtml = readFileSync(new URL("../../open.html", import.meta.url), "utf8");

test("both tables have the same keys, no empty text and the same placeholders", () => {
  expectComplete(strings);
});

test("the page's HTML already reads in English", () => {
  expectEnglishInHtml(openHtml, strings);
});

test("the page names every key it fills, and nothing outside the table", () => {
  const used = [...openHtml.matchAll(/data-i18n(?:-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  expect(used.filter((k) => !Object.hasOwn(strings.en, k as string))).toEqual([]);
});
