import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import { renderStats } from "./render.js";
import { emptyStatsFixture, statsFixture } from "./test-fixtures.js";

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

describe("language", () => {
  test("Russian renders Russian labels", () => {
    const root = render(statsFixture(), "ru");
    expect(root.querySelector(".tile .k")?.textContent).toBe("Всего токенов");
    expect(root.querySelector("#members thead th")?.textContent).toBe("Участник");
    expect(cells(rows(root, "members")[1] as Element).at(-1)).toBe("8 дн. назад");
  });
});
