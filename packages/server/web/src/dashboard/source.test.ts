import { expect, test } from "vitest";
import { sourceOf, statsUrl } from "./source.js";

const T = "1111111111111111";
const q = new URLSearchParams({ from: "2026-11-01", to: "2026-11-10" });

test.each([
  [{ pathname: "/", search: "" }, { kind: "selfHosted" }],
  [{ pathname: "/index.html", search: "?team=1111111111111111" }, { kind: "selfHosted" }],
  [{ pathname: "/demo", search: "" }, { kind: "demo" }],
  [{ pathname: "/dashboard", search: "" }, { kind: "hosted", team: null }],
  [{ pathname: "/dashboard", search: "?team=1111111111111111" }, { kind: "hosted", team: "1111111111111111" }],
  [{ pathname: "/dashboard", search: "?team=../../x" }, { kind: "hosted", team: null }],
])("sourceOf(%j) is %j", (loc, source) => expect(sourceOf(loc)).toEqual(source));

test("a hosted user's statistics name the team; a member's, the demo's and a self-hosted server's do not", () => {
  expect(statsUrl({ kind: "hosted", team: T }, q)).toBe(`/api/stats?from=2026-11-01&to=2026-11-10&team=${T}`);
  expect(statsUrl({ kind: "hosted", team: null }, q)).toBe("/api/stats?from=2026-11-01&to=2026-11-10");
  expect(statsUrl({ kind: "demo" }, q)).toBe("/api/demo/stats?from=2026-11-01&to=2026-11-10");
  expect(statsUrl({ kind: "selfHosted" }, q)).toBe("/api/stats?from=2026-11-01&to=2026-11-10");
});

test("statsUrl leaves the caller's query as it was", () => {
  const query = new URLSearchParams({ from: "2026-11-01", to: "2026-11-10" });
  statsUrl({ kind: "hosted", team: T }, query);
  expect(query.toString()).toBe("from=2026-11-01&to=2026-11-10");
});
