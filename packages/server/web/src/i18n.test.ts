import { afterEach, describe, expect, test, vi } from "vitest";
import { LANG_KEY, loadLang, messages, pickLang, saveLang, t } from "./i18n.js";

describe("messages", () => {
  test("English and Russian have the same keys", () => {
    expect(Object.keys(messages.ru)).toEqual(Object.keys(messages.en));
  });

  test("no message is empty", () => {
    for (const table of [messages.en, messages.ru]) {
      for (const value of Object.values(table)) expect(value.trim()).not.toBe("");
    }
  });

  test("both languages use the same placeholders", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      expect(holes(messages.ru[key])).toEqual(holes(messages.en[key]));
    }
  });
});

describe("pickLang", () => {
  test("a stored choice wins, otherwise the browser language decides", () => {
    expect(pickLang(null, "ru-RU")).toBe("ru");
    expect(pickLang("en", "ru-RU")).toBe("en");
    expect(pickLang(null, "de")).toBe("en");
    expect(pickLang("ru", "en-US")).toBe("ru");
    expect(pickLang("fr", "ru")).toBe("ru");
  });
});

describe("t", () => {
  test("fills placeholders literally", () => {
    expect(t("en", "daysAgo", { n: 3 })).toBe("3 days ago");
    expect(t("ru", "daysAgo", { n: 3 })).toBe("3 дн. назад");
    expect(t("en", "loadFailed", { error: "$& <b>" })).toContain("$& <b>");
  });
});

describe("stored language", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reads and writes only the language key", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(loadLang()).toBeNull();
    saveLang("ru");
    expect([...store]).toEqual([[LANG_KEY, "ru"]]);
    expect(loadLang()).toBe("ru");
  });

  test("a blocked storage is ignored", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadLang()).toBeNull();
    expect(() => saveLang("en")).not.toThrow();
  });
});
