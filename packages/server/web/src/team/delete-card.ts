import { h } from "../dom.js";
import { uniqueId } from "../site/dialog.js";
import type { ApiResult } from "../site/http.js";
import { deleteTeam } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { openFlow, type Flow } from "./dialog-flow.js";
import { failureText } from "./failure.js";
import { namesMatch } from "./settings.js";
import { tt } from "./strings.js";

/**
 * The "Delete team" card, which only the owner sees. Its dialog asks for the team's name; the server answers only once
 * the deletion is finished, which takes seconds for a large team, and one that stopped midway can be run again.
 */

/** The server's refusal of a name that is not the team's (`src/routes-team-settings.ts`, which a test compares). */
export const NAME_DOES_NOT_MATCH = "the name does not match";

/** Where the person goes once the team is deleted. */
const YOUR_TEAMS = "/teams#all";

/** An answer that may come after part of the usage was deleted: a 403 (the role went midway), a 5xx or the network. */
const stoppedMidway = (result: ApiResult<unknown>): boolean =>
  result.kind === "failed" || result.kind === "network" || (result.kind === "refused" && result.status === 403);

export function deleteCard(ctx: TeamContext): Card {
  const { doc } = ctx;
  const title = h(doc, "h2", { id: "delete-title" });
  const text = h(doc, "p", { class: "card-note" });
  const open = h(doc, "button", { type: "button", id: "delete-open", class: "btn quiet danger compact" }) as HTMLButtonElement;
  const element = h(doc, "section", { id: "delete-card", class: "card", "aria-labelledby": "delete-title" },
    h(doc, "div", { class: "card-head" }, h(doc, "div", { class: "card-text" }, title, text), open),
  );

  function paint(): void {
    const lang = ctx.lang();
    element.hidden = ctx.team().role !== "owner";
    title.textContent = tt(lang, "deleteTitle");
    text.textContent = tt(lang, "deleteText");
    open.textContent = tt(lang, "deleteOpen");
  }

  async function remove(flow: Flow, typed: string, name: string): Promise<void> {
    const lang = ctx.lang();
    const result = await flow.send(() => deleteTeam(ctx.team().id, typed.trim().normalize("NFC")));
    if (result === null) return;
    if (result.kind === "ok") return ctx.go(YOUR_TEAMS);
    flow.confirm.disabled = !namesMatch(typed, name);
    if (result.kind === "refused" && result.status === 400 && result.error === NAME_DOES_NOT_MATCH) return flow.fail(tt(lang, "nameMismatch"));
    if (stoppedMidway(result)) return flow.fail(tt(lang, "deleteStopped"), tt(lang, "runAgain"));
    flow.fail(failureText(lang, result));
  }

  function askToDelete(): void {
    const lang = ctx.lang();
    const name = ctx.team().name;
    const id = uniqueId("delete-name");
    const input = h(doc, "input", { id, type: "text", autocomplete: "off", spellcheck: "false", autofocus: "" }) as HTMLInputElement;
    const flow: Flow = openFlow(ctx, {
      title: tt(lang, "deleteDialogTitle", { team: name }),
      content: [h(doc, "p", {}, tt(lang, "deleteDialogText")), h(doc, "div", { class: "field" }, h(doc, "label", { for: id }, tt(lang, "nameLabel")), input)],
      confirm: tt(lang, "deleteConfirm"),
      busy: tt(lang, "deleting"),
      tone: "danger",
      opener: open,
      onConfirm: () => {
        if (namesMatch(input.value, name)) void remove(flow, input.value, name);
      },
    });
    flow.confirm.disabled = true;
    input.addEventListener("input", () => (flow.confirm.disabled = !namesMatch(input.value, name)));
  }

  open.addEventListener("click", askToDelete);
  paint();
  return { element, paint };
}
