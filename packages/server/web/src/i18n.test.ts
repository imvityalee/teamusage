import { afterEach, describe, expect, test, vi } from "vitest";
import { count, LANG_KEY, loadLang, matchCount, messages, pickLang, pluralForm, saveLang, t } from "./i18n.js";

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
    expect(t("en", "memberTitle", { name: "$& <b>" })).toBe("$& <b> — teamusage");
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

describe("plural forms", () => {
  test("Russian picks one, few or many, with the 11–14 exception", () => {
    const forms = [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 0].map((n) => [n, pluralForm("ru", n)]);
    expect(forms).toEqual([
      [1, "one"], [2, "few"], [4, "few"], [5, "many"], [11, "many"], [12, "many"], [14, "many"],
      [21, "one"], [22, "few"], [25, "many"], [101, "one"], [111, "many"], [0, "many"],
    ]);
    expect([1, 2, 5, 0].map((n) => pluralForm("en", n))).toEqual(["one", "other", "other", "other"]);
  });

  test("counted nouns read naturally in both languages", () => {
    expect([1, 2, 5].map((n) => count("en", "agents", n))).toEqual(["1 agent", "2 agents", "5 agents"]);
    expect([1, 3, 5, 11, 21].map((n) => count("ru", "agents", n))).toEqual(["1 агент", "3 агента", "5 агентов", "11 агентов", "21 агент"]);
    expect([1, 2, 5].map((n) => count("en", "models", n))).toEqual(["1 model", "2 models", "5 models"]);
    expect([1, 2, 5, 12, 22].map((n) => count("ru", "models", n))).toEqual(["1 модель", "2 модели", "5 моделей", "12 моделей", "22 модели"]);
    expect([1, 2].map((n) => count("en", "machines", n))).toEqual(["1 machine", "2 machines"]);
    expect([1, 2, 5, 13].map((n) => count("ru", "machines", n))).toEqual(["1 устройство", "2 устройства", "5 устройств", "13 устройств"]);
    expect([2, 21].map((n) => count("en", "daysAgo", n))).toEqual(["2 days ago", "21 days ago"]);
    expect([2, 5, 11, 21, 24].map((n) => count("ru", "daysAgo", n))).toEqual(["2 дня назад", "5 дней назад", "11 дней назад", "21 день назад", "24 дня назад"]);
    expect([2, 6].map((n) => count("en", "syncedDaysAgo", n))).toEqual(["Synced 2 days ago", "Synced 6 days ago"]);
    expect([2, 5].map((n) => count("ru", "syncedDaysAgo", n))).toEqual(["Отправлено 2 дня назад", "Отправлено 5 дней назад"]);
    expect([7, 21].map((n) => count("en", "noSyncDays", n))).toEqual(["No sync for 7 days", "No sync for 21 days"]);
    expect([7, 21, 22, 12].map((n) => count("ru", "noSyncDays", n))).toEqual(["Нет отправок 7 дней", "Нет отправок 21 день", "Нет отправок 22 дня", "Нет отправок 12 дней"]);
  });
});

describe("filter and design strings", () => {
  test("exist in both languages with the agreed wording", () => {
    const both = (key: keyof typeof messages.en) => [t("en", key), t("ru", key)];
    expect(both("period")).toEqual(["Period", "Период"]);
    expect(both("show")).toEqual(["Show", "Показать"]);
    expect(both("allAgents")).toEqual(["All agents", "Все агенты"]);
    expect(both("allModels")).toEqual(["All models", "Все модели"]);
    expect(both("agentsTitle")).toEqual(["Agents in this period", "Агенты за этот период"]);
    expect(both("modelsTitle")).toEqual(["Models in this period", "Модели за этот период"]);
    expect(both("showAll")).toEqual(["Show all", "Показать все"]);
    expect(both("onlySelectedAgents")).toEqual(["Only models of the selected agents are listed.", "Показаны только модели выбранных агентов."]);
    expect(both("showingOnly")).toEqual(["Showing only", "Показаны только"]);
    expect(both("clearFilters")).toEqual(["Clear filters", "Сбросить фильтры"]);
    expect(t("en", "k0f")).toBe("Total tokens · filtered");
    expect(t("en", "k1f")).toBe("Estimated cost · filtered");
    expect(t("en", "ofAllInPeriod", { n: 57 })).toBe("57% of all tokens in this period");
    expect(t("en", "k3")).toBe("Most used agent");
    expect(t("en", "sentUsage")).toBe("sent usage in this period");
    expect(t("en", "membersHint")).toBe("Select a member to see their own usage");
    expect(t("en", "searchPlaceholder")).toBe("Search by name or email");
    expect(t("en", "allMembers")).toBe("All members");
    expect(t("en", "teamShare", { n: 29 })).toBe("29% of the team's tokens");
    expect(t("en", "syncedToday")).toBe("Synced today");
    expect(t("en", "syncedYesterday")).toBe("Synced yesterday");
    expect(t("en", "neverSynced")).toBe("Never synced");
    expect(t("en", "notCounted")).toBe("Usage on this machine since then is not counted yet");
    expect(t("en", "agentLimit", { n: 20 })).toBe("You can select up to 20 agents.");
    expect(t("ru", "agentLimit", { n: 20 })).toBe("Можно выбрать не больше 20 агентов.");
    expect(t("ru", "modelLimit", { n: 50 })).toBe("Можно выбрать не больше 50 моделей.");
    expect(t("en", "removeFilter", { name: "Codex" })).toBe("Remove filter: Codex");
  });
});

describe("more design strings", () => {
  test("Russian wording for the tiles, members and machines", () => {
    expect(t("ru", "k0f")).toBe("Всего токенов · с фильтром");
    expect(t("ru", "k1f")).toBe("Оценка стоимости · с фильтром");
    expect(t("ru", "ofAllInPeriod", { n: 57 })).toBe("57% всех токенов за этот период");
    expect(t("ru", "k3")).toBe("Самый используемый агент");
    expect(t("ru", "teamShare", { n: 29 })).toBe("29% токенов команды");
    expect(t("ru", "allMembers")).toBe("Все участники");
    expect(t("ru", "syncedToday")).toBe("Отправлено сегодня");
    expect(t("ru", "neverSynced")).toBe("Ещё не отправлялось");
    expect(t("ru", "notCounted")).toBe("Использование на этом устройстве с тех пор ещё не учтено");
    expect(t("en", "mixNote")).toBe("The bar's length shows each member's share of the team's tokens; its colours show which agents they used.");
    expect(t("en", "otherAgents")).toBe("Other agents");
    expect(t("ru", "otherAgents")).toBe("Другие агенты");
  });

  test("every counted noun has all three forms in both languages", () => {
    for (const noun of ["agents", "models", "machines", "daysAgo", "syncedDaysAgo", "noSyncDays"] as const) {
      for (const n of [1, 2, 5, 11, 21, 22]) {
        for (const lang of ["en", "ru"] as const) {
          const s = count(lang, noun, n);
          expect(s).toContain(String(n));
          expect(s).not.toMatch(/[{}]/);
        }
      }
    }
    expect(count("en", "machines", 1)).toBe("1 machine");
    expect(count("ru", "agents", 111)).toBe("111 агентов");
  });
});
