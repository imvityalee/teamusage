import type { Stats } from "@teamusage/shared";
import { accountName, planName } from "./accounts.js";
import { agentIcon, agentLogo, agentName } from "./agents.js";
import { h, icon } from "./dom.js";
import {
  availableAgentTotals,
  canFilterModel,
  cleanAvailable,
  FILTER_KINDS,
  isActive,
  KEY_KINDS,
  withSelection,
  type FilterKind,
  type Filters,
  type KeyKind,
  type ModelRef,
} from "./filters.js";
import { compact } from "./format.js";
import { count, t, type CountedNoun, type Lang, type MessageKey } from "./i18n.js";

/**
 * The Agents, Models, Accounts and Plans buttons, their popovers and the chips under the bar. Agent ids, model names and
 * account names are shown as text only and reach the handlers through closures: they never become an attribute,
 * class, id or URL.
 */

/**
 * The words of each filter: its popover's title, its button's "All …" label (nothing selected) and the noun counted
 * otherwise, and the note shown when its list is full.
 */
export const FILTER_TEXT = {
  agents: { title: "agentsTitle", all: "allAgents", noun: "agents", limit: "agentLimit" },
  models: { title: "modelsTitle", all: "allModels", noun: "models", limit: "modelLimit" },
  accounts: { title: "accountsTitle", all: "allAccounts", noun: "accounts", limit: "accountLimit" },
  plans: { title: "plansTitle", all: "allPlans", noun: "plans", limit: "planLimit" },
} as const satisfies Record<FilterKind, { title: MessageKey; all: MessageKey; noun: CountedNoun; limit: MessageKey }>;

/** Display names of account and plan keys. */
const KEY_NAMES: Record<KeyKind, (key: string, lang: Lang) => string> = { accounts: accountName, plans: planName };

export interface FilterBarModel {
  available: Stats["available"];
  filters: Filters;
  open: FilterKind | null;
  /** The models search text. Compared as a plain substring only; never sent, stored or inserted as markup. */
  modelQuery: string;
  /** A short message inside the open popover, such as the selection limit. */
  note: { key: MessageKey; vars?: Record<string, string | number> } | null;
}

export interface FilterBarHandlers {
  toggleOpen(kind: FilterKind): void;
  toggleAgent(id: string): void;
  toggleModel(ref: ModelRef): void;
  toggleKey(kind: KeyKind, key: string): void;
  showAll(kind: FilterKind): void;
  modelQuery(query: string): void;
  clear(): void;
}

function checkRow(doc: Document, checked: boolean, disabled: boolean, onChange: () => void, ...content: Node[]): HTMLElement {
  const box = doc.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.disabled = disabled;
  box.addEventListener("change", onChange);
  const label = h(doc, "label", { class: checked ? "pop-row checked" : "pop-row" }, box, ...content);
  return h(doc, "li", {}, label);
}

function popover(doc: Document, kind: FilterKind, lang: Lang, m: FilterBarModel, on: FilterBarHandlers, ...body: Node[]): HTMLElement {
  const titleId = `${kind}-pop-title`;
  const showAll = h(doc, "button", { type: "button", class: "link" }, t(lang, "showAll"));
  showAll.addEventListener("click", () => on.showAll(kind));
  const head = h(doc, "div", { class: "pop-head" }, h(doc, "span", { class: "pop-title", id: titleId }, t(lang, FILTER_TEXT[kind].title)), showAll);
  const pop = h(doc, "div", { class: "popover", id: `${kind}-pop`, role: "dialog", "aria-labelledby": titleId }, head);
  if (m.note) pop.append(h(doc, "p", { class: "pop-note", role: "alert" }, t(lang, m.note.key, m.note.vars)));
  pop.append(...body);
  return pop;
}

function agentsPopover(doc: Document, lang: Lang, m: FilterBarModel, on: FilterBarHandlers): HTMLElement {
  const totals = availableAgentTotals(m.available);
  const selected = new Set(m.filters.agents);
  const rows = m.available.agents.map((id) =>
    checkRow(
      doc,
      selected.has(id),
      false,
      () => on.toggleAgent(id),
      agentIcon(doc, id),
      h(doc, "span", { class: "pop-name" }, agentName(id)),
      h(doc, "span", { class: "pop-num" }, compact(totals.get(id) ?? 0)),
    ),
  );
  const list = rows.length > 0 ? h(doc, "ul", { class: "pop-list" }, ...rows) : h(doc, "p", { class: "pop-empty" }, t(lang, "nothingInPeriod"));
  return popover(doc, "agents", lang, m, on, list);
}

/** One row per account or plan in the period, largest first as the server sends them; names only, no colour or icon. */
function keyedPopover(doc: Document, kind: KeyKind, lang: Lang, m: FilterBarModel, on: FilterBarHandlers): HTMLElement {
  const selected = new Set(m.filters[kind]);
  const rows = m.available[kind].map((entry) =>
    checkRow(
      doc,
      selected.has(entry.key),
      false,
      () => on.toggleKey(kind, entry.key),
      h(doc, "span", { class: "pop-name" }, KEY_NAMES[kind](entry.key, lang)),
      h(doc, "span", { class: "pop-num" }, compact(entry.tokens)),
    ),
  );
  const list = rows.length > 0 ? h(doc, "ul", { class: "pop-list" }, ...rows) : h(doc, "p", { class: "pop-empty" }, t(lang, "nothingInPeriod"));
  return popover(doc, kind, lang, m, on, list);
}

const POPOVERS: Record<FilterKind, (doc: Document, lang: Lang, m: FilterBarModel, on: FilterBarHandlers) => HTMLElement> = {
  agents: agentsPopover,
  models: modelsPopover,
  accounts: (doc, lang, m, on) => keyedPopover(doc, "accounts", lang, m, on),
  plans: (doc, lang, m, on) => keyedPopover(doc, "plans", lang, m, on),
};

/** Agents whose models the popover lists, in `available` order: the selected agents, or all of them. */
function modelAgents(m: FilterBarModel): string[] {
  const all = [...new Set([...m.available.agents, ...m.available.models.map((x) => x.agent)])];
  if (m.filters.agents.length === 0) return all;
  const selected = new Set(m.filters.agents);
  return all.filter((a) => selected.has(a));
}

function modelsPopover(doc: Document, lang: Lang, m: FilterBarModel, on: FilterBarHandlers): HTMLElement {
  const search = h(doc, "input", { type: "search", id: "model-search", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  search.placeholder = t(lang, "searchModels");
  search.value = m.modelQuery; // a property, never markup
  const label = h(doc, "label", { for: "model-search", class: "sr" }, t(lang, "searchModels"));

  const items: { li: HTMLElement; group: HTMLElement; name: string }[] = [];
  const groups = modelAgents(m).flatMap((agent) => {
    const models = m.available.models.filter((x) => x.agent === agent);
    if (models.length === 0) return [];
    const list = h(doc, "ul", { class: "pop-list" });
    const logo = agentLogo(doc, agent);
    const heading = h(doc, "div", { class: "pop-group-name" }, ...(logo ? [logo] : []), agentName(agent));
    const group = h(doc, "div", { class: "pop-group" }, heading, list);
    for (const x of models) {
      const ref = { agent: x.agent, model: x.model };
      const checked = m.filters.models.some((s) => s.agent === ref.agent && s.model === ref.model);
      const li = checkRow(
        doc,
        checked,
        !canFilterModel(ref),
        () => on.toggleModel(ref),
        h(doc, "span", { class: "pop-name" }, String(x.model)),
        h(doc, "span", { class: "pop-num" }, compact(x.tokens)),
      );
      list.append(li);
      items.push({ li, group, name: String(x.model).toLowerCase() });
    }
    return [group];
  });

  const empty = h(doc, "p", { class: "pop-empty" });
  const apply = (query: string) => {
    const q = query.trim().toLowerCase();
    for (const item of items) item.li.hidden = q !== "" && !item.name.includes(q);
    for (const g of groups) g.hidden = items.every((i) => i.group !== g || i.li.hidden);
    const none = items.every((i) => i.li.hidden);
    empty.hidden = !none;
    empty.textContent = items.length === 0 ? t(lang, "nothingInPeriod") : t(lang, "noModels");
  };
  apply(m.modelQuery);
  // Narrows the rows already drawn; no request, no re-render, so the field keeps focus.
  search.addEventListener("input", () => {
    on.modelQuery(search.value);
    apply(search.value);
  });

  const body: Node[] = [label, search, ...groups, empty];
  if (m.filters.agents.length > 0) body.push(h(doc, "p", { class: "pop-hint" }, t(lang, "onlySelectedAgents")));
  return popover(doc, "models", lang, m, on, ...body);
}

function filterButton(doc: Document, kind: FilterKind, text: string, selected: boolean, m: FilterBarModel, on: FilterBarHandlers, lang: Lang): HTMLElement {
  const open = m.open === kind;
  const button = h(
    doc,
    "button",
    {
      type: "button",
      id: `${kind}-btn`,
      class: selected ? "pill selected" : "pill",
      "aria-haspopup": "dialog",
      "aria-expanded": String(open),
      ...(open ? { "aria-controls": `${kind}-pop` } : {}),
    },
    text,
    icon(doc, open ? "up" : "down", open ? "chev up" : "chev"),
  );
  button.addEventListener("click", () => on.toggleOpen(kind));
  const wrap = h(doc, "div", { class: "filter" }, button);
  if (open) wrap.append(POPOVERS[kind](doc, lang, m, on));
  return wrap;
}

/** The four filter buttons (with the open popover right after its button) and, when a filter is on, Clear filters. */
export function renderFilterControls(doc: Document, model: FilterBarModel, lang: Lang, on: FilterBarHandlers): DocumentFragment {
  // Well-formed entries only, plus any selection this period or member lacks, so it can be seen and unticked.
  const m = { ...model, available: withSelection(cleanAvailable(model.available), model.filters) };
  const out = doc.createDocumentFragment();
  for (const kind of FILTER_KINDS) {
    // "All …" only when nothing is selected, even when every item is ticked, so it never says "All" while chips show.
    const n = m.filters[kind].length;
    const text = n === 0 ? t(lang, FILTER_TEXT[kind].all) : count(lang, FILTER_TEXT[kind].noun, n);
    out.append(filterButton(doc, kind, text, n > 0, m, on, lang));
  }
  if (isActive(m.filters)) {
    const clear = h(doc, "button", { type: "button", id: "clear-filters", class: "link" }, t(lang, "clearFilters"));
    clear.addEventListener("click", () => on.clear());
    out.append(clear);
  }
  return out;
}

function chip(doc: Document, text: string, label: string, onRemove: () => void, logo: HTMLImageElement | null): HTMLElement {
  const b = h(doc, "button", { type: "button", class: "chip", "aria-label": label }, ...(logo ? [logo] : []), text, icon(doc, "close", "x"));
  b.addEventListener("click", onRemove);
  return b;
}

/** "Showing only" and one removable chip per selection; nothing when no filter is on. */
export function renderChips(doc: Document, f: Filters, lang: Lang, on: FilterBarHandlers): Node[] {
  if (!isActive(f)) return [];
  return [
    h(doc, "span", { class: "chips-label" }, t(lang, "showingOnly")),
    ...f.agents.map((id) => chip(doc, agentName(id), t(lang, "removeFilter", { name: agentName(id) }), () => on.toggleAgent(id), agentLogo(doc, id))),
    ...f.models.map((ref) =>
      chip(doc, ref.model, t(lang, "removeFilter", { name: `${ref.model} (${agentName(ref.agent)})` }), () => on.toggleModel(ref), null),
    ),
    ...KEY_KINDS.flatMap((kind) =>
      f[kind].map((key) => {
        const name = KEY_NAMES[kind](key, lang);
        return chip(doc, name, t(lang, "removeFilter", { name }), () => on.toggleKey(kind, key), null);
      }),
    ),
  ];
}

/** Keeps the open popover of `controls` inside the viewport: it starts under its button and moves left when it would overflow. */
export function fitPopover(controls: HTMLElement): void {
  const pop = controls.querySelector<HTMLElement>(".popover");
  if (!pop) return;
  pop.style.removeProperty("left");
  const r = pop.getBoundingClientRect();
  const gutter = 8;
  const right = controls.ownerDocument.documentElement.clientWidth - gutter;
  let shift = 0;
  if (r.right > right) shift = right - r.right;
  if (r.left + shift < gutter) shift = gutter - r.left;
  if (shift !== 0) pop.style.left = `${Math.round(shift)}px`;
}
