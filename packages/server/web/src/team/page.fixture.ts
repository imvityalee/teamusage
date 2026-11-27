import { bootPage, json, user, type Page, type Reply } from "../site/page.fixture.js";
import type { TeamInfo } from "./api.js";

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
  bootPage({ url: `/team${suffix}`, html: "team.html", load: () => import("./main.js") }, replies);

/** Opens `/team?team=T` for a GitHub user who holds `team`'s role; `replies` answer the requests after the first two. */
export const bootTeam = (team: TeamInfo, ...replies: Reply[]): Promise<Page> =>
  bootAt(`?team=${T}`, user([team], LOGIN), teamReply(team), ...replies);

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
