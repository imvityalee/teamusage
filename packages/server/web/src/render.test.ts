import { readdirSync, readFileSync } from "node:fs";
import type { Stats } from "@teamusage/shared";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import { applyMemberSearch, renderMember, renderNotFound, renderStats } from "./render.js";
import { emptyStatsFixture, memberStatsFixture, statsFixture } from "./test-fixtures.js";

const TODAY = "2026-11-18";

function newDocument(): Document {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true } });
  return window.document as unknown as Document;
}

function render(stats = statsFixture(), lang: "en" | "ru" = "en"): HTMLElement {
  const doc = newDocument();
  const host = doc.createElement("div");
  host.append(renderStats(doc, stats, lang, TODAY));
  return host;
}

const tags = (root: Element) => [...root.querySelectorAll("*")].map((e) => e.tagName.toLowerCase());
const rows = (root: Element, id: string) => [...root.querySelectorAll(`#${id} tbody tr`)];
const cells = (row: Element) => [...row.querySelectorAll("th, td")].map((c) => c.textContent?.trim());

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
    for (const tag of ["script", "img", "iframe"]) expect(hostile.querySelector(tag)).toBeNull();
    // Only the chart's own <svg>, none from the agent id.
    expect(hostile.querySelectorAll("svg")).toHaveLength(1);
  });

  test("no event handler or javascript: attribute appears anywhere", () => {
    const hostile = render(statsFixture(HOSTILE));
    for (const el of hostile.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on")).toBe(false);
        expect(el.getAttribute(attr) ?? "").not.toMatch(/javascript:/i);
      }
    }
  });

  test("hostile values are shown literally in tables, legend and chart titles", () => {
    const hostile = render(statsFixture(HOSTILE));
    const members = hostile.querySelector("#members")?.textContent ?? "";
    expect(members).toContain(HOSTILE.name);
    expect(members).toContain(HOSTILE.email);
    const models = hostile.querySelector("#models")?.textContent ?? "";
    expect(models).toContain(HOSTILE.agent);
    expect(models).toContain(HOSTILE.model);
    expect(hostile.querySelector(".legend")?.textContent).toContain(HOSTILE.agent);
    const titles = [...hostile.querySelectorAll("svg title")].map((t) => t.textContent ?? "");
    expect(titles.some((t) => t.includes(HOSTILE.agent))).toBe(true);
  });
});

describe("tiles", () => {
  test("show the totals compactly with their context", () => {
    const root = render();
    const tiles = [...root.querySelectorAll(".tile")].map((t) => [
      t.querySelector(".k")?.textContent,
      t.querySelector(".v")?.textContent,
      t.querySelector(".s")?.textContent,
    ]);
    expect(tiles).toEqual([
      ["Total tokens", "60,500", "6,050 per day on average"],
      ["Estimated cost", "$12.50", "at public API prices"],
      ["Active members", "2", "of 3"],
      ["Top agent", "Claude Code", "91% of all tokens"],
    ]);
  });
});

describe("members table", () => {
  test("keeps the API order, scales bars to the top member and shows last sync", () => {
    const root = render();
    const r = rows(root, "members");
    expect(r.map((row) => cells(row)[0])).toEqual([
      "Alice Archeralice@example.com",
      "Bao Nguyenbao@example.com",
      "Carla Mendescarla@example.com",
    ]);
    expect(cells(r[0] as Element).slice(1)).toEqual(["40,000", "$9.00", "66%", "2", "today"]);
    expect(cells(r[1] as Element).at(-1)).toBe("8 days ago");
    expect(cells(r[2] as Element).at(-1)).toBe("—");
    const widths = r.map((row) => (row.querySelector(".bar i") as HTMLElement).style.width);
    expect(widths).toEqual(["100%", "51.2%", "0%"]);
  });

  test("headers are scoped", () => {
    const root = render();
    const ths = [...root.querySelectorAll("thead th")];
    expect(ths.length).toBeGreaterThan(0);
    for (const th of ths) expect(th.getAttribute("scope")).toBe("col");
    for (const th of root.querySelectorAll("tbody th")) expect(th.getAttribute("scope")).toBe("row");
  });
});

describe("agents and models table", () => {
  test("groups models by agent in order of agent total and marks unpriced models", () => {
    const root = render();
    const r = rows(root, "models");
    expect(r.map((row) => cells(row).slice(0, 2))).toEqual([
      ["Claude Code", "claude-sonnet-4-5"],
      ["Claude Code", "claude-opus-4-1"],
      ["Codex", "gpt-5-codex"],
      ["aider", "some-modelno price"],
    ]);
    expect(r.map((row) => row.querySelector(".unpriced") !== null)).toEqual([false, false, false, true]);
    expect(cells(r[0] as Element).slice(2)).toEqual(["100", "50", "200", "29,650", "30,000", "$8.00"]);
  });

  test("agents get colours by rank, with a shared one for the others when there are more than four", () => {
    const stats = statsFixture();
    const extra = ["gemini", "opencode", "zed"];
    stats.models.push(
      ...extra.map((agent, i) => ({ agent, model: `m${i}`, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 10 - i, costUsd: 0, unpriced: false })),
    );
    stats.daily[0] = { date: stats.daily[0]?.date ?? "", byAgent: { ...stats.daily[0]?.byAgent, gemini: 10, opencode: 9, zed: 8 } };
    const root = render(stats);
    const legend = [...root.querySelectorAll(".legend > span")].map((s) => [s.querySelector(".dot")?.getAttribute("class"), s.textContent]);
    expect(legend).toEqual([
      ["dot s0", "Claude Code"],
      ["dot s1", "Codex"],
      ["dot s2", "aider"],
      ["dot s3", "Gemini CLI"],
      ["dot s4", "Others"],
    ]);
    const dots = rows(root, "models").map((row) => row.querySelector(".dot")?.getAttribute("class"));
    expect(dots.slice(-2)).toEqual(["dot s4", "dot s4"]);
  });
});

describe("chart", () => {
  test("has a text alternative with the range and the total", () => {
    const svg = render().querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toMatch(/Nov 9.*Nov 18.*60,500/);
    expect(svg.querySelectorAll("g.bar")).toHaveLength(10);
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
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("table")).toBeNull();
    expect(root.querySelector(".empty")?.textContent).toBe("No usage in this period");
    expect(render(emptyStatsFixture(), "ru").querySelector(".empty")?.textContent).toBe("За этот период данных нет");
    expect(root.querySelectorAll(".tile")).toHaveLength(4);
  });
});

describe("member links", () => {
  test("every member name links to their page by numeric id", () => {
    const root = render();
    const links = [...root.querySelectorAll("#members tbody th a")].map((a) => [a.getAttribute("href"), a.textContent]);
    expect(links).toEqual([
      ["#/member/1", "Alice Archer"],
      ["#/member/2", "Bao Nguyen"],
      ["#/member/3", "Carla Mendes"],
    ]);
  });

  test("a hostile name never reaches the href", () => {
    const root = render(statsFixture(HOSTILE));
    expect(root.querySelector("#members tbody th a")?.getAttribute("href")).toBe("#/member/1");
  });

  test("an id that is not a plain positive integer gets no link and no markup", () => {
    const stats = statsFixture();
    const first = stats.members[0] as Stats["members"][number];
    first.id = `1"><img src=x onerror=alert(1)>` as unknown as number;
    (stats.members[1] as Stats["members"][number]).id = 0;
    const root = render(stats);
    expect(root.querySelectorAll("#members tbody th a")).toHaveLength(1);
    expect(root.querySelector("img")).toBeNull();
    expect(cells(rows(root, "members")[0] as Element)[0]).toBe("Alice Archeralice@example.com");
  });
});

describe("member search", () => {
  const renderQuery = (query: string, lang: "en" | "ru" = "en") => {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderStats(doc, statsFixture(), lang, TODAY, query));
    return host;
  };
  const count = (root: Element) => root.querySelector<HTMLElement>("#members-count");

  test("a labelled search box sits in the members panel header", () => {
    const root = render();
    const input = root.querySelector<HTMLInputElement>("#members-heading ~ * input, .panel-head input");
    expect(input).not.toBeNull();
    expect(input?.type).toBe("search");
    expect(input?.id).toBe("member-search");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(root.querySelector('label[for="member-search"]')?.textContent).toBe("Search members");
    expect(render(statsFixture(), "ru").querySelector('label[for="member-search"]')?.textContent).toBe("Поиск участников");
    expect(count(root)?.hidden).toBe(true);
  });

  test("a query narrows the rows and says how many of how many", () => {
    const root = renderQuery("BAO");
    expect(rows(root, "members").map((r) => cells(r)[0])).toEqual(["Bao Nguyenbao@example.com"]);
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
    expect(rows(host, "members").map((r) => cells(r)[0])).toEqual(["Carla Mendescarla@example.com"]);
    expect(host.querySelector("#member-search")).toBe(input);
    expect(count(host)?.textContent).toBe("1 of 3 members");
    applyMemberSearch(doc, host, stats, "en", TODAY, "  ");
    expect(rows(host, "members")).toHaveLength(3);
    expect(count(host)?.hidden).toBe(true);
    // Bars keep scaling to the top member of the whole team.
    applyMemberSearch(doc, host, stats, "en", TODAY, "bao");
    expect((host.querySelector("#members .bar i") as HTMLElement).style.width).toBe("51.2%");
  });
});

describe("member page", () => {
  function renderPage(stats = memberStatsFixture(), lang: "en" | "ru" = "en"): HTMLElement {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderMember(doc, stats, 1, lang, TODAY));
    return host;
  }

  test("shows a way back, who it is, tiles, the chart, models and machines", () => {
    const root = renderPage();
    const back = root.querySelector("a.back");
    expect(back?.getAttribute("href")).toBe("#/");
    expect(back?.textContent).toBe("← All members");
    expect(root.querySelector("h2#member-heading")?.textContent).toBe("Alice Archer");
    expect(root.querySelector(".member-head .email")?.textContent).toBe("alice@example.com");
    const tiles = [...root.querySelectorAll(".tile")].map((t) => [
      t.querySelector(".k")?.textContent,
      t.querySelector(".v")?.textContent,
      t.querySelector(".s")?.textContent,
    ]);
    expect(tiles).toEqual([
      ["Total tokens", "60,500", "6,050 per day on average"],
      ["Estimated cost", "$12.50", "at public API prices"],
      ["Active days", "10", "of 10"],
      ["Top agent", "Claude Code", "91% of all tokens"],
    ]);
    expect(root.querySelectorAll("svg")).toHaveLength(1);
    expect(rows(root, "models")).toHaveLength(4);
    expect(rows(root, "machines").map(cells)).toEqual([
      ["alice-mbp", "today"],
      ["alice-linux", "3 days ago"],
      ["old-box", "—"],
    ]);
    expect(root.querySelector("#members")).toBeNull();
    expect(root.querySelector("#member-search")).toBeNull();
  });

  test("active days count only days with tokens", () => {
    const stats = memberStatsFixture();
    for (const i of [0, 3, 4]) (stats.daily[i] as Stats["daily"][number]).byAgent = { claude: 0, codex: 0 };
    const tile = [...renderPage(stats).querySelectorAll(".tile")][2] as Element;
    expect(tile.querySelector(".v")?.textContent).toBe("7");
  });

  test("the machines table has scoped headers and scrolls inside its own container", () => {
    const root = renderPage();
    const table = root.querySelector("#machines") as Element;
    expect([...table.querySelectorAll("thead th")].map((th) => [th.getAttribute("scope"), th.textContent])).toEqual([
      ["col", "Machine"],
      ["col", "Last sync"],
    ]);
    for (const th of table.querySelectorAll("tbody th")) expect(th.getAttribute("scope")).toBe("row");
    expect(table.parentElement?.classList.contains("scroll")).toBe(true);
  });

  test("with no usage, the empty state and still the machines", () => {
    const stats = { ...emptyStatsFixture(), members: memberStatsFixture().members, machines: memberStatsFixture().machines };
    const root = renderPage(stats);
    expect(root.querySelector(".empty")?.textContent).toBe("No usage in this period");
    expect(root.querySelector("svg")).toBeNull();
    expect(root.querySelector("#models")).toBeNull();
    expect(rows(root, "machines")).toHaveLength(3);
    expect(root.querySelector("h2#member-heading")?.textContent).toBe("Alice Archer");
  });

  test("a member with no machines says so", () => {
    const root = renderPage({ ...memberStatsFixture(), machines: [] });
    expect(root.querySelector("#machines")).toBeNull();
    expect(root.querySelector("#machines-heading")?.textContent).toBe("Machines");
    expect(root.querySelector(".machines-none")?.textContent).toBe("No machines yet");
  });

  test("hostile name, email and machine label are literal text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const root = renderPage(memberStatsFixture({ ...HOSTILE, name: evil, email: evil }, evil));
    expect(tags(root)).toEqual(tags(renderPage()));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("h2#member-heading")?.textContent).toBe(evil);
    expect(root.querySelector(".member-head .email")?.textContent).toBe(evil);
    expect(cells(rows(root, "machines")[0] as Element)[0]).toBe(evil);
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(attr.startsWith("on")).toBe(false);
    }
  });

  test("Russian", () => {
    const root = renderPage(memberStatsFixture(), "ru");
    expect(root.querySelector("a.back")?.textContent).toBe("← Все участники");
    expect([...root.querySelectorAll(".tile .k")][2]?.textContent).toBe("Активные дни");
    expect(root.querySelector("#machines thead th")?.textContent).toBe("Устройство");
    expect(cells(rows(root, "machines")[1] as Element)[1]).toBe("3 дн. назад");
  });

  test("not found says so and links back", () => {
    const doc = newDocument();
    const host = doc.createElement("div");
    host.append(renderNotFound(doc, "en"));
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
    expect(sources).toContain("render.ts");
    for (const file of sources) {
      const code = readFileSync(new URL(file, dir), "utf8");
      for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\b/, /createContextualFragment/, /DOMParser/]) {
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
    expect(cells(rows(root, "members")[1] as Element).at(-1)).toBe("8 дн. назад");
  });
});
