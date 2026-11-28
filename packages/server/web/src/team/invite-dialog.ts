import { h } from "../dom.js";
import { choiceList } from "../site/choice-list.js";
import { copyWith } from "../site/copy.js";
import { dialogActions, openDialog, uniqueId } from "../site/dialog.js";
import type { ApiResult } from "../site/http.js";
import { MAX_ADMINS_AND_VIEWERS } from "../site/limits.js";
import { pluralKey } from "../site/plural-key.js";
import { createInvite, isInvite, type Invite } from "./api.js";
import type { TeamContext } from "./card.js";
import { failureText } from "./failure.js";
import { INVITE_DAYS, inviteLink, MAX_PENDING_INVITES, REFUSALS } from "./roles.js";
import { tt } from "./strings.js";

/**
 * The owner's "Invite…" dialog. First a choice of the two roles, neither chosen, and "Create link"; then the same dialog
 * shows the link, once. The link is a secret: it is in the dialog's code box and in this function's one variable, and
 * closing the dialog empties both before the dialog leaves the page.
 */

const TEAM_FULL = `this team has reached its limit of ${MAX_ADMINS_AND_VIEWERS} admins and viewers`;

/** The dialog's own sentence for a refusal of the invite, or the page's sentence around the server's text. */
function refusalText(ctx: TeamContext, result: ApiResult<unknown>): string {
  const lang = ctx.lang();
  if (result.kind === "refused" && result.status === 409) {
    if (result.error === REFUSALS.pendingFull) return tt(lang, pluralKey(lang, "pendingFull", MAX_PENDING_INVITES), { n: MAX_PENDING_INVITES });
    if (result.error === TEAM_FULL) return tt(lang, pluralKey(lang, "teamFull", MAX_ADMINS_AND_VIEWERS), { n: MAX_ADMINS_AND_VIEWERS });
  }
  return failureText(lang, result);
}

const isCreated = (v: unknown): v is { invite: Invite; token: string } =>
  typeof (v as { token?: unknown } | null)?.token === "string" && isInvite((v as { invite?: unknown }).invite);

export function openInviteDialog(ctx: TeamContext, o: { opener: HTMLElement; onCreated(invite: Invite): void }): void {
  const { doc } = ctx;
  const lang = ctx.lang();
  let link: string | null = null;
  let busy = false;

  const roles = choiceList(doc, {
    name: uniqueId("invite-role"),
    current: null,
    choices: [
      { value: "admin", title: tt(lang, "inviteRoleAdmin"), lines: [tt(lang, "inviteRoleAdminText")] },
      { value: "viewer", title: tt(lang, "inviteRoleViewer"), lines: [tt(lang, "inviteRoleViewerText")] },
    ],
  });
  const error = h(doc, "p", { class: "notice warn dialog-error", role: "alert", hidden: "" });
  const secondary = h(doc, "button", { type: "button", class: "btn quiet compact", "data-action": "cancel" }, tt(lang, "cancel")) as HTMLButtonElement;
  const primary = h(doc, "button", { type: "submit", class: "btn primary compact", "data-action": "confirm" }, tt(lang, "createLink")) as HTMLButtonElement;
  const form = h(doc, "form", { class: "dialog-form", novalidate: "" }, roles.element, error, dialogActions(doc, secondary, primary));
  primary.disabled = true;

  const dialog = openDialog(doc, {
    title: tt(lang, "inviteDialogTitle"),
    content: [form],
    opener: o.opener,
    // The link leaves the dialog as it closes, not when the closing motion ends.
    onClose() {
      link = null;
      form.replaceChildren();
    },
  });

  function say(text: string | null): void {
    error.hidden = text === null;
    error.textContent = text ?? "";
  }

  function setBusy(next: boolean): void {
    busy = next;
    dialog.setBusy(next);
    secondary.disabled = next;
    primary.disabled = next || (link === null && roles.chosen() === null);
    primary.textContent = tt(lang, next ? "creatingLink" : link === null ? "createLink" : "copyLink");
  }

  /** The second step: the link in a code box, one press to copy it, and what to know about it. */
  function showLink(text: string): void {
    link = text;
    secondary.textContent = tt(lang, "done");
    primary.textContent = tt(lang, "copyLink");
    const note = tt(lang, pluralKey(lang, "linkNote", INVITE_DAYS), { n: INVITE_DAYS });
    form.replaceChildren(h(doc, "p", {}, tt(lang, "linkNow")), h(doc, "code", { class: "code" }, text), h(doc, "p", { class: "small" }, note), error, dialogActions(doc, secondary, primary));
    primary.focus();
  }

  async function create(): Promise<void> {
    const role = roles.chosen();
    if (busy || role === null) return;
    say(null);
    setBusy(true);
    const result = await createInvite(ctx.team().id, role);
    setBusy(false);
    if (result.kind === "unauthorized") {
      dialog.close();
      return ctx.signedOut();
    }
    if (result.kind !== "ok" || !isCreated(result.value)) {
      say(refusalText(ctx, result));
      return primary.focus();
    }
    o.onCreated(result.value.invite);
    showLink(inviteLink(location.origin, result.value.token));
  }

  async function copy(): Promise<void> {
    if (link === null) return;
    say((await copyWith(primary, link, tt(lang, "copied"))) ? null : tt(lang, "copyLinkFailed"));
  }

  roles.element.addEventListener("change", () => (primary.disabled = roles.chosen() === null));
  secondary.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (link === null ? create() : copy());
  });
}
