import { expect, test } from "vitest";
import { MIN_USAGE_DATE } from "./limits.js";
import { validateBatch } from "./records.js";

const good = { date: "2026-11-18", agent: "claude", model: "opus-4-7", input: 1000, output: 20000,
  cacheCreate: 300000, cacheRead: 4000000, total: 4321000, costUsd: 12.5, unpriced: false };
const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-25T10:30:00.000Z");
const check = (date: unknown, now = NOW) => validateBatch({ records: [{ ...good, date }] }, now);

test("the window starts on 2024-01-01", () => expect(MIN_USAGE_DATE).toBe("2024-01-01"));
test.each(["2024-01-01", "2025-06-30", "2026-11-25", "2026-11-26"])("%s is accepted", (date) => expect(check(date).ok).toBe(true));
test.each(["2023-12-31", "2026-11-27", "0000-01-01", "9999-12-31"])("%s is refused with the accepted range", (date) =>
  expect(check(date)).toEqual({ ok: false, error: "records[0]: date must be from 2024-01-01 to tomorrow" }));
test("a date that is not a calendar date is still an invalid date", () =>
  expect(check("2026-02-31")).toEqual({ ok: false, error: "records[0]: invalid date" }));
test("tomorrow moves at UTC midnight", () => {
  expect(check("2026-11-27", at("2026-11-25T23:59:59.999Z")).ok).toBe(false);
  expect(check("2026-11-27", at("2026-11-26T00:00:00.000Z")).ok).toBe(true);
});
test("a laptop at UTC+14 just after its midnight sends its local today", () =>
  expect(check("2026-11-26", at("2026-11-25T10:05:00.000Z")).ok).toBe(true)); // 00:05 on the 26th there
test("without a clock, the real one is used", () =>
  expect(validateBatch({ records: [{ ...good, date: new Date().toISOString().slice(0, 10) }] }).ok).toBe(true));
