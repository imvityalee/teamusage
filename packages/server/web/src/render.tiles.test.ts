import type { Stats } from "@teamusage/shared";
import { expect, test } from "vitest";
import { newDocument, render, TODAY } from "./render.fixture.js";
import { renderMember } from "./render.js";
import { statsFixture } from "./test-fixtures.js";

const withCostStats = (costUsd: number): Stats => {
  const stats = statsFixture();
  return { ...stats, totals: { ...stats.totals, costUsd } };
};
const withCost = (costUsd: number) => render(withCostStats(costUsd));
const memberWithCost = (costUsd: number) => {
  const doc = newDocument();
  const host = doc.createElement("div");
  host.append(renderMember(doc, withCostStats(costUsd), 1, "en", TODAY));
  return host;
};
const costTile = (root: Element) => root.querySelectorAll(".tile")[1]!;
const chars = (el: Element) => (el as HTMLElement).style.getPropertyValue("--chars");

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

test.each([
  ["the team view", withCost],
  ["a member's page", memberWithCost],
])("on %s the cost's tile carries `cost` and the length of its figure as --chars", (_, draw) => {
  for (const [costUsd, figure] of [
    [1_158.84, "$1,158.84"],
    [12_345.67, "$12,345.67"],
    [10_057_230.67, "$10,057,230.67"],
  ] as const) {
    const tile = costTile(draw(costUsd));
    expect(tile.querySelector(".v")?.textContent).toBe(figure);
    expect(tile.classList.contains("cost")).toBe(true);
    expect(chars(tile)).toBe(String(figure.length));
  }
});

test.each([
  ["the team view", withCost],
  ["a member's page", memberWithCost],
])("on %s no other tile has the class or the property", (_, draw) => {
  const root = draw(10_057_230.67);
  const others = [...root.querySelectorAll(".tile")].filter((el) => el !== costTile(root));
  expect(others).toHaveLength(3);
  for (const el of others) {
    expect(el.classList.contains("cost")).toBe(false);
    expect(chars(el)).toBe("");
  }
});
