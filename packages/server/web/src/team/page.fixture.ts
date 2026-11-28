import type { Window } from "happy-dom";
import { expect, vi } from "vitest";
import { bootPage, json, user, type Call, type Page, type Reply } from "../site/page.fixture.js";
import type { TeamInfo } from "./api.js";
import { membersReply } from "./members-card.fixture.js";
import { noon, TODAY, team as someMembers } from "./members.fixture.js";
import { listReplies } from "./roles.fixture.js";

/** Opens `/team` in happy-dom for the page's tests (tests only). */

export const T = "5a5a5a5a5a5a5a5a";
export const LOGIN = "acme-admin";

export const teamInfo = (role: TeamInfo["role"], over: Partial<TeamInfo> = {}): TeamInfo => ({
  id: T,
  name: "Acme Engineering",
  role,
  dashboardAccess: "members",
  ...over,
});

export const teamReply = (team: TeamInfo) => json({ team });

/** Opens `/team<suffix>` and answers each request with the next reply, the session's first. */
export const bootAt = (suffix: string, ...replies: Reply[]): Promise<Page> =>
  bootPage({ url: `/team${suffix}`, html: "team.html", load: () => import("./main.js"), prepare: onFixtureDay }, replies);

/** The page's clock reads noon of the fixture's `TODAY`, so no test of the page depends on the day it runs. `page.close()` puts the real clock back. */
const onFixtureDay = (): void => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: new Date(noon(TODAY)) });
};

/** The answers the members card gets when the page opens: a small team, one member not syncing. */
export const memberReplies = () => [membersReply(someMembers(3, 1))];

/** How many requests opening the page sends for someone of `role`: the session, the team, the roles, for the owner the invites, and the members. */
export const loadRequests = (role: TeamInfo["role"]): number => 2 + listReplies(role).length + memberReplies().length;

/**
 * Opens `/team?team=T` for a GitHub user who holds `team`'s role. The roles card's two lists and the members card's list are
 * answered as a small team's; `replies` answer the requests after them.
 */
export const bootTeam = (team: TeamInfo, ...replies: Reply[]): Promise<Page> =>
  bootAt(`?team=${T}`, user([team], LOGIN), teamReply(team), ...(team.role === "viewer" ? [] : [...listReplies(team.role), ...memberReplies()]), ...replies);

/** The dialog on screen, or null. */
export const openDialogOf = (page: Page) => page.doc.querySelector<HTMLDialogElement>("dialog[open]");

/** A button of the open dialog: `confirm` or `cancel`. */
export const dialogButton = (page: Page, action: "confirm" | "cancel") =>
  page.doc.querySelector<HTMLButtonElement>(`dialog[open] [data-action="${action}"]`) as HTMLButtonElement;

/** Types `value` into `input` as a person would: the value, then an `input` event. */
export function typeInto(page: Page, input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new page.win.Event("input", { bubbles: true }) as unknown as Event);
}

/** Escape on the open dialog, as a browser reports it. */
export function pressEscape(page: Page): Event {
  const event = new page.win.Event("cancel", { cancelable: true }) as unknown as Event;
  openDialogOf(page)?.dispatchEvent(event);
  return event;
}

export const visible = (page: Page, sel: string) => {
  const el = page.doc.querySelector<HTMLElement>(sel);
  return el !== null && !el.hidden && el.closest("[hidden]") === null;
};

/**
 * Fails if `secret` is anywhere a page may not put it: an attribute, the document (unless `inText`: the page's own
 * text while it is shown), the title, the address, a cookie, either storage, the console, a request's address or body.
 */
export function expectNowhereIn(where: { doc: Document; win: Window; logged: unknown[][]; calls: Call[] }, secret: string, inText = false): void {
  const { doc, win } = where;
  const attributes = [...doc.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => a.value));
  expect(attributes.join(" ")).not.toContain(secret);
  if (!inText) expect(doc.documentElement.outerHTML).not.toContain(secret);
  expect(doc.title).not.toContain(secret);
  expect(win.location.href).not.toContain(secret);
  expect(doc.cookie).not.toContain(secret);
  const stored = (s: Storage) => Array.from({ length: s.length }, (_, n) => `${s.key(n)}=${s.getItem(s.key(n) ?? "")}`).join(" ");
  expect(stored(win.localStorage as unknown as Storage)).not.toContain(secret);
  expect(stored(win.sessionStorage as unknown as Storage)).not.toContain(secret);
  expect(JSON.stringify(where.logged)).not.toContain(secret);
  expect(where.calls.map((c) => `${c.url} ${String(c.init.body ?? "")}`).join(" ")).not.toContain(secret);
}
