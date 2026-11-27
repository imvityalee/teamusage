import { describe, expect, test } from "vitest";
import { expectComplete, expectEnglishInHtml } from "./i18n.fixture.js";

const good = { en: { a: "Hello, {name}", b: "Bye" }, ru: { a: "Привет, {name}", b: "Пока" } };

describe("expectComplete", () => {
  test("passes two complete tables", () => {
    expect(() => expectComplete(good)).not.toThrow();
  });

  test.each([
    ["a key missing in Russian", { en: good.en, ru: { a: good.ru.a } }],
    ["a key missing in English", { en: { a: good.en.a }, ru: good.ru }],
    ["an empty message", { en: good.en, ru: { ...good.ru, b: " " } }],
    ["a placeholder missing", { en: good.en, ru: { ...good.ru, a: "Привет" } }],
    ["a placeholder renamed", { en: good.en, ru: { ...good.ru, a: "Привет, {who}" } }],
  ])("fails on %s", (_, table) => {
    expect(() => expectComplete(table)).toThrow();
  });
});

describe("expectEnglishInHtml", () => {
  test("passes when each data-i18n element holds its English message, line breaks aside", () => {
    expect(() => expectEnglishInHtml(`<h1 data-i18n="b">Bye</h1><p data-i18n="a">Hello,\n  {name}</p>`, good)).not.toThrow();
  });

  test.each([
    ["an element that holds other text", `<h1 data-i18n="b">Goodbye</h1>`],
    ["an empty element", `<h1 data-i18n="b"></h1>`],
    ["an unknown key", `<h1 data-i18n="c">Bye</h1>`],
  ])("fails on %s", (_, html) => {
    expect(() => expectEnglishInHtml(html, good)).toThrow();
  });
});
