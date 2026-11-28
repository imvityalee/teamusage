import type { Lang } from "../lang.js";
import type { Reply } from "../site/page.fixture.js";
import type { TeamInfo } from "./api.js";
import type { Card } from "./card.js";
import { cardWorld, type World } from "./card.fixture.js";
import { ME } from "./roles.fixture.js";
import { rolesCard } from "./roles-card.js";
import { teamInfo } from "./page.fixture.js";

/** The admins and viewers card on its own, in happy-dom, for the card's tests (tests only). The card's dates are drawn in UTC. */

export type Mounted = { world: World; card: Card; $: <E extends HTMLElement = HTMLElement>(sel: string) => E; all: (sel: string) => HTMLElement[] };

/** Draws the card for someone of `role` and lets its first requests run; `replies` answer them in order. */
export async function mountRoles(role: TeamInfo["role"], replies: Reply[], o: { lang?: Lang; viewer?: number; clipboardItem?: boolean; refuseClipboard?: boolean } = {}): Promise<Mounted> {
  const world = cardWorld(teamInfo(role), replies, o);
  const card = rolesCard(world.ctx, o.viewer ?? ME, "UTC");
  world.doc.body.append(card.element);
  await world.flush();
  return {
    world,
    card,
    $: <E extends HTMLElement = HTMLElement>(sel: string) => world.doc.querySelector(sel) as E,
    all: (sel) => [...world.doc.querySelectorAll<HTMLElement>(sel)],
  };
}

/** The logins of the card's rows, in the order drawn. */
export const loginsIn = (m: Mounted): string[] => m.all(".role-row .role-line").map((el) => el.textContent ?? "");

/** The person's row, by GitHub id. */
export const rowOf = (m: Mounted, githubId: number): HTMLElement => m.$(`[data-github-id="${githubId}"]`);

/** A button of a row, by its action. */
export const actionIn = (row: HTMLElement, action: string): HTMLButtonElement => row.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;

/** The open dialog, or null, and its confirm or cancel button. */
export const dialogOf = (m: Mounted) => m.world.doc.querySelector<HTMLDialogElement>("dialog[open]");
export const dialogButton = (m: Mounted, action: "confirm" | "cancel") => m.$<HTMLButtonElement>(`dialog[open] [data-action="${action}"]`);
export const dialogError = (m: Mounted) => m.$("dialog[open] .dialog-error");

/** The requests the card sent, as `METHOD path`. */
export const sentBy = (m: Mounted): string[] => m.world.calls.map((c) => `${c.init.method} ${c.url}`);
