import { readdirSync, readFileSync } from "node:fs";
import type { Stats } from "@teamusage/shared";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import { LOGO_PATHS } from "./agents.js";
import { NO_FILTERS, type Filters } from "./filters.js";
import { applyMemberSearch, renderBackLink, renderMember, renderMemberHead, renderNotFound, renderStats } from "./render.js";
import { emptyStatsFixture, HOSTILE_IDS, memberStatsFixture, statsFixture } from "./test-fixtures.js";

const TODAY = "2026-11-18";
const CODEX_ONLY: Filters = { agents: ["codex"], models: [] };

function newDocument(): Document {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true } });
  return window.document as unknown as Document;
}

function render(stats = statsFixture(), lang: "en" | "ru" = "en", filters: Filters = NO_FILTERS): HTMLElement {
  const doc = newDocument();
  const host = doc.createElement("div");
  host.append(renderStats(doc, stats, lang, TODAY, { filters }));
  return host;
}

/** The fixture as the server answers with `agent=codex`: the same `available`, only Codex in the numbers. */
function codexOnly(): Stats {
  const s = statsFixture();
  return {
    ...s,
    totals: { tokens: 5_000, costUsd: 1.5, activeMembers: 2, memberCount: 3 },
    daily: s.daily.map((d) => ({ date: d.date, byAgent: { codex: 500 } })),
    members: s.members.map((m, i) => ({ ...m, tokens: [4_500, 500, 0][i] ?? 0, costUsd: 0, byAgent: i < 2 ? { codex: [4_500, 500][i] } : {} })),
    models: s.models.filter((m) => m.agent === "codex"),
  };
}

const tags = (root: Element) => [...root.querySelectorAll("*")].map((e) => e.tagName.toLowerCase());
const rows = (root: Element, id: string) => [...root.querySelectorAll(`#${id} tbody tr`)];
const cells = (row: Element) => [...row.querySelectorAll("th, td")].map((c) => c.textContent?.trim());
const tileTexts = (root: Element) =>
  [...root.querySelectorAll(".tile")].map((t) => [
    t.querySelector(".k")?.textContent,
    t.querySelector(".v .tile-text")?.textContent ?? t.querySelector(".v")?.textContent,
    t.querySelector(".s")?.textContent,
  ]);
/** [initials, name, email] of a members row. */
const who = (row: Element) => [
  row.querySelector(".avatar")?.textContent,
  row.querySelector(".who a, .who b")?.textContent,
  row.querySelector(".who .email")?.textContent,
];

const HOSTILE = {
  name: `<img src=x onerror="alert(1)">`,
  email: `"><script>alert('e')</script>&amp;`,
  agent: `<svg onload=alert(2)></title><script>alert(3)</script>`,
  model: `</script><iframe src="javascript:alert(4)"></iframe>&lt;`,
};

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
      expect(el.getAttribute("style") ?? "").toMatch(/^(width: [\d.]+%;?|flex-grow: [\d.]+;?|)$/);
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
    const models: Filters = { agents: [], models: [{ agent: "codex", model: "gpt-5-codex" }] };
    expect(tileTexts(render(codexOnly(), "en", models))[2]).toEqual(["Active members", "2 of 3", "used the selected models"]);
    expect(tileTexts(render(codexOnly(), "ru", CODEX_ONLY)).map((t) => t[0])).toEqual([
      "Всего токенов · с фильтром",
      "Оценка стоимости · с фильтром",
      "Активные участники",
      "Самый используемый агент",
    ]);
  });
});

describe("members table", () => {
  test("keeps the API order with an initials avatar, name, email, tokens, cost and last sync", () => {
    const r = rows(render(), "members");
    expect(r.map(who)).toEqual([
      ["AA", "Alice Archer", "alice@example.com"],
      ["BN", "Bao Nguyen", "bao@example.com"],
      ["CM", "Carla Mendes", "carla@example.com"],
    ]);
    expect(cells(r[0] as Element).slice(1)).toEqual(["40,000", "$9.00", "", "today", ""]);
    expect(cells(r[1] as Element)[4]).toBe("8 days ago");
    expect(cells(r[2] as Element)[4]).toBe("—");
    expect(r.map((row) => row.querySelector(".avatar")?.getAttribute("aria-hidden"))).toEqual(["true", "true", "true"]);
  });

  test("a last sync 7 or more days ago is marked stale, in words and colour", () => {
    const r = rows(render(), "members");
    expect(r.map((row) => row.querySelectorAll("td")[3]?.classList.contains("stale"))).toEqual([false, true, false]);
  });

  test("the agent mix: length is the share of the top member, segments are agents in fixed colours", () => {
    const r = rows(render(), "members");
    const bars = r.map((row) => row.querySelector(".mix") as HTMLElement);
    expect(bars.map((b) => b.getAttribute("role"))).toEqual(["img", "img", "img"]);
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "66% of the team's tokens: Claude Code 88%, Codex 11%, aider 1%",
      "34% of the team's tokens: Claude Code 98%, Codex 2%",
      "0% of the team's tokens",
    ]);
    expect(bars.map((b) => (b.querySelector(".mix-bar") as HTMLElement).style.width)).toEqual(["100%", "51.2%", "0%"]);
    expect([...(bars[0] as Element).querySelectorAll(".mix-bar i")].map((i) => i.getAttribute("class"))).toEqual(["ag-claude", "ag-codex", "ag-other"]);
    expect(bars[2]?.querySelectorAll(".mix-bar i")).toHaveLength(0);
    const root = render();
    expect(root.querySelector("#members thead")?.textContent).toContain("Agent mix");
    expect(root.querySelector(".mix-note")?.textContent).toBe(
      "The bar's length shows each member's share of the team's tokens; its colours show which agents they used.",
    );
  });

  test("while a filter is active the bar's label speaks of the filtered tokens", () => {
    const label = (lang: "en" | "ru") => render(codexOnly(), lang, CODEX_ONLY).querySelector("#members .mix")?.getAttribute("aria-label");
    expect(label("en")).toBe("90% of the filtered tokens: Codex 100%");
    expect(label("ru")).toBe("90% отфильтрованных токенов: Codex 100%");
    const plain = codexOnly();
    for (const m of plain.members) delete (m as { byAgent?: unknown }).byAgent;
    expect(render(plain, "en", CODEX_ONLY).querySelector("#members .mix")?.getAttribute("aria-label")).toBe("90% of the filtered tokens");
    expect(render(statsFixture(), "ru").querySelector("#members thead")?.textContent).toContain("Состав по агентам");
  });

  test("an agent keeps its colour in the mix whatever the order of the totals", () => {
    const stats = statsFixture();
    (stats.members[0] as Stats["members"][number] & { byAgent: unknown }).byAgent = { copilot: 1, gemini: 30_000, claude: 9_999 };
    const segs = [...render(stats).querySelectorAll("#members tbody tr:first-child .mix-bar i")].map((i) => i.getAttribute("class"));
    expect(segs).toEqual(["ag-claude", "ag-gemini", "ag-copilot"]);
  });

  test("without per-agent numbers from the server, a plain share bar and no explanation", () => {
    const stats = statsFixture();
    for (const m of stats.members) delete (m as { byAgent?: unknown }).byAgent;
    const root = render(stats);
    expect(root.querySelector("#members thead")?.textContent).toContain("Share");
    expect([...root.querySelectorAll("#members .mix-bar i")].map((i) => i.getAttribute("class"))).toEqual(["share", "share"]);
    expect(root.querySelector("#members .mix")?.getAttribute("aria-label")).toBe("66% of the team's tokens");
    expect(root.querySelector(".mix-note")).toBeNull();
  });

  test("headers are scoped; the sorted column says so; the row chevron is decorative", () => {
    const root = render();
    const ths = [...root.querySelectorAll("thead th")];
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) expect(th.getAttribute("scope")).toBe("col");
    for (const th of root.querySelectorAll("tbody th")) expect(th.getAttribute("scope")).toBe("row");
    const sorted = root.querySelector('#members th[aria-sort="descending"]');
    expect(sorted?.textContent).toBe("Total tokens↓");
    expect(sorted?.querySelector(".sort")?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector('#models th[aria-sort="descending"]')?.textContent).toBe("Total tokens↓");
    for (const c of root.querySelectorAll("#members .chev-cell")) expect(c.getAttribute("aria-hidden")).toBe("true");
  });

  test("the heading shows the count, a hint and the search placeholder", () => {
    const root = render();
    expect(root.querySelector("#members-heading")?.textContent).toBe("Members 3");
    expect(root.querySelector("#members-heading ~ .hint, .panel-head .hint")?.textContent).toBe("Select a member to see their own usage");
    expect((root.querySelector("#member-search") as HTMLInputElement).placeholder).toBe("Search by name or email");
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

describe("member links", () => {
  test("every member name links to their page by numeric id", () => {
    const links = [...render().querySelectorAll("#members tbody th a")].map((a) => [a.getAttribute("href"), a.textContent]);
    expect(links).toEqual([
      ["#/member/1", "Alice Archer"],
      ["#/member/2", "Bao Nguyen"],
      ["#/member/3", "Carla Mendes"],
    ]);
  });

  test("a hostile name never reaches the href", () => {
    expect(render(statsFixture(HOSTILE)).querySelector("#members tbody th a")?.getAttribute("href")).toBe("#/member/1");
  });

  test("an id that is not a plain positive integer gets no link and no markup", () => {
    const stats = statsFixture();
    const first = stats.members[0] as Stats["members"][number];
    first.id = `1"><img src=x onerror=alert(1)>` as unknown as number;
    (stats.members[1] as Stats["members"][number]).id = 0;
    const root = render(stats);
    expect(root.querySelectorAll("#members tbody th a")).toHaveLength(1);
    expect(root.querySelector("#members img")).toBeNull();
    expect(who(rows(root, "members")[0] as Element)).toEqual(["AA", "Alice Archer", "alice@example.com"]);
  });
});

describe("member search", () => {
  const renderQuery = (query: string, lang: "en" | "ru" = "en") => {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderStats(doc, statsFixture(), lang, TODAY, { query }));
    return host;
  };
  const count = (root: Element) => root.querySelector<HTMLElement>("#members-count");

  test("a labelled search box sits in the members panel header", () => {
    const root = render();
    const input = root.querySelector<HTMLInputElement>(".panel-head input");
    expect(input?.type).toBe("search");
    expect(input?.id).toBe("member-search");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector('label[for="member-search"]')?.textContent).toBe("Search members");
    expect(render(statsFixture(), "ru").querySelector('label[for="member-search"]')?.textContent).toBe("Поиск участников");
    expect(count(root)?.hidden).toBe(true);
  });

  test("a query narrows the rows and says how many of how many", () => {
    const root = renderQuery("BAO");
    expect(rows(root, "members").map((r) => who(r)[1])).toEqual(["Bao Nguyen"]);
    expect(count(root)?.hidden).toBe(false);
    expect(count(root)?.textContent).toBe("1 of 3 members");
    expect(root.querySelector<HTMLInputElement>("#member-search")?.value).toBe("BAO");
    expect(renderQuery("example", "ru").querySelector("#members-count")?.textContent).toBe("3 из 3 участников");
  });

  test("no match says so and hides the table", () => {
    const root = renderQuery("<b>");
    expect(rows(root, "members")).toHaveLength(0);
    expect(count(root)?.textContent).toBe("No members match");
    expect((root.querySelector("#members")?.closest(".scroll") as HTMLElement).hidden).toBe(true);
    expect(root.querySelector("b")).toBeNull();
    expect(renderQuery("zzz", "ru").querySelector("#members-count")?.textContent).toBe("Участники не найдены");
  });

  test("applyMemberSearch updates the rows in place and keeps the input", () => {
    const doc = newDocument();
    const host = doc.createElement("div");
    const stats = statsFixture();
    host.append(renderStats(doc, stats, "en", TODAY));
    const input = host.querySelector("#member-search");
    applyMemberSearch(doc, host, stats, "en", TODAY, "carla");
    expect(rows(host, "members").map((r) => who(r)[1])).toEqual(["Carla Mendes"]);
    expect(host.querySelector("#member-search")).toBe(input);
    expect(count(host)?.textContent).toBe("1 of 3 members");
    applyMemberSearch(doc, host, stats, "en", TODAY, "  ");
    expect(rows(host, "members")).toHaveLength(3);
    expect(count(host)?.hidden).toBe(true);
    // Bars keep scaling to the top member of the whole team.
    applyMemberSearch(doc, host, stats, "en", TODAY, "bao");
    expect((host.querySelector("#members .mix-bar") as HTMLElement).style.width).toBe("51.2%");
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

  test("active days count only days with tokens", () => {
    const stats = memberStatsFixture();
    for (const i of [0, 3, 4]) (stats.daily[i] as Stats["daily"][number]).byAgent = { claude: 0, codex: 0 };
    expect(tileTexts(renderPage(stats))[2]?.[1]).toBe("7 of 10");
  });

  test("machines: a worded status, good under 7 days, a warning at 7 or more or never", () => {
    const stats = memberStatsFixture();
    stats.machines?.push({ label: "home-mini", lastSyncAt: "2026-11-06T12:00:00.000Z" });
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
    expect(sources).toEqual(expect.arrayContaining(["render.ts", "filterbar.ts", "agents.ts", "filters.ts", "chart.ts", "main.ts"]));
    for (const file of sources) {
      const code = readFileSync(new URL(file, dir), "utf8");
      for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /createContextualFragment/, /DOMParser/, /setHTML/]) {
        expect([file, bad.test(code)]).toEqual([file, false]);
      }
    }
  });

  test("filter state is never stored, put in a cookie or in the URL by app code", () => {
    const dir = new URL("./", import.meta.url);
    for (const file of ["filters.ts", "filterbar.ts", "agents.ts", "render.ts", "chart.ts", "api.ts", "main.ts"]) {
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
    expect(cells(rows(root, "members")[1] as Element)[4]).toBe("8 дней назад");
    expect(root.querySelector("#members-heading")?.textContent).toBe("Участники 3");
  });
});
