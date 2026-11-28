import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { shortDay } from "../site/day.js";
import { daysSince } from "../site/sync-age.js";
import type { Machine } from "./api.js";
import type { MemberRow } from "./members.js";
import { countText, syncText } from "./members-text.js";
import { tt } from "./strings.js";

/** The rows of the members table: one `<tr>` for a member and, for a member with several machines, one more that holds the machines. Every value is drawn as text. */

/** The columns of the table, the tick box and the action button included: a machines row spans them all. */
export const COLUMNS = 6;

/** `today` is a local ISO date; `timeZone` is the reader's unless a test says one; `open` says whether the machines row starts open. */
export type RowOptions = { lang: Lang; today: string; timeZone: string | undefined; open: boolean };

/** The id of the row that holds a member's machines, which the "and 2 more" button controls. */
export const machinesRowId = (member: MemberRow): string => `machines-${member.id}`;

/** A sync age as the page says it, with the day itself in the title where there was one. */
function syncSpan(doc: Document, o: RowOptions, at: string | null, days: number | null): HTMLElement {
  const span = h(doc, "span", {}, syncText(o.lang, days));
  if (at !== null) span.title = shortDay(at, o.lang, o.timeZone);
  return span;
}

function tickCell(doc: Document, o: RowOptions, member: MemberRow): HTMLElement {
  const box = h(doc, "input", { type: "checkbox", "data-tick": "", "data-id": String(member.id), "aria-label": tt(o.lang, "tickRowAria", { name: member.name }) });
  return h(doc, "td", { class: "tick" }, h(doc, "label", { class: "tick-box" }, box));
}

function machinesCell(doc: Document, o: RowOptions, member: MemberRow): HTMLElement {
  const [first, ...others] = member.machines;
  if (first === undefined) return h(doc, "td", { class: "machines-cell muted" }, tt(o.lang, "noMachines"));
  const cell = h(doc, "td", { class: "machines-cell" }, h(doc, "span", {}, first.label));
  if (others.length === 0) return cell;
  const attrs = { type: "button", class: "more-btn", "data-action": "more", "data-id": String(member.id), "aria-expanded": String(o.open), "aria-controls": machinesRowId(member) };
  cell.append(" ", h(doc, "button", attrs, countText(o.lang, "moreMachines", others.length)));
  return cell;
}

function syncCell(doc: Document, o: RowOptions, member: MemberRow): HTMLElement {
  const text = syncSpan(doc, o, member.lastSyncAt, member.days);
  return h(doc, "td", { class: "sync-cell" }, member.stale ? h(doc, "span", { class: "badge warn" }, text) : text);
}

const removeButton = (doc: Document, attrs: Record<string, string>, label: string, aria: string): HTMLElement =>
  h(doc, "button", { type: "button", class: "btn quiet danger compact", "aria-label": aria, ...attrs }, label);

/** One machine of a member: its label, its last sync and "Remove machine". */
function machineItem(doc: Document, o: RowOptions, member: MemberRow, machine: Machine): HTMLElement {
  const when = syncText(o.lang, daysSince(machine.lastSyncAt, o.today));
  const attrs = { "data-action": "remove-machine", "data-id": String(member.id), "data-machine": machine.id };
  const aria = tt(o.lang, "removeMachineAria", { label: machine.label, name: member.name });
  return h(
    doc,
    "li",
    { class: "machine-item" },
    h(doc, "span", { class: "machine-label" }, machine.label),
    h(doc, "span", { class: "machine-sync" }, tt(o.lang, "machineSync", { when })),
    removeButton(doc, attrs, tt(o.lang, "removeMachine"), aria),
  );
}

/** The row under a member with several machines: each machine with its own "Remove machine". It is in the document, hidden, until opened. */
function machinesRow(doc: Document, o: RowOptions, member: MemberRow): HTMLElement {
  const list = h(doc, "ul", { class: "machine-list", "aria-label": tt(o.lang, "machinesOf", { name: member.name }) }, ...member.machines.map((m) => machineItem(doc, o, member, m)));
  const row = h(doc, "tr", { class: "machines-row", id: machinesRowId(member) }, h(doc, "td", { colspan: String(COLUMNS) }, list));
  row.hidden = !o.open;
  return row;
}

/** The `<tr>`s of a member: the row, and the machines row when there is more than one machine. */
export function memberRows(doc: Document, member: MemberRow, o: RowOptions): HTMLElement[] {
  const who = h(doc, "td", { class: "who" }, h(doc, "div", { class: "member-name" }, member.name), h(doc, "div", { class: "member-email" }, member.email));
  const joined = h(doc, "td", { class: "joined" }, shortDay(member.joinedAt, o.lang, o.timeZone));
  const attrs = { "data-action": "remove", "data-id": String(member.id) };
  const action = h(doc, "td", { class: "action" }, removeButton(doc, attrs, tt(o.lang, "removeMember"), tt(o.lang, "removeMemberAria", { name: member.name })));
  const row = h(doc, "tr", { "data-member-id": String(member.id) }, tickCell(doc, o, member), who, machinesCell(doc, o, member), syncCell(doc, o, member), joined, action);
  return member.machines.length > 1 ? [row, machinesRow(doc, o, member)] : [row];
}
