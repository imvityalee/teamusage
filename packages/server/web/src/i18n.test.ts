import { afterEach, describe, expect, test, vi } from "vitest";
import { LANG_KEY, loadLang, matchCount, messages, pickLang, saveLang, t } from "./i18n.js";

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

describe("member view strings", () => {
  test("exist in both languages with the agreed wording", () => {
    expect(t("en", "searchMembers")).toBe("Search members");
    expect(t("ru", "searchMembers")).toBe("Поиск участников");
    expect(t("en", "matchCount", { n: 2, m: 5 })).toBe("2 of 5 members");
    expect(t("ru", "matchCount", { n: 2, m: 5 })).toBe("2 из 5 участников");
    expect(t("en", "noMatch")).toBe("No members match");
    expect(t("en", "notFound")).toBe("Member not found");
    expect(t("ru", "notFound")).toBe("Участник не найден");
    expect(t("en", "memberTitle", { name: "Alice" })).toBe("Alice — teamusage");
    expect(t("ru", "memberTitle", { name: "Алиса" })).toBe("Алиса — teamusage");
  });

  test("the count reads naturally for one, twenty-one and eleven", () => {
    expect(matchCount("en", 1, 1)).toBe("1 of 1 member");
    expect(matchCount("en", 0, 3)).toBe("0 of 3 members");
    expect(matchCount("ru", 1, 1)).toBe("1 из 1 участника");
    expect(matchCount("ru", 3, 21)).toBe("3 из 21 участника");
    expect(matchCount("ru", 3, 11)).toBe("3 из 11 участников");
    expect(matchCount("ru", 3, 5)).toBe("3 из 5 участников");
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
