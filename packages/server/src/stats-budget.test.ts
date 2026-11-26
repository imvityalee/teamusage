import { expect, test } from "vitest";
import { createStatsBudget } from "./stats-budget.js";
import { TEAM_STATS_MS_PER_MINUTE } from "./team-limits.js";

test("the agreed value", () => expect(TEAM_STATS_MS_PER_MINUTE).toBe(6000));
test("a team asks until its minute's time is used up, and again when the minute ends", () => {
  let t = 0;
  const budget = createStatsBudget({ msPerMinute: 100, now: () => t });
  budget.spend(1, 60);
  expect(budget.retryAfter(1)).toBeNull();
  budget.spend(1, 60);                       // 120 of 100
  expect(budget.retryAfter(1)).toBe(60);
  expect(budget.retryAfter(2)).toBeNull();   // another team
  t = 59_000;
  expect(budget.retryAfter(1)).toBe(1);
  t = 60_000;
  expect(budget.retryAfter(1)).toBeNull();
});
test("work shorter than a millisecond still counts as one", () => {
  const budget = createStatsBudget({ msPerMinute: 2, now: () => 0 });
  budget.spend(1, 0.01);
  budget.spend(1, 0.01);
  expect(budget.retryAfter(1)).toBe(60);
});
