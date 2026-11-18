import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import { buckets, rankAgents, slotOf } from "./chart.js";

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

describe("agent colours", () => {
  test("agents are ranked by total tokens, ties by id", () => {
    const totals = new Map([
      ["codex", 10],
      ["claude", 30],
      ["gemini", 10],
    ]);
    expect(rankAgents(totals)).toEqual(["claude", "codex", "gemini"]);
  });

  test("the top four get their own colour; the rest share the fifth when there are more than four", () => {
    const four = ["a", "b", "c", "d"];
    expect(four.map((a) => slotOf(a, four))).toEqual([0, 1, 2, 3]);
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(six.map((a) => slotOf(a, six))).toEqual([0, 1, 2, 3, 4, 4]);
  });
});
