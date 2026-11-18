import { describe, expect, test } from "vitest";
import { agentName, compact, daysSince, full, localIsoDate, shortDate, usd } from "./format.js";

describe("full", () => {
  test("groups thousands", () => {
    expect(full(2936526460)).toBe("2,936,526,460");
    expect(full(0)).toBe("0");
    expect(full(1234.6)).toBe("1,235");
  });
});

describe("compact", () => {
  test("uses B, M or the full number", () => {
    expect(compact(2936526460)).toBe("2.94B");
    expect(compact(44200000)).toBe("44.2M");
    expect(compact(950)).toBe("950");
    expect(compact(44000)).toBe("44,000");
    expect(compact(0)).toBe("0");
  });

  test("moves up a unit when rounding reaches 1000", () => {
    expect(compact(999_960_000)).toBe("1.00B");
  });
});

describe("usd", () => {
  test("shows dollars with two decimals", () => {
    expect(usd(2023.09)).toBe("$2,023.09");
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.005)).toBe("$0.01");
  });
});

describe("dates", () => {
  test("localIsoDate uses the local calendar day", () => {
    expect(localIsoDate(new Date(2026, 10, 18, 23, 59))).toBe("2026-11-18");
    expect(localIsoDate(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });

  test("daysSince counts local calendar days, never below zero", () => {
    const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).toISOString();
    expect(daysSince(at(2026, 11, 18, 1), "2026-11-18")).toBe(0);
    expect(daysSince(at(2026, 11, 17, 23), "2026-11-18")).toBe(1);
    expect(daysSince(at(2026, 11, 8, 12), "2026-11-18")).toBe(10);
    expect(daysSince(at(2026, 11, 19, 12), "2026-11-18")).toBe(0);
    expect(daysSince("not a date", "2026-11-18")).toBeNull();
  });

  test("shortDate formats a calendar date in the given locale", () => {
    expect(shortDate("2026-11-18", "en-US")).toBe("Nov 18");
    expect(shortDate("2026-11-18", "ru-RU")).toMatch(/^18 нояб/);
  });
});

describe("agentName", () => {
  test("names known agents and keeps unknown ids", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("codex")).toBe("Codex");
    expect(agentName("gemini")).toBe("Gemini CLI");
    expect(agentName("opencode")).toBe("OpenCode");
    expect(agentName("aider")).toBe("aider");
    expect(agentName("__proto__")).toBe("__proto__");
    expect(agentName("toString")).toBe("toString");
  });
});
