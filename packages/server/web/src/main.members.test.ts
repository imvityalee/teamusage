import { afterEach, expect, test } from "vitest";
import { team } from "./dashboard/members-panel.fixture.js";
import { bootDashboard } from "./dashboard/page.fixture.js";
import { json, type Page } from "./site/page.fixture.js";

/** The members table's page belongs to the dashboard: a repaint of the same statistics keeps it, new statistics start again at page 1. */

let page: Page | undefined;
afterEach(async () => {
  await page?.close();
  page = undefined;
});

const range = (p: Page) => p.$(".pager-range").textContent;

test("a language switch keeps page 3; new statistics show page 1", async () => {
  page = await bootDashboard("/", json(team(100)), json(team(100)));
  page.press('.pager button[data-step="next"]');
  page.press('.pager button[data-step="next"]');
  expect(range(page)).toBe("51–75 of 100");
  page.press('#lang button[data-lang="ru"]');
  expect(range(page)).toBe("51–75 из 100");
  page.press('#range button[data-days="90"]');
  await page.flush();
  expect(range(page)).toBe("1–25 из 100");
});
