import { h } from "../dom.js";
import type { ApiResult } from "../site/http.js";
import { pluralKey } from "../site/plural-key.js";
import { handOver, removeRole, type RoleEntry } from "./api.js";
import type { TeamContext } from "./card.js";
import { openFlow, type Flow } from "./dialog-flow.js";
import { failureText } from "./failure.js";
import { MAX_TEAMS_PER_USER, REFUSALS } from "./roles.js";
import { tt } from "./strings.js";

/** The dialogs that ask before something is done to a person of the team: removing, making the owner, leaving. */

/** What the card does once a dialog's request has been answered. */
export type PersonOutcome = {
  /** The person has no role any more: their row goes. */
  removed(entry: RoleEntry): void;
  /** The server did not find the role, or the person is not an admin any more: the card reads the list again. */
  stale(entry: RoleEntry, why: "gone" | "notAnAdmin"): void;
};

const URL_AFTER_LEAVING = "/teams#all";

const refusedWith = (result: ApiResult<unknown>, status: number, error: string): boolean =>
  result.kind === "refused" && result.status === status && result.error === error;

/** A dialog with its text and one request; `again` sends it, and what is left of an answer is shown in the dialog. */
function ask(ctx: TeamContext, o: { title: string; text: string; confirm: string; busy: string; tone: "primary" | "danger"; opener: HTMLElement; again(flow: Flow): Promise<void> }): void {
  const flow: Flow = openFlow(ctx, {
    title: o.title,
    content: [h(ctx.doc, "p", {}, o.text)],
    confirm: o.confirm,
    busy: o.busy,
    tone: o.tone,
    opener: o.opener,
    onConfirm: () => void o.again(flow),
  });
}

export function askToRemove(ctx: TeamContext, entry: RoleEntry, opener: HTMLElement, outcome: PersonOutcome): void {
  const lang = ctx.lang();
  ask(ctx, {
    title: tt(lang, "removeTitle", { login: entry.login }),
    text: tt(lang, "removeText"),
    confirm: tt(lang, "remove"),
    busy: tt(lang, "removing"),
    tone: "danger",
    opener,
    async again(flow) {
      const result = await flow.send(() => removeRole(ctx.team().id, entry.githubId));
      if (result === null) return;
      if (result.kind === "ok") return done(flow, () => outcome.removed(entry));
      if (refusedWith(result, 404, REFUSALS.roleNotFound)) return done(flow, () => outcome.stale(entry, "gone"));
      flow.fail(failureText(ctx.lang(), result));
    },
  });
}

/** Closes the dialog, then does what the answer changed on the page. */
function done(flow: Flow, then: () => void): void {
  flow.dialog.close();
  then();
}

/** Making an admin the owner; the page then asks the server again (`ctx.reload`), because the viewer's own role is now another one. */
export function askToHandOver(ctx: TeamContext, entry: RoleEntry, opener: HTMLElement, outcome: PersonOutcome): void {
  const lang = ctx.lang();
  ask(ctx, {
    title: tt(lang, "handTitle", { login: entry.login }),
    text: tt(lang, "handText"),
    confirm: tt(lang, "handConfirm"),
    busy: tt(lang, "handing"),
    tone: "primary",
    opener,
    async again(flow) {
      const result = await flow.send(() => handOver(ctx.team().id, entry.githubId));
      if (result === null) return;
      const now = ctx.lang();
      if (result.kind === "ok") return done(flow, () => void ctx.reload());
      if (refusedWith(result, 404, REFUSALS.roleNotFound)) return done(flow, () => outcome.stale(entry, "gone"));
      if (refusedWith(result, 409, REFUSALS.notAnAdmin)) {
        outcome.stale(entry, "notAnAdmin");
        return flow.fail(tt(now, "notAnAdmin", { login: entry.login }));
      }
      if (refusedWith(result, 409, REFUSALS.ownsMost)) {
        return flow.fail(tt(now, pluralKey(now, "ownsMost", MAX_TEAMS_PER_USER), { login: entry.login, n: MAX_TEAMS_PER_USER }));
      }
      flow.fail(failureText(now, result));
    },
  });
}

/** Leaving through the viewer's own row; the team's page is gone for them, so they go to their teams. */
export function askToLeave(ctx: TeamContext, entry: RoleEntry, opener: HTMLElement): void {
  const lang = ctx.lang();
  ask(ctx, {
    title: tt(lang, "leaveTitle", { team: ctx.team().name }),
    text: tt(lang, "leaveText"),
    confirm: tt(lang, "leave"),
    busy: tt(lang, "leaving"),
    tone: "danger",
    opener,
    async again(flow) {
      const result = await flow.send(() => removeRole(ctx.team().id, entry.githubId));
      if (result === null) return;
      // A role that was not found is a role already gone: nothing is left to leave.
      if (result.kind === "ok" || refusedWith(result, 404, REFUSALS.roleNotFound)) return ctx.go(URL_AFTER_LEAVING);
      flow.fail(failureText(ctx.lang(), result));
    },
  });
}
