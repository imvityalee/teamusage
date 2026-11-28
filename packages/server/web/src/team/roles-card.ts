import { counted, h } from "../dom.js";
import type { Lang } from "../lang.js";
import type { ApiResult } from "../site/http.js";
import { cancelInvite, getInvites, getRoles, isInvite, isRoleEntry, type Invite, type RoleEntry } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { failureText } from "./failure.js";
import { openInviteDialog } from "./invite-dialog.js";
import { askToHandOver, askToLeave, askToRemove, type PersonOutcome } from "./person-dialogs.js";
import { countOf, REFUSALS, sortRoles, type RoleAction } from "./roles.js";
import { inviteRow, personRow } from "./roles-rows.js";
import { tt, type TeamKey } from "./strings.js";

/**
 * The admins and viewers card (board 3): the people of the team, the owner's pending invites and the dialogs that change
 * them. An owner reads both lists; an admin reads only the people, and no request for the invites is made.
 * `viewer` is the GitHub id of the person at the page (the owner's "You" is found by it); `timeZone` is the reader's unless a test says one.
 */

/** What the card says after a change, in a node that stays in the document, so that a screen reader hears it once. */
type Status = { key: TeamKey; vars: Record<string, string> } | null;

/** What went wrong and the card's sentence for it; the server's own text is drawn only inside `failureText`'s sentence. */
type Problem = { key: "rolesLoadFailed" | "cancelInviteFailed"; result: ApiResult<unknown> } | null;

/** An answer that says the caller has no role in this team (any more). */
const lostRole = (result: ApiResult<unknown> | null): boolean => result?.kind === "refused" && (result.status === 403 || result.status === 404);

const isList = <T>(result: ApiResult<unknown>, name: string, guard: (v: unknown) => v is T): T[] | null => {
  const list = result.kind === "ok" ? (result.value as Record<string, unknown> | null)?.[name] : null;
  return Array.isArray(list) && list.every(guard) ? list : null;
};

export function rolesCard(ctx: TeamContext, viewer: number, timeZone?: string): Card {
  const { doc } = ctx;
  const title = h(doc, "h2", { id: "roles-title", tabindex: "-1" });
  const note = h(doc, "p", { class: "card-note" });
  const inviteButton = h(doc, "button", { type: "button", id: "roles-invite", class: "btn quiet compact" }) as HTMLButtonElement;
  const loading = h(doc, "p", { class: "card-note" });
  const error = h(doc, "p", { id: "roles-error", class: "notice warn", role: "alert", hidden: "" });
  const retry = h(doc, "button", { type: "button", id: "roles-retry", class: "btn quiet compact", hidden: "" }) as HTMLButtonElement;
  const list = h(doc, "ul", { id: "roles-list", class: "roles-list" });
  const live = h(doc, "p", { id: "roles-status", class: "sr", role: "status" });
  const element = h(doc, "section", { id: "roles-card", class: "card", "aria-labelledby": "roles-title" },
    h(doc, "div", { class: "card-head" }, h(doc, "div", { class: "card-text" }, title, note), inviteButton),
    loading, error, retry, list, live,
  );

  let roles: RoleEntry[] | null = null;
  let invites: Invite[] = [];
  let problem: Problem = null;
  let status: Status = null;
  /** Counts what the card has said, and what the status node last drew. */
  let statusSerial = 0;
  let spoken: { serial: number; lang: Lang } | null = null;
  /** The invites being cancelled: their buttons stay disabled until the answer. */
  const cancelling = new Set<string>();
  /** Counts the readings of the lists, so that an answer that is no longer the latest is dropped. */
  let reading = 0;

  const isOwner = (): boolean => ctx.team().role === "owner";

  function paintList(): void {
    const lang = ctx.lang();
    const mine = { githubId: viewer, role: ctx.team().role };
    const people = sortRoles(roles ?? []).map((entry) => personRow(doc, lang, { entry, mine, timeZone, onAction }));
    const pending = invites.map((invite) => inviteRow(doc, lang, { invite, timeZone, busy: cancelling.has(invite.id), onCancel: (button) => void cancel(invite, button) }));
    list.replaceChildren(...people, ...pending);
  }

  function paint(): void {
    const lang = ctx.lang();
    title.replaceChildren(...(roles === null ? [tt(lang, "rolesTitle")] : counted(doc, lang, tt(lang, "rolesTitle"), countOf(roles))));
    note.textContent = tt(lang, "rolesNote");
    inviteButton.textContent = tt(lang, "inviteOpen");
    inviteButton.hidden = !isOwner();
    loading.hidden = roles !== null || problem?.key === "rolesLoadFailed";
    loading.textContent = tt(lang, "rolesLoading");
    error.hidden = problem === null;
    error.textContent = problem === null ? "" : `${tt(lang, problem.key)} ${failureText(lang, problem.result)}`;
    retry.hidden = problem?.key !== "rolesLoadFailed";
    retry.textContent = tt(lang, "tryAgain");
    // Written once for each thing said (and again for a language), emptied first so that the same words twice are heard twice.
    if (spoken?.serial !== statusSerial || spoken.lang !== lang) {
      live.textContent = "";
      live.textContent = status === null ? "" : tt(lang, status.key, status.vars);
      spoken = { serial: statusSerial, lang };
    }
    paintList();
  }

  /** Reads the people, and for the owner the invites, together; a 401 is the page's, anything else is told above the list. */
  async function read(): Promise<void> {
    const mine = ++reading;
    const id = ctx.team().id;
    const [people, pending] = await Promise.all([getRoles(id), isOwner() ? getInvites(id) : Promise.resolve(null)]);
    if (mine !== reading) return;
    if ([people, pending].some((r) => r?.kind === "unauthorized")) return ctx.signedOut();
    // A role lost while the page was open: the page asks for its own session and team again, which is where that is told.
    if ([people, pending].some(lostRole)) return void ctx.reload();
    const readPeople = isList(people, "roles", isRoleEntry);
    const readInvites = pending === null ? [] : isList(pending, "invites", isInvite);
    const unread = readPeople === null ? people : readInvites === null ? pending : null;
    problem = unread === null ? null : { key: "rolesLoadFailed", result: unread };
    if (readPeople !== null && readInvites !== null) [roles, invites] = [readPeople, readInvites];
    paint();
  }

  /** Says `key` in the status node. */
  const say = (key: TeamKey, vars: Record<string, string> = {}): void => {
    status = { key, vars };
    statusSerial++;
  };

  /** The list is out of date: say so, and read it again. */
  const stale = (key: TeamKey, vars: Record<string, string> = {}): void => {
    say(key, vars);
    void read();
  };

  const outcome: PersonOutcome = {
    removed(entry) {
      roles = (roles ?? []).filter((r) => r.githubId !== entry.githubId);
      problem = null;
      say("statusRemoved", { login: entry.login });
      paint();
      title.focus();
    },
    // The dialog says why a person is not an admin any more; the card only reads the list again.
    stale: (entry, why) => (why === "gone" ? stale("statusRoleGone", { login: entry.login }) : void read()),
  };

  function onAction(action: RoleAction, entry: RoleEntry, button: HTMLButtonElement): void {
    if (action === "remove") askToRemove(ctx, entry, button, outcome);
    else if (action === "makeOwner") askToHandOver(ctx, entry, button, outcome);
    else askToLeave(ctx, entry, button);
  }

  /** The button of invite `id`, found again after the card was drawn anew. */
  const buttonOf = (id: string) => element.querySelector<HTMLButtonElement>(`[data-invite-id="${id}"] button`);

  async function cancel(invite: Invite, button: HTMLButtonElement): Promise<void> {
    cancelling.add(invite.id);
    button.disabled = true;
    const result = await cancelInvite(ctx.team().id, invite.id);
    cancelling.delete(invite.id);
    if (result.kind === "unauthorized") return ctx.signedOut();
    if (result.kind === "ok") {
      invites = invites.filter((i) => i.id !== invite.id);
      problem = null;
      say("statusInviteCancelled");
      paint();
      return title.focus();
    }
    if (result.kind === "refused" && result.status === 404 && result.error === REFUSALS.inviteNotFound) return stale("statusInviteGone");
    problem = { key: "cancelInviteFailed", result };
    paint();
    buttonOf(invite.id)?.focus();
  }

  inviteButton.addEventListener("click", () =>
    openInviteDialog(ctx, {
      opener: inviteButton,
      onCreated(invite) {
        invites = [...invites, invite];
        say("statusInviteCreated");
        paint();
      },
    }),
  );
  retry.addEventListener("click", () => void read());
  paint();
  void read();
  return { element, paint };
}
