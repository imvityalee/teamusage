import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { shortDay } from "../site/day.js";
import type { Invite, RoleEntry, TeamInfo } from "./api.js";
import { actionsFor, initialsOf, type RoleAction } from "./roles.js";
import { tt, type TeamKey } from "./strings.js";

/** The rows of the admins and viewers card (board 3): a person with what the viewer may do to them, and a pending invite. */

type Mine = { githubId: number; role: TeamInfo["role"] };

/** A role named alone, named in a sentence (`lower`), and as the object of "Remove" (`accusative`, which Russian declines). */
const ROLE_NAME: Record<RoleEntry["role"], { name: TeamKey; lower: TeamKey; accusative: TeamKey }> = {
  owner: { name: "roleOwner", lower: "roleOwner", accusative: "roleOwner" },
  admin: { name: "roleAdmin", lower: "roleAdminLower", accusative: "roleAdminAcc" },
  viewer: { name: "roleViewer", lower: "roleViewerLower", accusative: "roleViewerAcc" },
};

const SVG = "http://www.w3.org/2000/svg";
/** The link icon of board 3, drawn in the current colour (the mark's `color` is a token), as the board draws it. */
const LINK_PATH = "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1";

function linkIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute("d", LINK_PATH);
  svg.append(path);
  return svg;
}

/** The action's button: its text, the name a screen reader gets (it holds the visible text and names the person), its look. */
function actionButton(doc: Document, lang: Lang, action: RoleAction, entry: RoleEntry): HTMLButtonElement {
  const vars = { login: entry.login, role: tt(lang, ROLE_NAME[entry.role].accusative) };
  const shape: Record<RoleAction, { text: TeamKey; aria: TeamKey | null; tone: string }> = {
    remove: { text: "remove", aria: "removeAria", tone: "quiet danger" },
    makeOwner: { text: "makeOwner", aria: "makeOwnerAria", tone: "quiet" },
    leave: { text: "leave", aria: null, tone: "quiet danger" },
  };
  const { text, aria, tone } = shape[action];
  const attrs: Record<string, string> = { type: "button", class: `btn ${tone} compact`, "data-action": action };
  if (aria !== null) attrs["aria-label"] = tt(lang, aria, vars);
  return h(doc, "button", attrs, tt(lang, text)) as HTMLButtonElement;
}

/** The mark, the two lines (what the row is, and when), and the side with its buttons: they wrap under the text when narrow. */
function row(doc: Document, attrs: Record<string, string>, mark: HTMLElement, lines: [string, string], side: HTMLElement[]): HTMLElement {
  const text = h(doc, "div", { class: "role-text" }, h(doc, "div", { class: "role-line" }, lines[0]), h(doc, "div", { class: "role-sub" }, lines[1]));
  return h(doc, "li", { class: "role-row", ...attrs }, h(doc, "div", { class: "role-who" }, mark, text), h(doc, "div", { class: "role-side" }, ...side));
}

export type PersonOptions = {
  entry: RoleEntry;
  mine: Mine;
  timeZone: string | undefined;
  onAction(action: RoleAction, entry: RoleEntry, button: HTMLButtonElement): void;
};

/** A person: `@login`, "You" when the GitHub id is the viewer's, the day they came, their role and the actions the viewer may take. */
export function personRow(doc: Document, lang: Lang, o: PersonOptions): HTMLElement {
  const { entry, mine } = o;
  const you = entry.githubId === mine.githubId;
  const date = shortDay(entry.since, lang, o.timeZone);
  const sub = entry.role === "owner" ? (you ? "rowOwnerYou" : "rowOwner") : you ? "rowAddedYou" : "rowAdded";
  const buttons = actionsFor(entry, mine).map((action) => {
    const button = actionButton(doc, lang, action, entry);
    button.addEventListener("click", () => o.onAction(action, entry, button));
    return button;
  });
  const mark = h(doc, "span", { class: "identity-mark", "aria-hidden": "true" }, initialsOf(entry.login));
  const side = [h(doc, "span", { class: "badge" }, tt(lang, ROLE_NAME[entry.role].name)), ...buttons];
  return row(doc, { "data-github-id": String(entry.githubId) }, mark, [`@${entry.login}`, tt(lang, sub, { date })], side);
}

export type PendingOptions = { invite: Invite; timeZone: string | undefined; busy: boolean; onCancel(button: HTMLButtonElement): void };

/** An invite not yet used: its role, when it was made and the day it ends, and "Cancel invite" (disabled while it is being cancelled). */
export function inviteRow(doc: Document, lang: Lang, o: PendingOptions): HTMLElement {
  const { invite } = o;
  const created = shortDay(invite.createdAt, lang, o.timeZone);
  const end = shortDay(invite.expiresAt, lang, o.timeZone);
  const role = tt(lang, ROLE_NAME[invite.role].lower);
  const cancel = h(doc, "button", { type: "button", class: "btn quiet compact", "data-action": "cancelInvite", "aria-label": tt(lang, "cancelInviteAria", { role, end }) }, tt(lang, "cancelInvite")) as HTMLButtonElement;
  cancel.disabled = o.busy;
  cancel.addEventListener("click", () => o.onCancel(cancel));
  const mark = h(doc, "span", { class: "identity-mark pending", "aria-hidden": "true" }, linkIcon(doc));
  const title = tt(lang, invite.role === "admin" ? "pendingAdmin" : "pendingViewer");
  return row(doc, { "data-invite-id": invite.id }, mark, [title, tt(lang, "pendingNote", { created, end })], [cancel]);
}
