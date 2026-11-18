import type { Stats } from "@teamusage/shared";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import { buckets, drawChart, presentSeries, rankAgents } from "./chart.js";

function days(n: number): Stats["daily"] {
  const start = Date.UTC(2026, 4, 1);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    byAgent: { claude: 1000 + i, codex: i % 3 === 0 ? 0 : 7 * i },
  }));
}

const sum = (rows: { byAgent: Record<string, number> }[]) =>
  rows.reduce((s, r) => s + Object.values(r.byAgent).reduce((a, b) => a + b, 0), 0);

describe("buckets", () => {
  test("90 days stay daily", () => {
    const input = days(90);
    const out = buckets(input);
    expect(out).toHaveLength(90);
    expect(out[0]).toEqual({ label: "2026-05-01", byAgent: input[0]?.byAgent });
  });

  test("180 days become 26 weekly buckets labelled by their first day, with the same total", () => {
    const input = days(180);
    const out = buckets(input);
    expect(out).toHaveLength(26);
    expect(out[0]?.label).toBe("2026-05-01");
    expect(out[1]?.label).toBe("2026-05-08");
    expect(out[0]?.byAgent.claude).toBe([0, 1, 2, 3, 4, 5, 6].reduce((s, i) => s + 1000 + i, 0));
    expect(sum(out)).toBe(sum(input));
  });

  test("no days, no buckets", () => {
    expect(buckets([])).toEqual([]);
  });

  test("agent ids are plain keys, even __proto__", () => {
    const input = days(100).map((d) => ({ date: d.date, byAgent: Object.fromEntries([["__proto__", 5]]) }));
    const out = buckets(input);
    expect(Object.getPrototypeOf(out[0]?.byAgent)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out[0]?.byAgent, "__proto__")?.value).toBe(35);
  });
});

describe("ranking and series", () => {
  test("agents are ranked by total tokens, ties by id", () => {
    const totals = new Map([
      ["codex", 10],
      ["claude", 30],
      ["gemini", 10],
    ]);
    expect(rankAgents(totals)).toEqual(["claude", "codex", "gemini"]);
  });

  test("present series follow the fixed order, whatever the totals; others share one", () => {
    expect(presentSeries(new Map([["copilot", 99], ["claude", 1], ["codex", 0]]))).toEqual([0, 4]);
    expect(presentSeries(new Map([["zed", 5], ["cursor", 1], ["gemini", 2]]))).toEqual([2, 5]);
    expect(presentSeries(new Map())).toEqual([]);
  });
});

describe("drawChart", () => {
  const NAMES = ["Claude Code", "Codex", "Gemini CLI", "OpenCode", "Copilot", "Other agents"];
  const draw = (byAgent: Record<string, number>) =>
    drawChart(new Window().document as unknown as Document, [{ label: "2026-11-18", byAgent }], {
      names: NAMES,
      label: (iso) => iso,
      ariaLabel: "Tokens",
    });

  test("stacks the fixed order bottom to top, folds every other agent into one grey segment", () => {
    const svg = draw(Object.fromEntries([["cursor", 5], ["copilot", 10], ["__proto__", 5], ["claude", 20]]));
    const bar = svg.querySelector("g.bar") as Element;
    const segs = [...bar.querySelectorAll("rect, path")];
    expect(segs.map((s) => s.getAttribute("class"))).toEqual(["ag-claude", "ag-copilot", "ag-other"]);
    expect(bar.querySelector("title")?.textContent).toBe("2026-11-18: 40\nClaude Code: 20\nCopilot: 10\nOther agents: 10");
  });

  test("an agent keeps its colour whatever else is shown", () => {
    const alone = draw({ codex: 10 }).querySelector("g.bar path");
    expect(alone?.getAttribute("class")).toBe("ag-codex");
    const mixed = [...draw({ codex: 10, claude: 100 }).querySelectorAll("g.bar rect, g.bar path")].map((s) => s.getAttribute("class"));
    expect(mixed).toEqual(["ag-claude", "ag-codex"]);
  });

  test("segments are separated by a 2-unit gap and only the top one is rounded", () => {
    const bar = draw({ claude: 50, codex: 50 }).querySelector("g.bar") as Element;
    const bottom = bar.querySelector("rect") as Element;
    const top = bar.querySelector("path") as Element;
    expect(bar.querySelectorAll("rect")).toHaveLength(1);
    expect(bar.querySelectorAll("path")).toHaveLength(1);
    const bottomTop = Number(bottom.getAttribute("y"));
    // The top segment's path starts at its bottom-left corner, 2 units above the segment below.
    const start = /^M\s*([\d.]+)[ ,]([\d.]+)/.exec(top.getAttribute("d") ?? "");
    expect(Number(start?.[2])).toBeCloseTo(bottomTop - 2, 5);
    expect(top.getAttribute("d")).toMatch(/[aAqQ]/);
  });

  test("keeps role=img and its summary label", () => {
    const svg = draw({ claude: 1 });
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Tokens");
  });
});
