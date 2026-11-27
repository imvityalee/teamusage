import { afterEach, expect, test } from "vitest";
import { bootDashboard, sent, shown, teamNotFound } from "./dashboard/page.fixture.js";
import { json, member, nobody, user, type Page } from "./site/page.fixture.js";
import { memberStatsFixture, statsFixture } from "./test-fixtures.js";

/** The dashboard's three sources: a self-hosted server at `/`, the demo at `/demo` and a hosted team at `/dashboard`. */

const T = "1111111111111111";
const OTHER = "2222222222222222";
const stats = () => json(statsFixture());
let page: Page | undefined;

afterEach(async () => {
  await page?.close();
  page = undefined;
});

test("self-hosted: one request, the statistics, and no /api/me", async () => {
  page = await bootDashboard("/", stats());
  expect(sent(page)).toEqual([{ path: "/api/stats", team: null, member: null }]);
  expect(shown(page)).toEqual(["filterbar", "stats"]);
});

test("self-hosted: a 401 shows the code form, and nothing else is asked", async () => {
  page = await bootDashboard("/", nobody());
  expect(sent(page).map((c) => c.path)).toEqual(["/api/stats"]);
  expect(shown(page)).toEqual(["login"]);
});

test("the demo asks the demo's statistics, never /api/me, shows the sample chip, and opens a member's page", async () => {
  page = await bootDashboard("/demo", stats(), json(memberStatsFixture()));
  expect(shown(page)).toEqual(["sample", "filterbar", "stats"]);
  await page.goTo("#/member/1");
  expect(sent(page)).toEqual([
    { path: "/api/demo/stats", team: null, member: null },
    { path: "/api/demo/stats", team: null, member: "1" },
  ]);
  expect(page.$("#member-heading").textContent).toBe("Alice Archer");
});

test("/dashboard asks /api/me first; nobody signed in gets the signed-out panel, never the code form", async () => {
  page = await bootDashboard(`/dashboard?team=${T}`, nobody());
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me"]);
  expect(shown(page)).toEqual(["signed-out"]);
  expect(page.$("#signed-out h2").textContent).toBe("Sign in to see this dashboard");
});

test("a member's dashboard: the team's name from the session, statistics without `team`, sign out, no nav", async () => {
  page = await bootDashboard(`/dashboard?team=${OTHER}`, member("Acme Engineering"), stats());
  expect(sent(page)).toEqual([
    { path: "/api/me", team: null, member: null },
    { path: "/api/stats", team: null, member: null },
  ]);
  expect(shown(page)).toEqual(["team-name", "account", "filterbar", "stats"]);
  expect(page.$("#team-name-text").textContent).toBe("Acme Engineering");
  expect(page.$("#account-text").textContent).toBe("Signed in from your agent");
  expect(page.doc.title).toBe("teamusage — Acme Engineering");
});

test("an owner's dashboard asks for the team it names and gets the segmented nav", async () => {
  page = await bootDashboard(`/dashboard?team=${T}`, user([{ id: OTHER, name: "Other", role: "viewer" }, { id: T, name: "Acme", role: "owner" }]), stats());
  expect(sent(page)[1]).toEqual({ path: "/api/stats", team: T, member: null });
  expect(shown(page)).toEqual(["team-name", "team-nav", "account", "filterbar", "stats"]);
  expect(page.$("#account-text").textContent).toBe("@acme-admin");
  expect(page.$("#team-nav a[aria-current=page]").getAttribute("href")).toBe(`/dashboard?team=${T}`);
});

test("a user with one team and no ?team= gets it in the address, without a navigation, before the statistics are asked", async () => {
  page = await bootDashboard("/dashboard#/member/1", user([{ id: T, name: "Acme", role: "viewer" }]), json(memberStatsFixture()));
  expect(page.win.location.pathname + page.win.location.search + page.win.location.hash).toBe(`/dashboard?team=${T}#/member/1`);
  expect(page.replace).not.toHaveBeenCalled();
  expect(page.calls[1]?.href).toBe(`http://localhost:8787/dashboard?team=${T}#/member/1`);
  expect(sent(page)[1]).toEqual({ path: "/api/stats", team: T, member: "1" });
});

test("a user with several teams and no ?team= goes to their teams", async () => {
  page = await bootDashboard("/dashboard", user([{ id: T, name: "Acme", role: "viewer" }, { id: OTHER, name: "Other", role: "owner" }]));
  expect(page.replace).toHaveBeenCalledWith("/teams#all");
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me"]);
});

test("a team that is not theirs shows noTeam and asks nothing more", async () => {
  page = await bootDashboard(`/dashboard?team=${T}`, user([{ id: OTHER, name: "Other", role: "owner" }]));
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me"]);
  expect(shown(page)).toEqual(["signed-out"]);
  expect(page.$("#signed-out h2").textContent).toBe("This team was not found, or you no longer have a role in it.");
  expect(page.$("#signed-out a").getAttribute("href")).toBe("/teams#all");
});

test("a 404 'team not found' from the statistics shows noTeam", async () => {
  page = await bootDashboard(`/dashboard?team=${T}`, user([{ id: T, name: "Acme", role: "owner" }]), teamNotFound());
  expect(shown(page)).toEqual(["signed-out"]);
  expect(page.$("#signed-out a").getAttribute("href")).toBe("/teams#all");
  expect(page.doc.title).toBe("teamusage — team usage");
});

test("a 401 from the statistics at any time shows signed-out, never the code form, and drops the account", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), stats(), nobody());
  page.press('#range button[data-days="30"]');
  await page.flush();
  expect(sent(page).map((c) => c.path)).toEqual(["/api/me", "/api/stats", "/api/stats"]);
  expect(shown(page)).toEqual(["signed-out"]);
  expect(page.$("#signed-out h2").textContent).toBe("Sign in to see this dashboard");
});

test("sign out posts /api/logout once, however often it is pressed, then goes to /", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), stats(), new Response(null, { status: 204 }));
  page.press("#sign-out");
  page.press("#sign-out");
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(page.calls[2]).toMatchObject({ url: "/api/logout", init: { method: "POST", credentials: "same-origin" } });
  await page.flush();
  expect(page.assign).toHaveBeenCalledWith("/");
});

test("a sign-out that fails stays: the button is back with focus, and says so", async () => {
  page = await bootDashboard("/dashboard", member("Acme"), stats(), json({ error: "boom" }, 500));
  page.press("#sign-out");
  await page.flush();
  expect(page.assign).not.toHaveBeenCalled();
  expect(page.$<HTMLButtonElement>("#sign-out").disabled).toBe(false);
  expect(page.doc.activeElement?.id).toBe("sign-out");
  expect(page.$("#signout-error").hidden).toBe(false);
  expect(page.$("#signout-error").textContent).toBe("Could not sign out. Try again.");
  expect(page.$("#signout-error").getAttribute("role")).toBe("alert");
});

test("a language switch rewrites the panel in place: the same element, so it is not announced again", async () => {
  page = await bootDashboard("/dashboard", nobody());
  const panel = page.$("#signed-out [role=alert]");
  page.press('#lang button[data-lang="ru"]');
  expect(page.$("#signed-out [role=alert]")).toBe(panel);
  expect(panel.querySelector("h2")?.textContent).toBe("Войдите, чтобы открыть этот дашборд");
  expect(panel.querySelector('a[href="/open"]')?.textContent).toBe("Откройте дашборд из своего агента.");
  expect(panel.textContent).toContain("Вы участник команды?");
});

test.each([
  ["/dashboard", nobody],
  ["/demo", stats],
])("on %s the brand is a link to /", async (url, reply) => {
  page = await bootDashboard(url, reply());
  const link = page.$("header .brand a");
  expect(link.getAttribute("href")).toBe("/");
  expect(link.textContent).toBe("teamusage");
});

test("on a self-hosted server the brand stays plain text, exactly as before", async () => {
  page = await bootDashboard("/", stats());
  expect(page.$("header .brand").outerHTML).toBe('<h1 class="brand">teamusage</h1>');
});
