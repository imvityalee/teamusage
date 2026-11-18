import { describe, expect, test } from "vitest";
import {
  MAX_AGENT_CHARS,
  MAX_BATCH,
  MAX_COST_USD,
  MAX_MODEL_CHARS,
  MAX_TOKENS,
  MAX_TOTAL_TOKENS,
  validateBatch,
} from "./records.js";
import { presetRange } from "./stats.js";

const good = { date: "2026-11-18", agent: "claude", model: "opus-4-7", input: 1000, output: 20000,
  cacheCreate: 300000, cacheRead: 4000000, total: 4321000, costUsd: 12.5, unpriced: false };
test("accepts a valid batch", () => expect(validateBatch({ records: [good] })).toEqual({ ok: true, records: [good] }));
test.each([
  ["negative tokens", { ...good, input: -1, total: good.total - 1001 }],
  ["fractional tokens with a consistent total", { ...good, input: 1000.5, output: 19999.5 }],
  ["total not the sum", { ...good, total: 1 }],
  ["bad date", { ...good, date: "18/11/2026" }],
  ["impossible date", { ...good, date: "2026-02-31" }],
  ["negative cost", { ...good, costUsd: -1 }],
  ["empty agent", { ...good, agent: "" }],
  ["NaN cost", { ...good, costUsd: NaN }],
  ["Infinity cost", { ...good, costUsd: Infinity }],
  ["non-boolean unpriced", { ...good, unpriced: "false" }],
  ["null record", null],
  ["array record", [good]],
])("rejects %s", (_n, r) => expect(validateBatch({ records: [r] }).ok).toBe(false));
describe("upload bounds", () => {
  const zero = { ...good, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 };
  const ok = (r: object) => expect(validateBatch({ records: [r] }).ok).toBe(true);
  const bad = (r: object) => expect(validateBatch({ records: [r] }).ok).toBe(false);

  test("the limits are the agreed values", () => {
    expect([MAX_TOKENS, MAX_TOTAL_TOKENS, MAX_COST_USD, MAX_AGENT_CHARS, MAX_MODEL_CHARS]).toEqual([1e12, 4e12, 1e7, 64, 128]);
  });
  test.each(["input", "output", "cacheCreate", "cacheRead"])("%s: at most MAX_TOKENS", (k) => {
    ok({ ...zero, [k]: MAX_TOKENS, total: MAX_TOKENS });
    bad({ ...zero, [k]: MAX_TOKENS + 1, total: MAX_TOKENS + 1 });
  });
  test("total: at most MAX_TOTAL_TOKENS, reachable with every field at its cap", () => {
    const all = { input: MAX_TOKENS, output: MAX_TOKENS, cacheCreate: MAX_TOKENS, cacheRead: MAX_TOKENS };
    ok({ ...zero, ...all, total: MAX_TOTAL_TOKENS });
    // A total over the cap is refused even if the fields were somehow consistent with it.
    bad({ ...zero, input: MAX_TOKENS, output: MAX_TOKENS, cacheCreate: MAX_TOKENS, cacheRead: MAX_TOKENS, total: MAX_TOTAL_TOKENS + 1 });
    bad({ ...zero, total: Number.MAX_SAFE_INTEGER });
  });
  test("costUsd: finite, at least 0 and at most MAX_COST_USD", () => {
    ok({ ...good, costUsd: 0 });
    ok({ ...good, costUsd: MAX_COST_USD });
    bad({ ...good, costUsd: MAX_COST_USD + 0.01 });
    bad({ ...good, costUsd: 1e308 });
    bad({ ...good, costUsd: -0.01 });
  });
  test("agent: 1 to MAX_AGENT_CHARS characters", () => {
    ok({ ...good, agent: "a".repeat(MAX_AGENT_CHARS) });
    bad({ ...good, agent: "a".repeat(MAX_AGENT_CHARS + 1) });
    bad({ ...good, agent: "" });
  });
  test("model: 1 to MAX_MODEL_CHARS characters", () => {
    ok({ ...good, model: "m".repeat(MAX_MODEL_CHARS) });
    bad({ ...good, model: "m".repeat(MAX_MODEL_CHARS + 1) });
    bad({ ...good, model: "m".repeat(2 * 1024 * 1024) });
    bad({ ...good, model: "" });
  });
  test.each([0x00, 0x09, 0x0a, 0x1b, 0x1f, 0x7f])("agent and model refuse control character %i", (code) => {
    const c = String.fromCharCode(code);
    bad({ ...good, agent: `cla${c}ude` });
    bad({ ...good, model: `mo${c}del` });
  });
});
test("rejects more than MAX_BATCH", () =>
  expect(validateBatch({ records: Array(MAX_BATCH + 1).fill(good) }).ok).toBe(false));
const throwing = () => { throw new Error("boom"); };
const hostileRecord = Object.defineProperty({ ...good }, "agent", { get: throwing });
const hostileBody = new Proxy({}, { get: throwing, getPrototypeOf: throwing });
test.each([
  ["null", null],
  ["undefined", undefined],
  ["array body", [good]],
  ["missing records", {}],
  ["non-array records", { records: "x" }],
  ["throwing getter on a record", { records: [hostileRecord] }],
  ["throwing proxy body", hostileBody],
])("never throws on %s and returns ok:false", (_n, body) => {
  expect(() => validateBatch(body)).not.toThrow();
  expect(validateBatch(body).ok).toBe(false);
});
test("accepts exactly MAX_BATCH records", () =>
  expect(validateBatch({ records: Array(MAX_BATCH).fill(good) }).ok).toBe(true));
test("drops unknown extra fields", () =>
  expect(validateBatch({ records: [{ ...good, email: "a@b.c", extra: 1 }] })).toEqual({ ok: true, records: [good] }));
test("rejects non-object bodies", () => expect(validateBatch("x").ok).toBe(false));
test("presetRange is inclusive and exactly as long as asked", () => {
  expect(presetRange(30, "2026-11-18")).toEqual({ from: "2026-10-20", to: "2026-11-18" });
  expect(presetRange(90, "2026-03-01").from).toBe("2025-12-02");
});
