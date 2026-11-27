import { MAX_TEAM_NAME_CHARS } from "@teamusage/shared";
import { h } from "../dom.js";
import { uniqueId } from "../site/dialog.js";
import { isTeamNameInput } from "../site/team-name.js";
import { isTeamInfo, patchTeam } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { openFlow, type Flow } from "./dialog-flow.js";
import { failureText } from "./failure.js";
import { tt } from "./strings.js";

/** The page's heading: the team's name, drawn as text, and "Rename team", which renames it in a dialog. */

/** The server's refusal of a name it does not take (`src/routes-team-settings.ts`). */
const INVALID_NAME = "invalid name";

/** The name field of the dialog, with its label and the line of its own rule. */
function nameField(doc: Document, value: string, label: string) {
  const id = uniqueId("team-name");
  const input = h(doc, "input", { id, type: "text", maxlength: String(MAX_TEAM_NAME_CHARS), autocomplete: "off", autofocus: "" }) as HTMLInputElement;
  input.value = value;
  return { input, field: h(doc, "div", { class: "field" }, h(doc, "label", { for: id }, label), input) };
}

export function titleRow(ctx: TeamContext): Card {
  const { doc } = ctx;
  const heading = h(doc, "h1", { id: "team-title" });
  const renameButton = h(doc, "button", { type: "button", id: "rename", class: "btn quiet compact" }) as HTMLButtonElement;
  const element = h(doc, "div", { class: "team-head" }, heading, renameButton);

  function paint(): void {
    heading.textContent = ctx.team().name;
    renameButton.textContent = tt(ctx.lang(), "rename");
  }

  async function save(flow: Flow, input: HTMLInputElement): Promise<void> {
    const lang = ctx.lang();
    const name = input.value.trim();
    const refuseName = () => {
      input.setAttribute("aria-invalid", "true");
      flow.fail(tt(lang, "nameError"));
    };
    if (!isTeamNameInput(input.value)) return refuseName();
    if (name === ctx.team().name) return flow.dialog.close();
    const result = await flow.send(() => patchTeam(ctx.team().id, { name }));
    if (result === null) return;
    if (result.kind === "ok" && isTeamInfo(result.value?.team)) {
      ctx.update(result.value.team);
      return flow.dialog.close();
    }
    if (result.kind === "refused" && result.status === 400 && result.error === INVALID_NAME) return refuseName();
    flow.fail(failureText(lang, result));
  }

  function askForName(): void {
    const lang = ctx.lang();
    const { input, field } = nameField(doc, ctx.team().name, tt(lang, "nameLabel"));
    const flow: Flow = openFlow(ctx, {
      title: tt(lang, "rename"),
      content: [field],
      confirm: tt(lang, "save"),
      busy: tt(lang, "saving"),
      tone: "primary",
      opener: renameButton,
      onConfirm: () => void save(flow, input),
    });
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
  }

  renameButton.addEventListener("click", askForName);
  paint();
  return { element, paint };
}
