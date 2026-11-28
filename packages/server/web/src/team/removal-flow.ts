import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import type { TeamContext } from "./card.js";
import type { CodeCard } from "./code-card.js";
import type { MembersCard } from "./members-card.js";
import { openRemoval } from "./removal-dialog.js";
import { removedText, type RemovalOutcome, type RemovalTarget } from "./removal.js";

/**
 * What the team page does around a removal: opens the dialog for the members card's buttons and, once a removal is done,
 * hides the code card (which then holds no code and asks the server at the next "Show"), clears the ticks, reads the
 * list again and says in the status line above the table what went.
 */

export type RemovalFlow = {
  /** The status line, which the members card puts above its table: one node that stays, written anew for each removal. */
  status: HTMLElement;
  /** What the members card's "Remove", "Remove machine" and "Remove selected…" call. */
  open(target: RemovalTarget, opener: HTMLElement): void;
  /** Draws the status line again in the page's language. */
  paint(): void;
};

type Done = Extract<RemovalOutcome, { kind: "done" }>;

export function removalFlow(ctx: TeamContext, o: { today(): string; members(): MembersCard | null; code(): CodeCard | null }): RemovalFlow {
  const status = h(ctx.doc, "p", { id: "removal-status", class: "removal-status", role: "status" });
  let last: { removed: Done["removed"]; target: RemovalTarget } | null = null;
  let serial = 0;
  let spoken: { serial: number; lang: Lang } | null = null;

  /** Written once for each removal (and again for a language), emptied first so that the same words twice are heard twice. */
  function paint(): void {
    const lang = ctx.lang();
    if (spoken?.serial === serial && spoken.lang === lang) return;
    status.textContent = "";
    status.textContent = last === null ? "" : removedText(lang, last.removed, last.target);
    spoken = { serial, lang };
  }

  async function done(outcome: Done, target: RemovalTarget): Promise<void> {
    if (outcome.code !== null) o.code()?.hide();
    last = { removed: outcome.removed, target };
    serial++;
    paint();
    const members = o.members();
    members?.clearTicks();
    await members?.reload();
  }

  function open(target: RemovalTarget, opener: HTMLElement): void {
    openRemoval(ctx.doc, {
      team: ctx.team().id,
      target,
      lang: ctx.lang(),
      today: o.today(),
      opener,
      refocus: ctx.doc.getElementById("members-title"),
      onDone: (outcome) => void done(outcome, target),
      onSignedOut: ctx.signedOut,
      onRoleLost: () => void ctx.reload(),
    });
  }

  return { status, open, paint };
}
