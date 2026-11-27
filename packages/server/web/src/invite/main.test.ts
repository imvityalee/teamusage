import { afterEach, describe, expect, test, vi } from "vitest";
import { bootPage, json, nobody, user, type Page, type Reply } from "../site/page.fixture.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { expiryDay } from "./answers.js";
import { INVITE_KEY } from "./invite.js";
import { strings } from "./strings.js";

const TOKEN = "fedcba9876543210".repeat(4);
const DAY = "2026-12-04T12:00:00.000Z";
const ADDRESS = "http://localhost:8787/invite";
const preview = (role: "admin" | "viewer" = "admin", name = "Acme Engineering") => json({ team: { name }, role, expiresAt: DAY });
const accepted = (role: "admin" | "viewer") =>
  json({ team: { id: "2222222222222222", name: "Acme Engineering", role, dashboardAccess: "members" } });
const refused = (status: number, error: string) => json({ error }, status);
const aigerim = () => user([], "aigerim-t");
const signedOut = () => new Response(null, { status: 204 });

let page: Page;
afterEach(async () => page?.close());

/** Opens `/invite<suffix>` with `stored` already in the tab's storage, as on the way back from GitHub. */
function boot(suffix: string, replies: Reply[], stored?: string): Promise<Page> {
  const prepare = (win: Page["win"]) => {
    if (stored !== undefined) win.sessionStorage.setItem(INVITE_KEY, stored);
  };
  return bootPage({ url: `/invite${suffix}`, html: "invite.html", load: () => import("./main.js"), prepare }, replies);
}

const stored = () => page.win.sessionStorage.getItem(INVITE_KEY);
const fetched = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

/** Fails if the token is anywhere a page may not put it: the markup (text and attributes), the title, the address, a cookie, localStorage, the console, a request's address. */
function expectTokenHidden(): void {
  const { doc, win } = page;
  expect(doc.documentElement.outerHTML).not.toContain(TOKEN);
  expect(doc.title).not.toContain(TOKEN);
  expect(win.location.href).not.toContain(TOKEN);
  expect(doc.cookie).not.toContain(TOKEN);
  const local = Array.from({ length: win.localStorage.length }, (_, n) => `${win.localStorage.key(n)}=${win.localStorage.getItem(win.localStorage.key(n) ?? "")}`);
  expect(local.join(" ")).not.toContain(TOKEN);
  expect(JSON.stringify(page.logged)).not.toContain(TOKEN);
  expect(page.calls.map((c) => c.url).join(" ")).not.toContain(TOKEN);
}

describe("the address", () => {
  test("with a token in the fragment the address is /invite before the first request, and the token waits in the tab", async () => {
    page = await boot(`#${TOKEN}`, [preview(), nobody()]);
    expect(page.calls[0]?.href).toBe(ADDRESS);
    expect(page.win.location.href).toBe(ADDRESS);
    expect(page.calls[0]?.url).toBe("/api/invites/preview");
    expect(JSON.parse(String(page.calls[0]?.init.body))).toEqual({ token: TOKEN });
    expect(stored()).toBe(TOKEN);
  });

  test("?error=signin shows the notice of a sign-in that did not finish, and leaves the address before any request", async () => {
    page = await boot(`?error=signin#${TOKEN}`, [preview(), nobody()]);
    expect(page.calls[0]?.href).toBe(ADDRESS);
    expect(page.shownViews()).toEqual(["signIn"]);
    expect(page.$("#signin-notice").hidden).toBe(false);
    expect(page.$("#signin-notice").textContent).toBe("Sign-in did not finish. Try again.");
  });

  test("the token is in no text, attribute, title, cookie, localStorage, console line or request address", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), refused(409, "this team has reached its limit of 50 admins and viewers")]);
    expectTokenHidden();
    page.press("#accept");
    await page.flush();
    expect(page.shownViews()).toEqual(["teamFull"]);
    expectTokenHidden();
  });

  test("no token: the page says what it is for and asks nothing", async () => {
    page = await boot("", []);
    expect(page.shownViews()).toEqual(["none"]);
    expect(page.calls).toEqual([]);
  });
});

describe("before accepting", () => {
  test("someone signed out sees board 9: the GitHub button is a link back to this page's sign-in", async () => {
    page = await boot(`#${TOKEN}`, [preview(), nobody()]);
    expect(page.shownViews()).toEqual(["signIn"]);
    expect(page.$("#sign-in").tagName).toBe("A");
    expect(page.$("#sign-in").getAttribute("href")).toBe("/auth/github/start?to=invite");
    expect(page.$("#signin-notice").hidden).toBe(true);
    expect(page.$("#switch-line").hidden).toBe(true);
    // The day is drawn in the machine's zone, like the page's; answers.test.ts pins its format in a given zone.
    expect(page.$("#expiry-note").textContent).toBe(
      `The invitation works once and until ${expiryDay(DAY, "en")}. Signing in gives teamusage no access to your repositories or your email.`,
    );
  });

  test("returning from GitHub, nothing is accepted until the press", async () => {
    page = await boot("", [preview(), aigerim()], TOKEN);
    expect(page.shownViews()).toEqual(["accept"]);
    expect(page.calls.map((c) => c.url)).toEqual(["/api/invites/preview", "/api/me"]);
    expect(page.replace).not.toHaveBeenCalled();
  });

  test("board 10's button holds the whole login, and the heading the whole team name", async () => {
    page = await boot(`#${TOKEN}`, [preview("admin", worstCase.teamName), user([], worstCase.login)]);
    expect(page.$("#accept").textContent).toBe(`Accept as @${worstCase.login}`);
    expect(page.$("#login").textContent).toBe(`@${worstCase.login}`);
    expect(page.$("#initials").textContent).toBe("MK");
    expect(page.$("#invite-title").textContent).toBe(`Join ${worstCase.teamName} as an admin`);
  });

  test.each([
    ["admin", "Join Acme Engineering as an admin", strings.en.roleAdmin, "Станьте администратором команды Acme Engineering", strings.ru.roleAdmin],
    ["viewer", "Join Acme Engineering as a viewer", strings.en.roleViewer, "Станьте наблюдателем команды Acme Engineering", strings.ru.roleViewer],
  ] as const)("an invitation for the role %s says what the role can do, in both languages", async (role, title, note, ruTitle, ruNote) => {
    page = await boot(`#${TOKEN}`, [preview(role), aigerim()]);
    expect(page.$("#invite-title").textContent).toBe(title);
    expect(page.$("#role-note").textContent).toBe(note);
    page.press('#lang [data-lang="ru"]');
    expect(page.$("#invite-title").textContent).toBe(ruTitle);
    expect(page.$("#role-note").textContent).toBe(ruNote);
    expect(page.$("#accept").textContent).toBe("Принять как @aigerim-t");
  });

  test("the viewer's note is the one the brief gives", () => {
    expect(strings.en.roleViewer).toBe("Viewers open the dashboard. They do not see the team page and cannot change anything.");
  });

  test("the last day follows the language", async () => {
    page = await boot(`#${TOKEN}`, [preview(), nobody()]);
    page.press('#lang [data-lang="ru"]');
    expect(page.$("#expiry-note").textContent).toBe(
      `До ${expiryDay(DAY, "ru")} приглашение можно использовать один раз. Вход не даёт teamusage доступа к вашим репозиториям и почте.`,
    );
  });
});

describe("accepting", () => {
  test("a double press of Accept sends one request, and the buttons wait", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), "pending"]);
    page.press("#accept");
    page.press("#accept");
    expect(fetched()).toHaveBeenCalledTimes(3);
    await page.flush();
    expect(fetched()).toHaveBeenCalledTimes(3);
    expect(page.$<HTMLButtonElement>("#accept").disabled).toBe(true);
    expect(page.$("#accept").getAttribute("aria-busy")).toBe("true");
    expect(page.$<HTMLButtonElement>("#use-another").disabled).toBe(true);
  });

  test.each([
    ["an admin", "admin", "/team?team=2222222222222222"],
    ["a viewer", "viewer", "/dashboard?team=2222222222222222"],
  ] as const)("%s's accepted invitation is forgotten and the browser moves on with replace", async (_who, role, path) => {
    page = await boot(`#${TOKEN}`, [preview(role), aigerim(), accepted(role)]);
    page.press("#accept");
    await page.flush();
    expect(page.calls.at(-1)?.url).toBe("/api/invites/accept");
    expect(JSON.parse(String(page.calls.at(-1)?.init.body))).toEqual({ token: TOKEN });
    expect(stored()).toBeNull();
    expect(page.replace).toHaveBeenCalledExactlyOnceWith(path);
  });

  test("an account that already has a role is told so, with a way to its teams, and the token is forgotten", async () => {
    page = await boot(`#${TOKEN}`, [preview("admin", worstCase.teamName), aigerim(), refused(409, "you already have a role in this team")]);
    page.press("#accept");
    await page.flush();
    expect(page.shownViews()).toEqual(["hasRole"]);
    expect(page.$("#has-role-text").textContent).toBe(`@aigerim-t already has a role in ${worstCase.teamName}, so the invitation was not used.`);
    expect(page.$("#open-teams").getAttribute("href")).toBe("/teams#all");
    expect(stored()).toBeNull();
  });

  test("a full team keeps the token, so the link can be opened again", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), refused(409, "this team has reached its limit of 50 admins and viewers")]);
    page.press("#accept");
    await page.flush();
    expect(page.shownViews()).toEqual(["teamFull"]);
    expect(stored()).toBe(TOKEN);
  });

  test("an invitation that no longer works is forgotten", async () => {
    page = await boot(`#${TOKEN}`, [refused(404, "this invite is no longer valid")]);
    expect(page.shownViews()).toEqual(["notValid"]);
    expect(stored()).toBeNull();
  });

  test("when the server fails again, focus stays on Try again", async () => {
    page = await boot(`#${TOKEN}`, [json({ error: "internal error" }, 500), new TypeError("Failed to fetch"), preview(), aigerim()]);
    expect(page.shownViews()).toEqual(["failed"]);
    const focus = vi.spyOn(page.$("#retry"), "focus");
    page.press("#retry");
    await page.flush();
    expect(page.shownViews()).toEqual(["failed"]);
    expect(focus).toHaveBeenCalledTimes(1);
    page.press("#retry");
    await page.flush();
    expect(page.shownViews()).toEqual(["accept"]);
    expect(page.calls.map((c) => c.url)).not.toContain("/api/invites/accept");
  });
});

describe("another account", () => {
  test("pressing Use another account signs out and shows the sign-in with the line about github.com", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), signedOut()]);
    page.press("#use-another");
    await page.flush();
    expect(page.calls.map((c) => [c.init.method, c.url])).toEqual([["POST", "/api/invites/preview"], ["GET", "/api/me"], ["POST", "/api/logout"]]);
    expect(page.shownViews()).toEqual(["signIn"]);
    expect(page.$("#switch-line").hidden).toBe(false);
    expect(page.$("#switch-line").textContent).toBe("To use another account, switch accounts on github.com first, then continue.");
    expect(page.doc.activeElement).toBe(page.$("#sign-in"));
    expect(stored()).toBe(TOKEN);
  });

  test("a sign-out that did not happen keeps the person here, says so, and gives the button back with focus", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), json({ error: "internal error" }, 500)]);
    page.press("#use-another");
    await page.flush();
    expect(page.shownViews()).toEqual(["accept"]);
    expect(page.$("#signout-error").hidden).toBe(false);
    expect(page.$("#signout-error").textContent).toBe("Could not sign out. Try again.");
    expect(page.$<HTMLButtonElement>("#use-another").disabled).toBe(false);
    expect(page.doc.activeElement).toBe(page.$("#use-another"));
    page.press('#lang [data-lang="ru"]');
    expect(page.$("#signout-error").textContent).toBe("Не удалось выйти. Попробуйте ещё раз.");
  });
});

describe("after a press that did not accept", () => {
  test.each([
    ["hasRole", [refused(409, "you already have a role in this team")], "#open-teams"],
    ["teamFull", [refused(409, "this team has reached its limit of 50 admins and viewers")], '[data-view="teamFull"] h1'],
    ["notValid", [refused(404, "this invite is no longer valid")], '[data-view="notValid"] h1'],
    ["failed", [new TypeError("Failed to fetch")], "#retry"],
    ["signIn", [nobody()], "#sign-in"],
  ] as const)("%s takes focus to its action, or to its heading", async (view, answer, target) => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), ...answer]);
    // A browser drops focus from a control that is hidden; happy-dom does not, so the call itself is what is asserted.
    const focus = vi.spyOn(page.$(target), "focus");
    page.press("#accept");
    await page.flush();
    expect(page.shownViews()).toEqual([view]);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test("a heading that takes focus is focusable from script only", async () => {
    page = await boot("", []);
    for (const view of ["notValid", "teamFull"]) expect(page.$(`[data-view="${view}"] h1`).getAttribute("tabindex")).toBe("-1");
  });
});

describe("the sentence of a failure", () => {
  const failedText = () => page.$("#failed-text").textContent;
  const failedSection = () => page.$('[data-view="failed"]').textContent?.replace(/\s+/g, " ").trim();

  test("a refusal is named in the page's own sentence, and nothing else of the answer is shown", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), json({ error: "cross-site request refused", detail: "x-origin" }, 403)]);
    page.press("#accept");
    await page.flush();
    expect(page.shownViews()).toEqual(["failed"]);
    expect(failedText()).toBe("The server refused this invitation: cross-site request refused");
    expect(failedSection()).toBe("Could not open the invitation The server refused this invitation: cross-site request refused Try again");
    page.press('#lang [data-lang="ru"]');
    expect(failedText()).toBe("Сервер отклонил приглашение: cross-site request refused");
  });

  test("markup in a refusal is drawn as text", async () => {
    page = await boot(`#${TOKEN}`, [preview(), aigerim(), refused(403, "<b>no</b>")]);
    page.press("#accept");
    await page.flush();
    expect(page.doc.querySelector('[data-view="failed"] b')).toBeNull();
    expect(failedText()).toBe("The server refused this invitation: <b>no</b>");
  });

  test.each([
    ["a refusal with no text of its own", new Response("Forbidden", { status: 403 }), "The server refused this invitation.", "Сервер отклонил приглашение."],
    ["a 500", json({ error: "internal error" }, 500), "The server could not be reached.", "Не удалось связаться с сервером."],
    ["a network error", new TypeError("Failed to fetch"), "The server could not be reached.", "Не удалось связаться с сервером."],
    ["a preview it cannot read", json({ team: { name: "Acme" }, role: "owner", expiresAt: DAY }), "The server's answer could not be read.", "Не удалось прочитать ответ сервера."],
  ])("%s has its own sentence", async (_what, reply, en, ru) => {
    page = await boot(`#${TOKEN}`, [reply]);
    expect(page.shownViews()).toEqual(["failed"]);
    expect(failedText()).toBe(en);
    page.press('#lang [data-lang="ru"]');
    expect(failedText()).toBe(ru);
  });
});
