import { afterEach, describe, expect, test } from "vitest";
import { bootDashboard } from "../dashboard/page.fixture.js";
import { bootTeam, teamInfo } from "../team/page.fixture.js";
import { boot as bootTeams } from "../teams/page.fixture.js";
import { statsFixture } from "../test-fixtures.js";
import { bootPage, json, member, user, type Page } from "./page.fixture.js";

/**
 * A page that can show a team's numbers, a team's name or a person's login is loaded again when the browser restores it
 * from its back-forward cache, so Back after "Sign out" never shows what it held. The demo shows nothing private.
 */

const TOKEN = "fedcba9876543210".repeat(4);
const stats = () => json(statsFixture());

const signedInPages: [string, () => Promise<Page>][] = [
  ["the self-hosted dashboard", () => bootDashboard("/", stats())],
  ["a hosted team's dashboard", () => bootDashboard("/dashboard", member("Acme"), stats())],
  ["the team page", () => bootTeam(teamInfo("owner"))],
  ["the teams page", () => bootTeams("", user([{ id: "1111111111111111", name: "Acme", role: "owner" }]))],
  ["/open asking a GitHub user", () => bootPage({ url: `/open#${TOKEN}`, html: "open.html", load: () => import("../open/main.js") }, [user([], "bob")])],
  [
    "/invite naming the team",
    () =>
      bootPage({ url: `/invite#${TOKEN}`, html: "invite.html", load: () => import("../invite/main.js") }, [
        json({ team: { name: "Acme" }, role: "admin", expiresAt: "2026-12-04T12:00:00.000Z" }),
        user([], "aigerim-t"),
      ]),
  ],
];

let page: Page | undefined;
afterEach(async () => {
  await page?.close();
  page = undefined;
});

describe.each(signedInPages)("%s", (_name, open) => {
  test("restored from the back-forward cache, it loads again, once", async () => {
    page = await open();
    page.pageshow(true);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  test("shown on a normal load, it stays", async () => {
    page = await open();
    page.pageshow(false);
    expect(page.reload).not.toHaveBeenCalled();
  });
});

test("the demo stays when restored: it shows nothing private", async () => {
  page = await bootDashboard("/demo", stats());
  page.pageshow(true);
  expect(page.reload).not.toHaveBeenCalled();
});
