import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { choiceList } from "../site/choice-list.js";
import { uniqueId } from "../site/dialog.js";
import { isTeamInfo, patchTeam, type TeamInfo } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { openFlow, type Flow } from "./dialog-flow.js";
import { failureText } from "./failure.js";
import { tt, type TeamKey } from "./strings.js";

/** The dashboard access card: who can open the dashboard. Only the owner sees "Change…", which asks in a dialog. */

type Access = TeamInfo["dashboardAccess"];

/** Each choice's name, the card's sentence about it, and the lines under it in the dialog (board 2, corrected). */
const CHOICES: { value: Access; name: TeamKey; card: TeamKey; notes: TeamKey[] }[] = [
  { value: "members", name: "accessMembers", card: "accessMembersText", notes: ["optMembersNote"] },
  { value: "admins", name: "accessAdmins", card: "accessAdminsText", notes: ["optAdminsNote", "optAdminsSignOut"] },
];

const choiceOf = (value: Access) => CHOICES.find((c) => c.value === value) ?? (CHOICES[0] as (typeof CHOICES)[number]);

/** The dialog's two options, the current one chosen. */
function options(doc: Document, lang: Lang, current: Access) {
  const choices = CHOICES.map((c) => ({ value: c.value, title: tt(lang, c.name), lines: c.notes.map((key) => tt(lang, key)) }));
  return choiceList(doc, { name: uniqueId("dashboard-access"), choices, current });
}

export function accessCard(ctx: TeamContext): Card {
  const { doc } = ctx;
  const title = h(doc, "h2", { id: "access-title" });
  const badge = h(doc, "span", { id: "access-value", class: "badge" });
  const text = h(doc, "p", { id: "access-text", class: "card-note" });
  const change = h(doc, "button", { type: "button", id: "access-change", class: "btn quiet compact" }) as HTMLButtonElement;
  const element = h(doc, "section", { id: "access-card", class: "card", "aria-labelledby": "access-title" },
    h(doc, "div", { class: "card-head" }, h(doc, "div", { class: "card-text" }, h(doc, "div", { class: "title-line" }, title, badge), text), change),
  );

  function paint(): void {
    const lang = ctx.lang();
    const { dashboardAccess, role } = ctx.team();
    title.textContent = tt(lang, "accessTitle");
    badge.textContent = tt(lang, choiceOf(dashboardAccess).name);
    text.textContent = tt(lang, choiceOf(dashboardAccess).card);
    change.textContent = tt(lang, "change");
    change.hidden = role !== "owner";
  }

  async function save(flow: Flow, chosen: Access): Promise<void> {
    if (chosen === ctx.team().dashboardAccess) return flow.dialog.close();
    const result = await flow.send(() => patchTeam(ctx.team().id, { dashboardAccess: chosen }));
    if (result === null) return;
    if (result.kind === "ok" && isTeamInfo(result.value?.team)) {
      ctx.update(result.value.team);
      return flow.dialog.close();
    }
    flow.fail(failureText(ctx.lang(), result));
  }

  function askForAccess(): void {
    const lang = ctx.lang();
    const list = options(doc, lang, ctx.team().dashboardAccess);
    const flow: Flow = openFlow(ctx, {
      title: tt(lang, "accessDialogTitle"),
      content: [list.element],
      confirm: tt(lang, "save"),
      busy: tt(lang, "saving"),
      tone: "primary",
      opener: change,
      onConfirm: () => void save(flow, list.chosen() ?? ctx.team().dashboardAccess),
    });
  }

  change.addEventListener("click", askForAccess);
  paint();
  return { element, paint };
}
