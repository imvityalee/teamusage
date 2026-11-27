import { afterEach, describe, expect, test } from "vitest";
import { json, nobody, type Page } from "../site/page.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { bootAt, bootTeam, dialogButton, expectNowhereIn, LOGIN, openDialogOf, T, teamInfo, teamReply, typeInto, visible } from "./page.fixture.js";

let page: Page;
afterEach(async () => page?.close());

const urls = () => page.calls.map((c) => c.url);

describe("who sees what", () => {
  test("an owner sees the header, the heading and every card of this task", async () => {
    page = await bootTeam(teamInfo("owner"));
    expect(page.shownViews()).toEqual(["page"]);
    expect(urls()).toEqual(["/api/me", `/api/teams/${T}`]);
    expect(page.$("#team-title").textContent).toBe("Acme Engineering");
    expect(page.doc.title).toBe("Acme Engineering · teamusage");
    for (const sel of ["#code-card", "#invite-card", "#access-card", "#access-change", "#delete-card", "#rename"]) expect(visible(page, sel), sel).toBe(true);
  });

  test("an admin sees no Change… and no Delete team card", async () => {
    page = await bootTeam(teamInfo("admin"));
    expect(page.shownViews()).toEqual(["page"]);
    expect(visible(page, "#access-card")).toBe(true);
    expect(visible(page, "#access-change")).toBe(false);
    expect(visible(page, "#delete-card")).toBe(false);
    expect(visible(page, "#rename")).toBe(true);
  });

  test("the header: the nav to this team's dashboard and page, the login, Your teams and Sign out", async () => {
    page = await bootTeam(teamInfo("admin"));
    const links = [...page.doc.querySelectorAll<HTMLAnchorElement>("#team-nav a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")])).toEqual([
      ["Dashboard", `/dashboard?team=${T}`, null],
      ["Team", `/team?team=${T}`, "page"],
    ]);
    expect(visible(page, "#team-nav")).toBe(true);
    expect(page.$("#login").textContent).toBe(`@${LOGIN}`);
    expect(page.$("#initials").textContent).toBe("AA");
    expect(page.$("#account a").getAttribute("href")).toBe("/teams#all");
    expect(visible(page, "#sign-out")).toBe(true);
  });

  test("a viewer sees that viewers open the dashboard only, with a link to it, and no code is asked", async () => {
    page = await bootTeam(teamInfo("viewer"));
    expect(page.shownViews()).toEqual(["viewer"]);
    expect(page.$("[data-view=viewer] h1").textContent).toBe("Viewers open the dashboard only.");
    expect(page.$("#viewer-dashboard").getAttribute("href")).toBe(`/dashboard?team=${T}`);
    expect(visible(page, "#team-nav")).toBe(false);
    expect(page.$("#cards").childElementCount).toBe(0);
    expect(urls()).toEqual(["/api/me", `/api/teams/${T}`]);
  });

  test.each(["", "?team=ABC", "?team=5a5a5a5a5a5a5a5", `?team=${T}&team=${T}`])("the address %j names no team: notFound, and nothing is asked", async (suffix) => {
    page = await bootAt(suffix);
    expect(page.shownViews()).toEqual(["notFound"]);
    expect(page.$("[data-view=notFound] a").getAttribute("href")).toBe("/teams#all");
    expect(page.calls).toEqual([]);
  });

  test.each([
    ["a 404", json({ error: "team not found" }, 404)],
    ["a 403", json({ error: "your role does not allow this" }, 403)],
  ])("%s for the team: notFound", async (_name, reply) => {
    page = await bootAt(`?team=${T}`, json({ kind: "user", githubId: 7, login: LOGIN, teams: [] }), reply);
    expect(page.shownViews()).toEqual(["notFound"]);
  });

  test.each([
    ["nobody is signed in", nobody(), nobody()],
    ["the team answers 401", json({ kind: "user", githubId: 7, login: LOGIN, teams: [] }), nobody()],
  ])("%s: the sign-in panel with the GitHub button, which comes back to /teams", async (_name, session, team) => {
    page = await bootAt(`?team=${T}`, session, team);
    expect(page.shownViews()).toEqual(["signedOut"]);
    expect(page.$("#sign-in").getAttribute("href")).toBe("/auth/github/start?to=teams");
    expect(visible(page, "#account")).toBe(false);
    expect(visible(page, "#team-nav")).toBe(false);
  });
});

describe("a page that could not open", () => {
  test.each([
    ["the session could not be read", json({ error: "internal" }, 500), teamReply(teamInfo("owner"))],
    ["the team answers 500", json({ kind: "user", githubId: 7, login: LOGIN, teams: [] }), json({ error: "internal" }, 500)],
    ["the network failed", new TypeError("Failed to fetch"), new TypeError("Failed to fetch")],
  ])("%s: the failed panel, and Try again asks again once while its answer is out", async (_name, session, team) => {
    page = await bootAt(`?team=${T}`, session, team, "pending", "pending");
    expect(page.shownViews()).toEqual(["failed"]);
    expect(page.$("#failed-text").textContent).toBe("The server could not be reached.");
    page.press("#retry");
    page.press("#retry");
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(page.$<HTMLButtonElement>("#retry").disabled).toBe(true);
  });

  test("a second failure keeps the panel, with Try again enabled and focused again", async () => {
    page = await bootAt(`?team=${T}`, json({ error: "internal" }, 500), json({ error: "internal" }, 500), json({ error: "x" }, 500), json({}, 500));
    page.press("#retry");
    await page.flush();
    expect(page.shownViews()).toEqual(["failed"]);
    expect(page.$<HTMLButtonElement>("#retry").disabled).toBe(false);
    expect(page.doc.activeElement).toBe(page.$("#retry"));
  });

  test("Try again that works shows the cards", async () => {
    page = await bootAt(`?team=${T}`, new TypeError("x"), new TypeError("x"), json({ kind: "user", githubId: 7, login: LOGIN, teams: [] }), teamReply(teamInfo("owner")));
    page.press("#retry");
    await page.flush();
    expect(page.shownViews()).toEqual(["page"]);
  });

  test("another refusal is said inside the page's own sentence, as text", async () => {
    const evil = `<img src=x onerror="alert(1)">busy`;
    page = await bootAt(`?team=${T}`, json({ kind: "user", githubId: 7, login: LOGIN, teams: [] }), json({ error: evil }, 503));
    expect(page.shownViews()).toEqual(["failed"]);
    expect(page.$("#failed-text").textContent).toBe(`The server refused this request: ${evil}`);
    expect(page.doc.querySelector("img")).toBeNull();
  });
});

describe("the frame", () => {
  test("a worst-case team name and login are drawn whole, as text", async () => {
    page = await bootAt(`?team=${T}`, json({ kind: "user", githubId: 7, login: worstCase.login, teams: [] }), teamReply(teamInfo("owner", { name: worstCase.teamName })));
    expect(page.$("#team-title").textContent).toBe(worstCase.teamName);
    expect(page.$("#login").textContent).toBe(`@${worstCase.login}`);
    expect(page.doc.title).toBe(`${worstCase.teamName} · teamusage`);
  });

  test("the language switch draws the page and its cards again in Russian", async () => {
    page = await bootTeam(teamInfo("owner"));
    page.press("#lang button[data-lang=ru]");
    expect(page.doc.documentElement.lang).toBe("ru");
    expect(page.$("#nav-dashboard").textContent).toBe("Дашборд");
    expect(page.$("#code-card h2").textContent).toBe("Код команды");
    expect(page.$("#delete-card h2").textContent).toBe("Удалить команду");
  });

  test("a sign-out that fails stays, says so and gives focus back; one that works goes home", async () => {
    page = await bootTeam(teamInfo("admin"), json({ error: "internal" }, 500), new Response(null, { status: 204 }));
    page.press("#sign-out");
    await page.flush();
    expect(page.$("#signout-error").textContent).toBe("Could not sign out. Try again.");
    expect(page.$("#signout-error").hidden).toBe(false);
    expect(page.doc.activeElement).toBe(page.$("#sign-out"));
    page.press("#sign-out");
    await page.flush();
    expect(page.assign).toHaveBeenCalledWith("/");
  });
});

describe("a 401 from any card", () => {
  const CODE = "9f8e7d6c5b4a39281706f5e4";
  const field = () => openDialogOf(page)?.querySelector("input") as HTMLInputElement;

  test.each<[string, () => void]>([
    ["Rename", () => (page.press("#rename"), typeInto(page, field(), "Beta"))],
    ["Dashboard access", () => (page.press("#access-change"), (openDialogOf(page)?.querySelector("input[value=admins]") as HTMLInputElement).click())],
    ["Delete", () => (page.press("#delete-open"), typeInto(page, field(), "Acme Engineering"))],
  ])("%s: the shown code leaves the page with the cards", async (_name, openAndFill) => {
    page = await bootTeam(teamInfo("owner"), json({ code: CODE }), nobody());
    page.press("#code-show");
    await page.flush();
    expect(page.$("#code-value").textContent).toBe(CODE);
    openAndFill();
    dialogButton(page, "confirm").click();
    await page.flush();
    expect(page.shownViews()).toEqual(["signedOut"]);
    expect(page.$("#cards").childElementCount).toBe(0);
    expectNowhereIn(page, CODE);
  });
});
