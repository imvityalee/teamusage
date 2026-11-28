import { afterEach, describe, expect, test } from "vitest";
import { bootDashboard, shown, teamNotFound } from "./dashboard/page.fixture.js";
import { json, member, nobody, user, type Page } from "./site/page.fixture.js";
import { memberStatsFixture, statsFixture } from "./test-fixtures.js";

/** What the dashboard leaves in the document when the person is no longer allowed to see it: no member, no number. */

const T = "1111111111111111";
const NAMES = ["Alice Archer", "Bao Nguyen", "Carla Mendes"];
let page: Page | undefined;

afterEach(async () => {
  await page?.close();
  page = undefined;
});

/** Fails if any member's name is anywhere in the document: text, attributes or the title. */
function expectNoMemberIn(html: string): void {
  for (const name of NAMES) expect(html).not.toContain(name);
}

const html = (p: Page) => p.doc.documentElement.outerHTML;

describe("signing out", () => {
  test.each([
    ["the team's view", "/dashboard", statsFixture()],
    ["a member's page", "/dashboard#/member/1", memberStatsFixture()],
  ])("from %s: when the browser is sent home, the statistics and the member's name are already off the page", async (_name, url, answer) => {
    page = await bootDashboard(url, member("Acme"), json(answer), new Response(null, { status: 204 }));
    expect(html(page)).toContain("Alice Archer");
    let atNavigation = "";
    page.assign.mockImplementation(() => (atNavigation = html(page as Page)));
    page.press("#sign-out");
    await page.flush();
    expect(page.assign).toHaveBeenCalledExactlyOnceWith("/");
    expectNoMemberIn(atNavigation);
    expect(page.$("#stats").childElementCount).toBe(0);
    expect(page.$("#page-head").childElementCount).toBe(0);
  });
});

describe("a session or a role lost while the page is open", () => {
  test.each([
    ["a hosted team's 401", "/dashboard", member("Acme"), nobody(), "signed-out"],
    ["a lost role (404 team not found)", `/dashboard?team=${T}`, user([{ id: T, name: "Acme", role: "owner" }]), teamNotFound(), "signed-out"],
  ])("%s takes the statistics off the page with the panel", async (_name, url, session, answer, panel) => {
    page = await bootDashboard(url, session, json(statsFixture()), answer);
    page.press('#range button[data-days="30"]');
    await page.flush();
    expect(shown(page)).toEqual([panel]);
    expectNoMemberIn(html(page));
    expect(page.$("#stats").childElementCount).toBe(0);
  });

  test("a self-hosted 401 shows the code form with nothing of the team left behind it", async () => {
    page = await bootDashboard("/", json(statsFixture()), nobody());
    page.press('#range button[data-days="30"]');
    await page.flush();
    expect(shown(page)).toEqual(["login"]);
    expectNoMemberIn(html(page));
  });
});
