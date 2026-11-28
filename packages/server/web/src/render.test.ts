import { readdirSync, readFileSync } from "node:fs";
import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import { LOGO_PATHS } from "./agents.js";
import type { Filters } from "./filters.js";
import { renderBackLink, renderMember, renderMemberHead, renderNotFound } from "./render.js";
import { CODEX_ONLY, HOSTILE, TODAY, cells, codexOnly, newDocument, render, rows, tags } from "./render.fixture.js";
import { noon } from "./site/noon.fixture.js";
import { emptyStatsFixture, HOSTILE_IDS, memberStatsFixture, statsFixture } from "./test-fixtures.js";

const tileTexts = (root: Element) =>
  [...root.querySelectorAll(".tile")].map((t) => [
    t.querySelector(".k")?.textContent,
    t.querySelector(".v .tile-text")?.textContent ?? t.querySelector(".v")?.textContent,
    t.querySelector(".s")?.textContent,
  ]);

describe("server values are text, never markup", () => {
  test("hostile names create exactly the same elements as plain ones", () => {
    const plain = render();
    const hostile = render(statsFixture(HOSTILE));
    expect(tags(hostile)).toEqual(tags(plain));
    for (const tag of ["script", "iframe"]) expect(hostile.querySelector(tag)).toBeNull();
    // Images are only the fixed, same-origin agent logos.
    for (const img of hostile.querySelectorAll("img")) expect(LOGO_PATHS.has(img.getAttribute("src") ?? "")).toBe(true);
  });

  test("no event handler, javascript: or server value appears in an attribute that could act on it", () => {
    const hostile = render(statsFixture(HOSTILE));
    for (const el of hostile.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on")).toBe(false);
        expect(el.getAttribute(attr) ?? "").not.toMatch(/javascript:/i);
      }
      // Classes and ids come from fixed lists, never from an agent id or a name.
      expect(el.getAttribute("class") ?? "").not.toMatch(/[<>"']/);
      expect(el.id).not.toMatch(/[<>"']/);
      // Inline styles carry only numbers.
      expect(el.getAttribute("style") ?? "").toMatch(/^(width: [\d.]+%;?|flex-grow: [\d.]+;?|--chars: \d+;?|)$/);
    }
  });

  test("hostile values are shown literally in tables, the agent mix and chart titles", () => {
    const hostile = render(statsFixture(HOSTILE));
    const members = hostile.querySelector("#members")?.textContent ?? "";
    expect(members).toContain(HOSTILE.name);
    expect(members).toContain(HOSTILE.email);
    const models = hostile.querySelector("#models")?.textContent ?? "";
    expect(models).toContain(HOSTILE.agent);
    expect(models).toContain(HOSTILE.model);
    expect(hostile.querySelector("#members .mix")?.getAttribute("aria-label")).toContain(HOSTILE.agent);
    // In the chart every agent outside the fixed five is folded into "Other agents".
    expect(hostile.querySelector(".legend")?.textContent).toContain("Other agents");
    const titles = [...hostile.querySelectorAll("svg title")].map((t) => t.textContent ?? "");
    expect(titles.some((t) => t.includes("Other agents: 100"))).toBe(true);
  });

  test("agent ids from a hostile client get the grey colour and a lettered badge, nothing else", () => {
    for (const id of HOSTILE_IDS) {
      const root = render(statsFixture({ name: "A B", email: "a@b", agent: id, model: "m" }));
      const row = rows(root, "models").find((r) => r.querySelector(".agent-name")?.textContent === id) as Element;
      expect(row.querySelector(".agent-icon")?.className).toBe("agent-icon ag-other");
      expect(row.querySelector("img")).toBeNull();
      expect(tags(root)).toEqual(tags(render()));
    }
  });
});

describe("tiles", () => {
  test("show the totals compactly with their context", () => {
    expect(tileTexts(render())).toEqual([
      ["Total tokens", "60,500", "6,050 per day on average"],
      ["Estimated cost", "$12.50", "at public API prices"],
      ["Active members", "2 of 3", "sent usage in this period"],
      ["Most used agent", "Claude Code", "91% of all tokens"],
    ]);
  });

  test("the most used agent has its icon", () => {
    const tile = [...render().querySelectorAll(".tile")][3] as Element;
    expect(tile.querySelector(".agent-icon")?.className).toBe("agent-icon ag-claude");
    expect(tile.querySelector(".agent-icon")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("while a filter is active, the first two say filtered and the share of the period comes from available", () => {
    expect(tileTexts(render(codexOnly(), "en", CODEX_ONLY))).toEqual([
      ["Total tokens · filtered", "5,000", "8% of all tokens in this period"],
      ["Estimated cost · filtered", "$1.50", "at public API prices"],
      ["Active members", "2 of 3", "used the selected agents"],
      ["Most used agent", "Codex", "100% of filtered tokens"],
    ]);
    const models: Filters = { agents: [], models: [{ agent: "codex", model: "gpt-5-codex" }], accounts: [], plans: [] };
    expect(tileTexts(render(codexOnly(), "en", models))[2]).toEqual(["Active members", "2 of 3", "used the selected models"]);
    const accounts: Filters = { agents: [], models: [], accounts: ["personal"], plans: [] };
    expect(tileTexts(render(codexOnly(), "en", accounts))[2]).toEqual(["Active members", "2 of 3", "used the selected accounts"]);
    expect(tileTexts(render(codexOnly(), "en", accounts))[0]?.[0]).toBe("Total tokens · filtered");
    expect(tileTexts(render(codexOnly(), "ru", CODEX_ONLY)).map((t) => t[0])).toEqual([
      "Всего токенов · с фильтром",
      "Оценка стоимости · с фильтром",
      "Активные участники",
      "Самый используемый агент",
    ]);
  });
});

describe("agents and models table", () => {
  test("sorted by total tokens with the agent's icon and name; unpriced models are marked", () => {
    const r = rows(render(), "models");
    expect(r.map((row) => [row.querySelector(".agent-name")?.textContent, cells(row)[1]])).toEqual([
      ["Claude Code", "claude-sonnet-4-5"],
      ["Claude Code", "claude-opus-4-1"],
      ["Codex", "gpt-5-codex"],
      ["aider", "some-modelno price"],
    ]);
    expect(r.map((row) => row.querySelector(".agent-icon")?.className)).toEqual([
      "agent-icon ag-claude",
      "agent-icon ag-claude",
      "agent-icon ag-codex",
      "agent-icon ag-other",
    ]);
    expect(r.map((row) => row.querySelector(".unpriced") !== null)).toEqual([false, false, false, true]);
    expect(cells(r[0] as Element).slice(2)).toEqual(["100", "50", "200", "29,650", "30,000", "$8.00"]);
  });
});

describe("chart", () => {
  test("has a text alternative with the range and the total", () => {
    const svg = render().querySelector("svg[role=img]") as SVGSVGElement;
    expect(svg.getAttribute("aria-label")).toMatch(/Nov 9.*Nov 18.*60,500/);
    expect(svg.querySelectorAll("g.bar")).toHaveLength(10);
  });

  test("the legend lists the agents shown, in the fixed order, with their icons; others share one entry", () => {
    const stats = statsFixture();
    stats.daily[0] = { date: stats.daily[0]?.date ?? "", byAgent: { ...stats.daily[0]?.byAgent, copilot: 1, opencode: 9, zed: 8, gemini: 10 } };
    const legend = [...render(stats).querySelectorAll(".legend > span")].map((s) => [s.querySelector(".agent-icon")?.className, s.querySelector(".legend-name")?.textContent]);
    expect(legend).toEqual([
      ["agent-icon ag-claude", "Claude Code"],
      ["agent-icon ag-codex", "Codex"],
      ["agent-icon ag-gemini", "Gemini CLI"],
      ["agent-icon ag-opencode", "OpenCode"],
      ["agent-icon ag-copilot", "Copilot"],
      ["agent-icon ag-other", "Other agents"],
    ]);
  });

  test("a filter never repaints an agent", () => {
    const legend = [...render(codexOnly(), "en", CODEX_ONLY).querySelectorAll(".legend .agent-icon")].map((i) => i.className);
    expect(legend).toEqual(["agent-icon ag-codex"]);
    const segs = [...render(codexOnly(), "en", CODEX_ONLY).querySelectorAll("svg g.bar rect, svg g.bar path")].map((s) => s.getAttribute("class"));
    expect(new Set(segs)).toEqual(new Set(["ag-codex"]));
  });

  test("is weekly beyond 90 days", () => {
    const stats = statsFixture();
    const start = Date.UTC(2026, 4, 22);
    stats.daily = Array.from({ length: 180 }, (_, i) => ({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      byAgent: { claude: 10 },
    }));
    const root = render(stats);
    expect(root.querySelector("#chart-heading")?.textContent).toBe("Tokens per week, by agent");
    expect(root.querySelectorAll("svg g.bar")).toHaveLength(26);
  });
});

describe("empty state", () => {
  test("replaces the chart and tables when nothing was used", () => {
    const root = render(emptyStatsFixture());
    expect(root.querySelector("svg[role=img]")).toBeNull();
    expect(root.querySelector("table")).toBeNull();
    expect(root.querySelector(".empty")?.textContent).toBe("No usage in this period");
    expect(root.querySelector("#empty-clear")).toBeNull();
    expect(render(emptyStatsFixture(), "ru").querySelector(".empty")?.textContent).toBe("За этот период данных нет");
    expect(root.querySelectorAll(".tile")).toHaveLength(4);
  });

  test("a filter that matches nothing says so and offers Clear filters", () => {
    const root = render(emptyStatsFixture(), "en", CODEX_ONLY);
    expect(root.querySelector(".empty p")?.textContent).toBe("Nothing matches these filters in this period");
    const clear = root.querySelector("#empty-clear") as HTMLButtonElement;
    expect([clear.tagName, clear.type, clear.textContent]).toEqual(["BUTTON", "button", "Clear filters"]);
    expect(render(emptyStatsFixture(), "ru", CODEX_ONLY).querySelector("#empty-clear")?.textContent).toBe("Сбросить фильтры");
  });
});

describe("member page", () => {
  function renderPage(stats = memberStatsFixture(), lang: "en" | "ru" = "en", opts: { filters?: Filters; teamTokens?: number | null } = {}): HTMLElement {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderMemberHead(doc, stats, 1, lang, TODAY), renderMember(doc, stats, 1, lang, TODAY, opts));
    return host;
  }
  const machines = (root: Element) =>
    [...root.querySelectorAll("#machines li")].map((li) => [
      li.querySelector(".machine-label")?.textContent,
      li.querySelector(".status-pill")?.textContent?.trim(),
      li.querySelector(".status-pill")?.classList.contains("warn") ? "warn" : "good",
      li.querySelector(".machine-note")?.textContent ?? "",
    ]);

  test("a way back, the avatar, name, and one line with email, machines and last sync", () => {
    const root = renderPage();
    const back = root.querySelector("nav a.back");
    expect(back?.getAttribute("href")).toBe("#/");
    expect(back?.textContent).toBe("All members");
    expect(root.querySelector("nav")?.getAttribute("aria-label")).toBe("Breadcrumb");
    expect(root.querySelector(".member-head .avatar")?.textContent).toBe("AA");
    expect(root.querySelector("h2#member-heading")?.textContent).toBe("Alice Archer");
    expect(root.querySelector(".member-sub")?.textContent).toBe("alice@example.com · 2 machines · last sync today");
  });

  test("tiles: share of the team only when it is known and no filter is active", () => {
    expect(tileTexts(renderPage(memberStatsFixture(), "en", { teamTokens: 121_000 }))).toEqual([
      ["Total tokens", "60,500", "50% of the team's tokens"],
      ["Estimated cost", "$12.50", "at public API prices"],
      ["Active days", "10 of 10", "days with any usage"],
      ["Most used agent", "Claude Code", "91% of their tokens"],
    ]);
    expect(tileTexts(renderPage(memberStatsFixture(), "en", { teamTokens: null }))[0]).toEqual(["Total tokens", "60,500", ""]);
    const filtered = tileTexts(renderPage(memberStatsFixture(), "en", { teamTokens: 121_000, filters: CODEX_ONLY }));
    expect(filtered[0]).toEqual(["Total tokens · filtered", "60,500", "100% of all tokens in this period"]);
    expect(filtered[3]?.[2]).toBe("91% of filtered tokens");
  });

  test("the chart, models and machines, and no members table", () => {
    const root = renderPage();
    expect(root.querySelectorAll("svg[role=img]")).toHaveLength(1);
    expect(rows(root, "models")).toHaveLength(4);
    expect(root.querySelector("#members")).toBeNull();
    expect(root.querySelector("#member-search")).toBeNull();
  });

  test("By account: name, tokens and share of the member's tokens, largest first", () => {
    const byAccount = (root: Element) =>
      [...root.querySelectorAll("#accounts li")].map((li) => [
        li.querySelector(".acct-name")?.textContent,
        li.querySelector(".acct-tokens")?.textContent,
        li.querySelector(".acct-share")?.textContent,
      ]);
    const root = renderPage();
    expect(root.querySelector("#accounts-heading")?.textContent).toBe("By account");
    expect(byAccount(root)).toEqual([
      ["Team · Devcats · Premium", "31,000", "78%"],
      ["Unknown", "5,000", "13%"],
      ["Personal · Pro", "4,000", "10%"],
    ]);
    // After the models, before the machines.
    const headings = [...root.querySelectorAll("section.panel h2")].map((h) => h.id);
    expect(headings.indexOf("accounts-heading")).toBe(headings.indexOf("models-heading") + 1);
    expect(headings.indexOf("machines-heading")).toBe(headings.indexOf("accounts-heading") + 1);
    expect(root.querySelector("#accounts .agent-icon, #accounts [style]")).toBeNull();
    const ru = renderPage(memberStatsFixture(), "ru");
    expect(ru.querySelector("#accounts-heading")?.textContent).toBe("По аккаунтам");
    expect(byAccount(ru)[2]).toEqual(["Личный · Pro", "4,000", "10%"]);
  });

  test("By account is left out when the member has no account numbers or no usage", () => {
    const stats = memberStatsFixture();
    (stats.members[0] as Stats["members"][number]).byAccountPlan = [];
    expect(renderPage(stats).querySelector("#accounts-heading")).toBeNull();
    const empty = { ...emptyStatsFixture(), members: memberStatsFixture().members, machines: memberStatsFixture().machines };
    expect(renderPage(empty).querySelector("#accounts")).toBeNull();
  });

  test("renders org as text on the member page", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const withOrg = (org: string) => {
      const stats = memberStatsFixture();
      (stats.members[0] as Stats["members"][number]).byAccountPlan = [{ account: `enterprise:${org}`, plan: "none", tokens: 9 }, { account: "personal", plan: "none", tokens: 1 }];
      return renderPage(stats);
    };
    const root = withOrg(evil);
    expect(tags(root)).toEqual(tags(withOrg("Plain")));
    expect(root.querySelector("#accounts img, script")).toBeNull();
    expect(root.querySelector("#accounts .acct-name")?.textContent).toBe(`Enterprise · ${evil}`);
  });

  test("active days count only days with tokens", () => {
    const stats = memberStatsFixture();
    for (const i of [0, 3, 4]) (stats.daily[i] as Stats["daily"][number]).byAgent = { claude: 0, codex: 0 };
    expect(tileTexts(renderPage(stats))[2]?.[1]).toBe("7 of 10");
  });

  test("machines: a worded status, good under 7 days, a warning at 7 or more or never", () => {
    const stats = memberStatsFixture();
    stats.machines?.push({ label: "home-mini", lastSyncAt: noon("2026-11-06") });
    const root = renderPage(stats);
    expect(root.querySelector("#machines-heading")?.textContent).toBe("Machines 4");
    expect(machines(root)).toEqual([
      ["alice-mbp", "Synced today", "good", ""],
      ["alice-linux", "Synced 3 days ago", "good", ""],
      ["old-box", "Never synced", "warn", ""],
      ["home-mini", "No sync for 12 days", "warn", "Usage on this machine since then is not counted yet"],
    ]);
    // Status is words plus an icon, never colour alone.
    for (const pill of root.querySelectorAll("#machines .status-pill")) expect(pill.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("with no usage, the empty state and still the machines", () => {
    const stats = { ...emptyStatsFixture(), members: memberStatsFixture().members, machines: memberStatsFixture().machines };
    const root = renderPage(stats);
    expect(root.querySelector(".empty")?.textContent).toBe("No usage in this period");
    expect(root.querySelector("svg[role=img]")).toBeNull();
    expect(root.querySelector("#models")).toBeNull();
    expect(root.querySelectorAll("#machines li")).toHaveLength(3);
    expect(root.querySelector("h2#member-heading")?.textContent).toBe("Alice Archer");
  });

  test("a member with no machines says so", () => {
    const root = renderPage({ ...memberStatsFixture(), machines: [] });
    expect(root.querySelector("#machines")).toBeNull();
    expect(root.querySelector("#machines-heading")?.textContent).toBe("Machines 0");
    expect(root.querySelector(".machines-none")?.textContent).toBe("No machines yet");
  });

  test("hostile name, email and machine label are literal text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const root = renderPage(memberStatsFixture({ ...HOSTILE, name: evil, email: evil }, evil));
    expect(tags(root)).toEqual(tags(renderPage(memberStatsFixture({ ...HOSTILE, name: "Ann Bee", email: "ann@x" }, "plain"))));
    for (const img of root.querySelectorAll("img")) expect(LOGO_PATHS.has(img.getAttribute("src") ?? "")).toBe(true);
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("h2#member-heading")?.textContent).toBe(evil);
    expect(root.querySelector(".member-sub")?.textContent).toBe(`${evil} · 2 machines · last sync today`);
    expect(root.querySelector(".member-head .avatar")?.textContent).toBe("IS");
    expect(machines(root)[0]?.[0]).toBe(evil);
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith("on")).toBe(false);
    }
  });

  test("Russian", () => {
    const root = renderPage(memberStatsFixture(), "ru");
    expect(root.querySelector("a.back")?.textContent).toBe("Все участники");
    expect([...root.querySelectorAll(".tile .k")][2]?.textContent).toBe("Активные дни");
    expect(root.querySelector("#machines-heading")?.textContent).toBe("Устройства 3");
    expect(root.querySelector(".member-sub")?.textContent).toBe("alice@example.com · 2 устройства · последняя отправка сегодня");
    expect(machines(root)[1]?.[1]).toBe("Отправлено 3 дня назад");
  });

  test("not found says so; the way back is its own element", () => {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderBackLink(doc, "en"), renderNotFound(doc, "en"));
    expect(host.querySelector(".empty")?.textContent).toBe("Member not found");
    expect(host.querySelector("a.back")?.getAttribute("href")).toBe("#/");
    const ru = doc.createElement("div");
    ru.append(renderNotFound(doc, "ru"));
    expect(ru.querySelector(".empty")?.textContent).toBe("Участник не найден");
  });
});

describe("app code never parses markup", () => {
  test("no HTML-parsing or code-evaluating API appears in the dashboard sources", () => {
    const dir = new URL("./", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-fixtures.ts");
    expect(sources).toEqual(expect.arrayContaining(["render.ts", "filterbar.ts", "agents.ts", "accounts.ts", "filters.ts", "chart.ts", "main.ts"]));
    for (const file of sources) {
      const code = readFileSync(new URL(file, dir), "utf8");
      for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /createContextualFragment/, /DOMParser/, /setHTML/]) {
        expect([file, bad.test(code)]).toEqual([file, false]);
      }
    }
  });

  test("filter state is never stored, put in a cookie or in the URL by app code", () => {
    const dir = new URL("./", import.meta.url);
    for (const file of ["filters.ts", "filterbar.ts", "agents.ts", "accounts.ts", "render.ts", "chart.ts", "api.ts", "main.ts"]) {
      const code = readFileSync(new URL(file, dir), "utf8");
      for (const bad of [/localStorage/, /sessionStorage/, /document\.cookie/, /location\.(hash|href|search)\s*=/, /history\.(push|replace)State/, /new RegExp/]) {
        expect([file, bad.test(code)]).toEqual([file, false]);
      }
    }
  });
});

describe("language", () => {
  test("Russian renders Russian labels", () => {
    const root = render(statsFixture(), "ru");
    expect(root.querySelector(".tile .k")?.textContent).toBe("Всего токенов");
    expect(root.querySelector("#members thead th")?.textContent).toBe("Участник");
    expect(cells(rows(root, "members")[1] as Element)[5]).toBe("8 дней назад");
    expect(root.querySelector("#members-heading")?.textContent).toBe("Участники 3");
  });
});
