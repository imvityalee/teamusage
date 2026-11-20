import { expect, test } from "vitest";
import { ApiError } from "./api.js";
import { readReport } from "./report.js";

const answer = (over: Record<string, unknown> = {}) => ({
  from: "2026-10-20",
  to: "2026-11-18",
  totals: { tokens: 10, costUsd: 0.5 },
  members: [{ name: "Ann", email: "ann@example.com", tokens: 10, costUsd: 0.5, extra: "dropped" }],
  models: [{ agent: "claude", model: "opus", input: 1, output: 2, cacheCreate: 3, cacheRead: 4, total: 10, costUsd: 0.5, unpriced: false }],
  ...over,
});

test("keeps only the fields the client uses", () => {
  expect(readReport(answer())).toEqual({
    from: "2026-10-20",
    to: "2026-11-18",
    totals: { tokens: 10, costUsd: 0.5 },
    members: [{ name: "Ann", email: "ann@example.com", tokens: 10, costUsd: 0.5 }],
    models: [{ agent: "claude", model: "opus", input: 1, output: 2, cacheCreate: 3, cacheRead: 4, total: 10, costUsd: 0.5, unpriced: false }],
  });
});

test("an answer without real dates, a totals object and member and model lists is refused with the fixed message", () => {
  for (const bad of [
    null,
    [],
    answer({ from: "2026-02-30" }),
    answer({ to: "\u001b[2J2026-11-18" }),
    answer({ totals: null }),
    answer({ members: {} }),
    answer({ models: "x" }),
  ]) {
    expect(() => readReport(bad), JSON.stringify(bad)).toThrow(new ApiError(200, "the server sent an unexpected response"));
  }
});

test("numbers that are not finite become 0, strings are cleaned and entries that are not objects are dropped", () => {
  const r = readReport(
    answer({
      totals: { tokens: "10", costUsd: Number.POSITIVE_INFINITY },
      members: [null, 5, { name: "Ann\u001b[31m\n", email: 7, tokens: Number.NaN }],
      models: [{ agent: "a‮b", model: "m", total: -1, unpriced: "yes" }],
    }),
  );
  expect(r.totals).toEqual({ tokens: 0, costUsd: 0 });
  expect(r.members).toEqual([{ name: "Ann[31m", email: "7", tokens: 0, costUsd: 0 }]);
  expect(r.models[0]).toMatchObject({ agent: "ab", total: -1, input: 0, unpriced: false });
});
