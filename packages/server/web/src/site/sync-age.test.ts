import { describe, expect, test } from "vitest";
import { daysSince, isStale, STALE_DAYS } from "./sync-age.js";

/** A time on the local day `iso` at noon, so that the local day is the same in every time zone. */
const noon = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toISOString();
};

test("a member or machine with no sync in 7 days is not syncing", () => {
  expect(STALE_DAYS).toBe(7);
});

describe("daysSince", () => {
  test.each([
    ["2026-11-27", 0],
    ["2026-11-26", 1],
    ["2026-11-21", 6],
    ["2026-11-20", 7],
    ["2026-10-17", 41],
  ])("a sync on %s was %i days before 2026-11-27", (day, days) => {
    expect(daysSince(noon(day as string), "2026-11-27")).toBe(days);
  });

  test("a sync that never happened has no day count", () => {
    expect(daysSince(null, "2026-11-27")).toBeNull();
  });

  test("a sync that is not a time has no day count either", () => {
    expect(daysSince("last week", "2026-11-27")).toBeNull();
  });
});

describe("isStale", () => {
  test.each([
    [0, false],
    [6, false],
    [7, true],
    [41, true],
    [null, true],
  ])("%s days is not syncing: %s", (days, stale) => {
    expect(isStale(days)).toBe(stale);
  });
});
