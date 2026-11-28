import { expect, test } from "vitest";
import { render } from "./render.fixture.js";
import { statsFixture } from "./test-fixtures.js";

const withCost = (costUsd: number) => {
  const stats = statsFixture();
  return render({ ...stats, totals: { ...stats.totals, costUsd } });
};
const costTile = (root: Element) => root.querySelectorAll(".tile")[1]!;

test("a cost of ten characters keeps half a row; a longer one marks its tile long", () => {
  expect(costTile(withCost(12_345.67)).querySelector(".v")?.textContent).toBe("$12,345.67");
  expect(costTile(withCost(12_345.67)).classList.contains("long")).toBe(false);
  expect(costTile(withCost(123_456.78)).classList.contains("long")).toBe(true);
  expect(costTile(withCost(10_057_230.67)).classList.contains("long")).toBe(true);
});

test("only the cost's tile is marked", () => {
  const root = withCost(10_057_230.67);
  expect([...root.querySelectorAll(".tile.long")]).toEqual([costTile(root)]);
});
