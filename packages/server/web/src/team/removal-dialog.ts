import { h, icon } from "../dom.js";
import type { Lang } from "../lang.js";
import { copyWith } from "../site/copy.js";
import { dialogActions, openDialog } from "../site/dialog.js";
import { removeFromTeam } from "./api.js";
import { removalBody, removalOutcome, removalSummary, removedText, targetKind, type RemovalDone, type RemovalOutcome, type RemovalTarget, type TargetKind } from "./removal.js";
import { tt, type TeamKey } from "./strings.js";

/**
 * The removal dialog. Board 11 asks, with "Replace the team code" ticked each time it opens; while the request is out
 * nothing closes it. Done with a new code it becomes board 12, which shows the code once and only "Done" closes; done
 * without, it closes. A removal that stopped (board 13) keeps it open with "Run it again", or after a 403 only "Close".
 * The new code is in the dialog's code box and in this function's one variable, and both are emptied as it closes;
 * nothing outside the dialog receives it.
 */

type Done = Extract<RemovalOutcome, { kind: "done" }>;
type Stopped = Extract<RemovalOutcome, { kind: "stopped" }>;

export type RemovalOptions = {
  /** The team's checked public id. */
  team: string;
  target: RemovalTarget;
  lang: Lang;
  /** A local ISO date: the day the last sync is counted to. */
  today: string;
  /** What Cancel and Close give focus back to. */
  opener: HTMLElement | null;
  /** What focus goes to after a removal, or when the opener has left the page with its row. */
  refocus: HTMLElement | null;
  /** The removal finished: the counts, and whether the code was replaced. */
  onDone(outcome: RemovalDone): void;
  /** A request that asked for a new code has answered, whatever the answer: a code shown elsewhere may no longer work. */
  onCodeAsked(): void;
  /** A 401: the dialog has closed. */
  onSignedOut(): void;
  /** The dialog that told of a lost role or access (a 403 or a 404) has closed. */
  onRoleLost(): void;
};

/** The texts that change with what is removed. */
const WORDS: Record<TargetKind, { body: TeamKey; replace: TeamKey; confirm: TeamKey; kept: TeamKey }> = {
  one: { body: "removeBodyOne", replace: "removeReplaceOne", confirm: "removeConfirmOne", kept: "stoppedKeptMember" },
  several: { body: "removeBodySeveral", replace: "removeReplaceSeveral", confirm: "removeConfirmSeveral", kept: "stoppedKeptMembers" },
  machine: { body: "removeBodyMachine", replace: "removeReplaceMachine", confirm: "removeMachine", kept: "stoppedKeptMachine" },
};

/** What is deleted: one member's machine, their machines when they have more, or only their history when they have none. */
function bodyKey(target: RemovalTarget, kind: TargetKind): TeamKey {
  const machines = target.members[0]?.machines.length;
  if (kind !== "one" || machines === 1) return WORDS[kind].body;
  return machines === 0 ? "removeBodyOneNone" : "removeBodyOneMachines";
}

/** The last sentence of board 13: what was lost, after which only "Close" is offered, or "Run it again to finish". */
const LAST_LINE: Record<"role" | "access" | "none", TeamKey> = { role: "roleGone", access: "accessGone", none: "stoppedRunAgain" };

/** The first sentence of board 12: who or what was removed. */
function doneSentence(lang: Lang, target: RemovalTarget, kind: TargetKind, outcome: Done): string {
  if (kind === "one") return tt(lang, "doneOne", { name: target.members[0]!.name });
  if (kind === "machine") return tt(lang, "doneMachine", { label: target.machines[0]!.machine.label });
  return removedText(lang, outcome.removed, target);
}

export function openRemoval(doc: Document, o: RemovalOptions): void {
  const { lang, target } = o;
  const kind = targetKind(target);
  const say = (key: TeamKey, vars?: Record<string, string>) => tt(lang, key, vars);
  const summary = removalSummary(target, lang, o.today);
  let label = say(WORDS[kind].confirm);
  let busy = false;
  let finished = false;
  /** A 403 or 404 was told: closing has the page read the role again. */
  let lost = false;
  /** An answer of this dialog may have come after the removal finished: no later stop claims the members or the code unchanged. */
  let unsure = false;
  /** The new code while board 12 shows it. */
  let code: string | null = null;

  const box = h(doc, "input", { type: "checkbox" }) as HTMLInputElement;
  box.checked = true;
  const tick = h(doc, "label", { class: "option" }, box,
    h(doc, "span", { class: "option-text" }, h(doc, "span", { class: "option-title" }, say("removeReplaceCode")), h(doc, "span", { class: "small" }, say(WORDS[kind].replace))),
  );
  const detail = h(doc, "p", { class: "small removal-detail" }, summary.detail);
  const body = h(doc, "p", {}, say(bodyKey(target, kind)));
  const alert = h(doc, "div", { class: "notice warn removal-alert", role: "alert", hidden: "" });
  const cancel = h(doc, "button", { type: "button", class: "btn quiet compact", "data-action": "cancel", autofocus: "" }, say("cancel")) as HTMLButtonElement;
  const confirm = h(doc, "button", { type: "submit", class: "btn danger compact", "data-action": "confirm" }, label) as HTMLButtonElement;
  const form = h(doc, "form", { class: "dialog-form", novalidate: "" }, body, alert, tick, dialogActions(doc, cancel, confirm));

  const dialog = openDialog(doc, {
    title: summary.title,
    content: [detail, form],
    opener: null,
    // The code leaves with the dialog's content as it starts to close, not when its closing motion ends.
    onClose() {
      code = null;
      form.replaceChildren();
      if (lost) o.onRoleLost();
      const back = finished || !o.opener?.isConnected ? o.refocus : o.opener;
      if (back?.isConnected) back.focus();
    },
  });

  /** Says `lines` in the alert, as new nodes, so that the same words twice are heard twice. */
  function tell(...lines: Node[]): void {
    alert.replaceChildren(...lines);
    alert.hidden = lines.length === 0;
  }

  function setBusy(next: boolean): void {
    busy = next;
    dialog.setBusy(next);
    confirm.disabled = cancel.disabled = box.disabled = next;
    confirm.textContent = next ? say("removing") : label;
  }

  async function send(): Promise<void> {
    if (busy || code !== null) return;
    const request = removalBody(target, box.checked);
    setBusy(true);
    const outcome = removalOutcome(await removeFromTeam(o.team, request));
    setBusy(false);
    if (request.rotateCode) o.onCodeAsked();
    answer(outcome);
  }

  function answer(outcome: RemovalOutcome): void {
    switch (outcome.kind) {
      case "done":
        finished = true;
        o.onDone({ kind: "done", removed: outcome.removed, replaced: outcome.code !== null });
        return outcome.code === null ? dialog.close() : showCode(outcome, outcome.code);
      case "signedOut":
        dialog.close();
        return o.onSignedOut();
      case "notSent": {
        const refusal = outcome.error === null ? [] : [say(outcome.error === "" ? "refusedBare" : "refusedText", { error: outcome.error })];
        tell(h(doc, "p", {}, [say("notSent"), ...refusal].join(" ")));
        return confirm.focus();
      }
      case "stopped":
        return stopped(outcome);
    }
  }

  /** Board 13: what may be gone, and "Run it again", or after a 403 or a 404 only "Close". */
  function stopped(outcome: Stopped): void {
    unsure ||= !outcome.codeKept;
    body.hidden = true;
    const text = [say(unsure ? "stoppedUnsure" : WORDS[kind].kept), say(LAST_LINE[outcome.lost ?? "none"])].join(" ");
    tell(h(doc, "p", { class: "alert-title" }, say("stoppedTitle")), h(doc, "p", {}, text));
    cancel.textContent = say("close");
    if (outcome.lost !== null) {
      lost = true;
      confirm.hidden = tick.hidden = true;
      return cancel.focus();
    }
    label = say("runAgain");
    confirm.textContent = label;
    confirm.focus();
  }

  /** Board 12: the new code, once, with "Copy code"; from now on only "Done" closes the dialog. */
  function showCode(outcome: Done, next: string): void {
    code = next;
    dialog.holdOpen();
    const heading = dialog.element.querySelector("h2") as HTMLElement;
    heading.textContent = say("newCodeTitle");
    heading.before(h(doc, "span", { class: "badge good" }, icon(doc, "check"), say("removedBadge")));
    detail.remove();
    const copy = h(doc, "button", { type: "button", class: "btn quiet compact" }, say("copyCode")) as HTMLButtonElement;
    const done = h(doc, "button", { type: "button", class: "btn primary compact", "data-action": "cancel" }, say("done")) as HTMLButtonElement;
    copy.addEventListener("click", () => void copyCode(copy));
    done.addEventListener("click", () => dialog.close());
    tell();
    form.replaceChildren(
      h(doc, "p", {}, `${doneSentence(lang, target, kind, outcome)} ${say("newCodeText")}`),
      h(doc, "div", { class: "code-row" }, h(doc, "code", { class: "code", "aria-label": say("newCodeAria") }, next), copy),
      h(doc, "p", { class: "small" }, say("newCodeNote")),
      alert,
      dialogActions(doc, done),
    );
    copy.focus();
  }

  /** The code is in hand: the clipboard write starts inside the press. */
  async function copyCode(button: HTMLButtonElement): Promise<void> {
    if (code === null) return;
    if (await copyWith(button, code, say("copied"))) tell();
    else tell(h(doc, "p", {}, say("copyNewCodeFailed")));
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void send();
  });
  cancel.addEventListener("click", () => dialog.close());
}
