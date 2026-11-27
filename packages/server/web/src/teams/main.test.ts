import { afterEach, describe, expect, test, vi } from "vitest";
import { SIGN_IN_PATH } from "../site/session.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { boot, json, member, nobody, user, type Page } from "./page.fixture.js";
import { strings } from "./strings.js";

const OWNER = { id: "1111111111111111", name: "Acme", role: "owner" as const };
const VIEWER = { id: "2222222222222222", name: "Zed", role: "viewer" as const };
const ADMIN = { id: "4444444444444444", name: "Beta", role: "admin" as const };

let page: Page;
afterEach(async () => page?.close());

describe("who is asking", () => {
  test("nobody sees the sign-in panel with the GitHub button, and nothing else is asked", async () => {
    page = await boot("", nobody());
    expect(page.shownViews()).toEqual(["signedOut"]);
    expect(page.$<HTMLAnchorElement>("#sign-in").getAttribute("href")).toBe(SIGN_IN_PATH);
    expect(page.$("#signin-notice").hidden).toBe(true);
    expect(page.$("#account").hidden).toBe(true);
    expect(page.calls.map((c) => c.url)).toEqual(["/api/me"]);
  });

  test("?error=signin shows the notice and takes the flag out of the address; the fragment stays", async () => {
    page = await boot("?error=signin#new", nobody());
    expect(page.$("#signin-notice").hidden).toBe(false);
    expect(page.$("#signin-notice").textContent).toBe(strings.en.signinFailed);
    expect(page.win.location.href).toBe("http://localhost:8787/teams#new");
  });

  test("a signed-in person is not shown the notice", async () => {
    page = await boot("?error=signin", user([OWNER, VIEWER]));
    expect(page.shownViews()).toEqual(["list"]);
    expect(page.$("#signin-notice").hidden).toBe(true);
  });

  test("a member's session sees whose member it is, with the dashboard and GitHub links", async () => {
    page = await boot("", member(worstCase.teamName));
    expect(page.shownViews()).toEqual(["member"]);
    expect(page.$("#member-text").textContent).toBe(`This browser is signed in as a member of ${worstCase.teamName}.`);
    expect(page.$<HTMLAnchorElement>("#member-dashboard").getAttribute("href")).toBe("/dashboard");
    expect(page.$<HTMLAnchorElement>("#member-sign-in").getAttribute("href")).toBe(SIGN_IN_PATH);
    expect(page.$("#account").hidden).toBe(true);
  });

  test.each([
    ["a 500", json({ error: "internal error" }, 500)],
    ["a server with no accounts", new Response("not found", { status: 404 })],
    ["a network error", new TypeError("Failed to fetch")],
  ])("%s shows the page's own sentence, never the sign-in panel, and Try again asks again", async (_what, reply) => {
    page = await boot("", reply, user([OWNER, VIEWER]));
    expect(page.shownViews()).toEqual(["failed"]);
    expect(page.$("#failed-text").textContent).toBe("The server could not be reached.");
    expect(page.calls).toHaveLength(1);
    page.press("#retry");
    await page.flush();
    expect(page.calls.map((c) => c.url)).toEqual(["/api/me", "/api/me"]);
    expect(page.shownViews()).toEqual(["list"]);
  });

  test("when the server fails again, focus stays on Try again instead of falling to the page", async () => {
    page = await boot("", json({ error: "internal error" }, 500), new TypeError("Failed to fetch"));
    page.$("#retry").focus();
    // A browser drops focus from a control that is hidden; happy-dom does not, so the call itself is what is asserted.
    const focus = vi.spyOn(page.$("#retry"), "focus");
    page.press("#retry");
    await page.flush();
    expect(page.shownViews()).toEqual(["failed"]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(page.doc.activeElement).toBe(page.$("#retry"));
  });
});

describe("one team", () => {
  test.each([
    ["an owner", OWNER, "/team?team=1111111111111111"],
    ["an admin", ADMIN, "/team?team=4444444444444444"],
    ["a viewer", VIEWER, "/dashboard?team=2222222222222222"],
  ])("%s is moved on with replace, so Back does not bounce them forward again", async (_who, team, path) => {
    page = await boot("", user([team]));
    expect(page.replace).toHaveBeenCalledExactlyOnceWith(path);
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.shownViews()).toEqual(["loading"]);
  });

  test("#all shows the list, #new the form", async () => {
    page = await boot("#all", user([OWNER]));
    expect(page.shownViews()).toEqual(["list"]);
    expect(page.replace).not.toHaveBeenCalled();
    await page.goTo("#new");
    expect(page.shownViews()).toEqual(["create"]);
  });

  test("no team shows the form", async () => {
    page = await boot("", user([]));
    expect(page.shownViews()).toEqual(["create"]);
    expect(page.$("#back-to-teams").hidden).toBe(true);
  });
});

describe("the list", () => {
  const rows = () => Array.from(page.doc.querySelectorAll<HTMLElement>("#team-list li"));
  const linksOf = (row: HTMLElement) => Array.from(row.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")]);

  test("rows are sorted by name; an owner and an admin get two links, a viewer only the dashboard", async () => {
    page = await boot("", user([VIEWER, ADMIN, OWNER]));
    expect(rows().map((r) => r.querySelector(".team-name")?.textContent)).toEqual(["Acme", "Beta", "Zed"]);
    expect(linksOf(rows()[0] as HTMLElement)).toEqual([["Team page", "/team?team=1111111111111111"], ["Dashboard", "/dashboard?team=1111111111111111"]]);
    expect(linksOf(rows()[1] as HTMLElement)).toHaveLength(2);
    expect(linksOf(rows()[2] as HTMLElement)).toEqual([["Dashboard", "/dashboard?team=2222222222222222"]]);
    expect(rows().map((r) => r.querySelector(".badge")?.textContent)).toEqual(["Owner", "Admin", "Viewer"]);
  });

  test("a 60-character Cyrillic team name is drawn whole, as text", async () => {
    page = await boot("", user([{ ...OWNER, name: worstCase.teamName }, VIEWER]));
    expect(rows().map((r) => r.querySelector(".team-name")?.textContent)).toContain(worstCase.teamName);
  });

  test("a name is never a link's address and never markup", async () => {
    const name = '<img src=x onerror="alert(1)"> ../team?team=1111111111111111';
    page = await boot("", user([{ ...OWNER, name }, VIEWER]));
    expect(page.doc.querySelector("#team-list img")).toBeNull();
    const hrefs = Array.from(page.doc.querySelectorAll("#team-list a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/team?team=1111111111111111", "/dashboard?team=1111111111111111", "/dashboard?team=2222222222222222"]);
  });

  test("a team whose id is not an id is not drawn, and nothing throws", async () => {
    page = await boot("", user([{ ...OWNER, id: "../x" }, VIEWER, ADMIN]));
    expect(rows().map((r) => r.querySelector(".team-name")?.textContent)).toEqual(["Beta", "Zed"]);
  });

  test("the count line reads 'You own 1 of 5 teams.' and Create a team opens the form without a reload", async () => {
    page = await boot("", user([OWNER, VIEWER]));
    expect(page.$("#owned-line").textContent).toBe("You own 1 of 5 teams.");
    expect(page.$<HTMLAnchorElement>("#create-link").getAttribute("href")).toBe("#new");
    expect(page.$("#create-link").hidden).toBe(false);
    await page.goTo("#new");
    expect(page.shownViews()).toEqual(["create"]);
    expect(page.$("#back-to-teams").hidden).toBe(false);
    await page.goTo("#all");
    expect(page.shownViews()).toEqual(["list"]);
    expect(page.calls).toHaveLength(1);
  });

  test("at five owned teams the link is gone and the line says so", async () => {
    const five = [1, 2, 3, 4, 5].map((n) => ({ id: `${n}`.repeat(16), name: `T${n}`, role: "owner" as const }));
    page = await boot("", user(five));
    expect(page.$("#create-link").hidden).toBe(true);
    expect(page.$("#owned-line").textContent).toBe("You own 5 teams, the most one account can.");
  });

  test("an account of viewers and admins owns none", async () => {
    page = await boot("", user([VIEWER, ADMIN]));
    expect(page.$("#owned-line").textContent).toBe("You own 0 of 5 teams.");
  });
});

describe("the header", () => {
  test("shows the login and its initials; Sign out ends the session and goes to the landing page", async () => {
    page = await boot("", user([OWNER, VIEWER], worstCase.login), json({}, 200));
    expect(page.$("#account").hidden).toBe(false);
    expect(page.$("#login").textContent).toBe(`@${worstCase.login}`);
    expect(page.$("#initials").textContent).toBe("MK");
    page.press("#sign-out");
    await page.flush();
    expect(page.calls.map((c) => [c.init.method, c.url])).toEqual([["GET", "/api/me"], ["POST", "/api/logout"]]);
    expect(page.assign).toHaveBeenCalledExactlyOnceWith("/");
  });

  test("a double press sends one POST /api/logout, and the button is busy until the answer", async () => {
    page = await boot("", user([OWNER, VIEWER]), "pending");
    page.press("#sign-out");
    page.press("#sign-out");
    await page.flush();
    expect(page.calls.filter((c) => c.url === "/api/logout")).toHaveLength(1);
    expect(page.$<HTMLButtonElement>("#sign-out").disabled).toBe(true);
    expect(page.$("#sign-out").getAttribute("aria-busy")).toBe("true");
  });

  test.each([
    ["a network error", new TypeError("Failed to fetch")],
    ["a 500", json({ error: "internal error" }, 500)],
    ["a refusal", json({ error: "forbidden" }, 403)],
  ])("%s keeps the person here: the button works again with focus, and a sentence says it did not happen", async (_what, reply) => {
    page = await boot("", user([OWNER, VIEWER]), reply, json({}, 200));
    expect(page.$("#signout-error").hidden).toBe(true);
    page.press("#sign-out");
    await page.flush();
    expect(page.assign).not.toHaveBeenCalled();
    expect(page.$<HTMLButtonElement>("#sign-out").disabled).toBe(false);
    expect(page.$("#sign-out").getAttribute("aria-busy")).toBe("false");
    expect(page.doc.activeElement).toBe(page.$("#sign-out"));
    expect(page.$("#signout-error").hidden).toBe(false);
    expect(page.$("#signout-error").textContent).toBe("Could not sign out. Try again.");
    page.press('#lang [data-lang="ru"]');
    expect(page.$("#signout-error").textContent).toBe(strings.ru.signOutFailed);
    page.press("#sign-out");
    await page.flush();
    expect(page.assign).toHaveBeenCalledExactlyOnceWith("/");
    expect(page.$("#signout-error").hidden).toBe(true);
  });
});

describe("language", () => {
  test("a switch redraws the list, the count line and the roles in Russian", async () => {
    page = await boot("", user([OWNER, VIEWER]));
    page.press('#lang [data-lang="ru"]');
    expect(page.doc.documentElement.lang).toBe("ru");
    expect(page.doc.title).toBe(strings.ru.title);
    expect(page.$("#owned-line").textContent).toBe("Вы владеете 1 из 5 возможных команд.");
    expect(Array.from(page.doc.querySelectorAll("#team-list .badge")).map((b) => b.textContent)).toEqual(["Владелец", "Наблюдатель"]);
    expect(page.shownViews()).toEqual(["list"]);
  });
});
