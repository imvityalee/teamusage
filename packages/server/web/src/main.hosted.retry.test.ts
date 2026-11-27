import { afterEach, expect, test, vi } from "vitest";
import { bootDashboard, busy, sent, shown } from "./dashboard/page.fixture.js";
import { json, member, type Page } from "./site/page.fixture.js";
import { statsFixture } from "./test-fixtures.js";

/** What the dashboard does while it cannot have its answer yet: a session it could not read, and a team whose statistics are busy. */

const stats = () => json(statsFixture());
const tiles = (page: Page) => page.doc.querySelectorAll("#stats .tile").length;
let page: Page | undefined;

afterEach(async () => {
  await page?.close();
  page = undefined;
});

test("a session that could not be read shows the error with Retry, asks nothing else, and Retry asks /api/me again", async () => {
  page = await bootDashboard("/dashboard", json({ error: "boom" }, 500), member("Acme"), stats());
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me"]);
  expect(shown(page)).toEqual(["status"]);
  expect(page.$("#status-text").textContent).toBe("Could not reach the server.");
  page.press("#retry");
  await page.flush();
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me", "/api/me", "/api/stats"]);
  expect(shown(page)).toEqual(["team-name", "account", "filterbar", "stats"]);
});

test("a server without /api/me is a session that could not be read too", async () => {
  page = await bootDashboard("/dashboard", json({ error: "not found" }, 404));
  expect(shown(page)).toEqual(["status"]);
  expect(page.$("#login").hidden).toBe(true);
});

test("busy keeps the last view, says when it asks again, asks once after that, and leaves a second busy to Retry", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), stats(), busy(12), busy(12));
  page.press('#range button[data-days="30"]');
  await page.flush();
  expect(tiles(page)).toBe(4);
  expect(page.$("#status-text").textContent).toBe("This team's statistics are busy. Trying again in 12 s.");
  await vi.advanceTimersByTimeAsync(11_999);
  expect(page.calls).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  await page.flush();
  expect(page.calls).toHaveLength(4);
  expect(sent(page)[3]).toEqual(sent(page)[2]);
  expect(page.$("#status-text").textContent).toBe("This team's statistics are still busy. Try again in a minute.");
  await vi.advanceTimersByTimeAsync(600_000);
  expect(page.calls).toHaveLength(4);
  expect(shown(page)).toContain("status");
  expect(tiles(page)).toBe(4);
});

test("a wait longer than a minute is asked again after a minute", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), busy(300), stats());
  expect(page.$("#status-text").textContent).toBe("This team's statistics are busy. Trying again in 60 s.");
  await vi.advanceTimersByTimeAsync(60_000);
  await page.flush();
  expect(page.calls).toHaveLength(3);
  expect(shown(page)).not.toContain("status");
  expect(tiles(page)).toBe(4);
});

test("Russian says the seconds too", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), busy(12));
  page.press('#lang button[data-lang="ru"]');
  expect(page.$("#status-text").textContent).toBe("Статистику команды сейчас запрашивают слишком часто. Попробуем ещё раз через 12 с.");
});

test("a load the person starts while a retry waits replaces it", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), busy(12), stats());
  page.press('#range button[data-days="30"]');
  await page.flush();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(page.calls).toHaveLength(3);
});

test("Retry is disabled while /api/me is out: pressed twice, it asks once", async () => {
  page = await bootDashboard("/dashboard", json({ error: "boom" }, 500), "pending");
  page.press("#retry");
  page.press("#retry");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(page.$<HTMLButtonElement>("#retry").disabled).toBe(true);
});

test("a Retry that fails again gives the button back, enabled and focused", async () => {
  page = await bootDashboard("/dashboard", json({ error: "boom" }, 500), json({ error: "boom" }, 500));
  page.press("#retry");
  await page.flush();
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me", "/api/me"]);
  expect(page.$<HTMLButtonElement>("#retry").disabled).toBe(false);
  expect(page.doc.activeElement?.id).toBe("retry");
});
