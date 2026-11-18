import type { Stats } from "@teamusage/shared";
import { agentIcon, agentLogo, agentName } from "./agents.js";
import { h, icon } from "./dom.js";
import { agentTotals, canFilterModel, isActive, summary, type Filters, type ModelRef } from "./filters.js";
import { compact } from "./format.js";
import { count, t, type Lang, type MessageKey } from "./i18n.js";

/**
 * The Agents and Models buttons, their popovers and the chips under the bar. Agent ids and model names are shown
 * as text only and reach the handlers through closures: they never become an attribute, class, id or URL.
 */

export type PopoverKind = "agents" | "models";

export interface FilterBarModel {
  available: Stats["available"];
  filters: Filters;
  open: PopoverKind | null;
  /** The models search text. Compared as a plain substring only; never sent, stored or inserted as markup. */
  modelQuery: string;
  /** A short message inside the open popover, such as the selection limit. */
  note: { key: MessageKey; vars?: Record<string, string | number> } | null;
}

export interface FilterBarHandlers {
  toggleOpen(kind: PopoverKind): void;
  toggleAgent(id: string): void;
  toggleModel(ref: ModelRef): void;
  showAll(kind: PopoverKind): void;
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

function popover(doc: Document, kind: PopoverKind, lang: Lang, m: FilterBarModel, on: FilterBarHandlers, ...body: Node[]): HTMLElement {
  const titleId = `${kind}-pop-title`;
  const showAll = h(doc, "button", { type: "button", class: "link" }, t(lang, "showAll"));
  showAll.addEventListener("click", () => on.showAll(kind));
  const head = h(doc, "div", { class: "pop-head" }, h(doc, "span", { class: "pop-title", id: titleId }, t(lang, kind === "agents" ? "agentsTitle" : "modelsTitle")), showAll);
  const pop = h(doc, "div", { class: "popover", id: `${kind}-pop`, role: "dialog", "aria-labelledby": titleId }, head);
  if (m.note) pop.append(h(doc, "p", { class: "pop-note", role: "alert" }, t(lang, m.note.key, m.note.vars)));
  pop.append(...body);
  return pop;
}

function agentsPopover(doc: Document, lang: Lang, m: FilterBarModel, on: FilterBarHandlers): HTMLElement {
  const totals = agentTotals(m.available);
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

function filterButton(doc: Document, kind: PopoverKind, text: string, selected: boolean, m: FilterBarModel, on: FilterBarHandlers, lang: Lang): HTMLElement {
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
  if (open) wrap.append(kind === "agents" ? agentsPopover(doc, lang, m, on) : modelsPopover(doc, lang, m, on));
  return wrap;
}

/** The two filter buttons (with the open popover right after its button) and, when a filter is on, Clear filters. */
export function renderFilterControls(doc: Document, m: FilterBarModel, lang: Lang, on: FilterBarHandlers): DocumentFragment {
  const { agents, models } = m.filters;
  const agentsText = summary(agents.length, m.available.agents.length) === "all" ? t(lang, "allAgents") : count(lang, "agents", agents.length);
  const modelsText = summary(models.length, m.available.models.length) === "all" ? t(lang, "allModels") : count(lang, "models", models.length);
  const out = doc.createDocumentFragment();
  out.append(
    filterButton(doc, "agents", agentsText, agents.length > 0, m, on, lang),
    filterButton(doc, "models", modelsText, models.length > 0, m, on, lang),
  );
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
  ];
}
