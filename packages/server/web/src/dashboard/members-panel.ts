import type { Stats } from "@teamusage/shared";
import { counted, h, icon } from "../dom.js";
import { matchCount, t, type Lang } from "../i18n.js";
import { matchMembers } from "../search.js";
import { loadPageSize, pageOf, savePageSize, type PageSize } from "../site/paging.js";
import { renderPager, updatePager } from "../site/pager.js";
import { memberRows } from "./member-rows.js";
import { DEFAULT_SORT, nextSort, sortMembers, type MemberSort } from "./members-table.js";

/**
 * The members panel: a search box and a table that draws one page of the members that match, in the order of the
 * pressed header, with a pager under it. Search and sorting cover every member; only the rows drawn are one page.
 */

/**
 * The order and the page of the table. The caller holds one and hands it to every panel it draws; the panel changes it
 * when a header or the pager is pressed, so a repaint of the same statistics comes back on the same page, in the
 * same order.
 */
export interface MembersTable {
  sort: MemberSort;
  page: number;
  /** The statistics `page` belongs to: new statistics start again at page 1. */
  stats: Stats | null;
}

/** A table in its first state: sorted by tokens, largest first, on page 1. */
export const newTable = (): MembersTable => ({ sort: DEFAULT_SORT, page: 1, stats: null });

export interface MembersOptions {
  query: string;
  /** The numbers are narrowed by a filter, so the bars speak of the filtered tokens. */
  filtered: boolean;
  table: MembersTable;
}

/** What a draw needs from the page it is on. */
interface Context {
  doc: Document;
  stats: Stats;
  lang: Lang;
  today: string;
  filtered: boolean;
}

/** What a panel remembers between draws; a new panel starts on page 1. */
interface View {
  context: Context;
  query: string;
  table: MembersTable;
  size: PageSize;
  /** Built with the first draw and kept for the life of the panel; a search matching nobody only takes it out. */
  pager: HTMLElement | null;
}

const views = new WeakMap<Element, View>();

type Step = "prev" | "next";

const ARROWS = { asc: "↑", desc: "↓" } as const;

function sortHead(doc: Document, lang: Lang, by: MemberSort["by"], label: string, left: boolean): HTMLElement {
  const button = h(doc, "button", { type: "button", class: "sort-btn", "data-sort": by }, label);
  return h(doc, "th", { scope: "col", class: left ? "l sortable" : "sortable" }, button);
}

function plainHead(doc: Document, label: string): HTMLElement {
  return h(doc, "th", { scope: "col", class: "l" }, label);
}

/** `aria-sort` and the arrow go on the sorted column and nowhere else. */
function markSorted(table: Element, sort: MemberSort, doc: Document): void {
  for (const button of table.querySelectorAll<HTMLElement>("thead button[data-sort]")) {
    const th = button.closest("th") as HTMLElement;
    button.querySelector(".sort")?.remove();
    if (button.dataset.sort !== sort.by) {
      th.removeAttribute("aria-sort");
      continue;
    }
    th.setAttribute("aria-sort", sort.dir === "asc" ? "ascending" : "descending");
    button.append(h(doc, "span", { class: "sort", "aria-hidden": "true" }, ARROWS[sort.dir]));
  }
}

function showCount(line: HTMLElement, lang: Lang, query: string, matched: number, all: number): void {
  const filtering = query.trim() !== "";
  line.hidden = !filtering;
  line.textContent = !filtering ? "" : matched === 0 ? t(lang, "noMatch") : matchCount(lang, matched, all);
}

/** Draws the rows, the count line, the sorted header and the pager of `section` from its view. */
function draw(section: Element, view: View, pressed?: Step): void {
  const { doc, stats, lang, today, filtered } = view.context;
  const table = section.querySelector("#members");
  const body = table?.querySelector("tbody");
  const countLine = section.querySelector<HTMLElement>("#members-count");
  const slot = section.querySelector(".pager-slot");
  const scroll = table?.parentElement;
  if (!table || !body || !countLine || !slot || !scroll) return;
  const matched = matchMembers(stats.members, view.query);
  const page = pageOf(sortMembers(matched, view.table.sort, lang), view.table.page, view.size);
  view.table.page = page.page;
  body.replaceChildren(...memberRows(doc, stats, lang, today, page.rows, filtered));
  showCount(countLine, lang, view.query, matched.length, stats.members.length);
  scroll.hidden = matched.length === 0;
  markSorted(table, view.table.sort, doc);
  const on = { page: (n: number) => go(section, view, n), size: (s: PageSize) => resize(section, view, s) };
  const pager = (view.pager ??= renderPager(doc, page, view.size, lang, on));
  updatePager(pager, page, view.size, lang);
  if (matched.length === 0) slot.replaceChildren();
  else if (pager.parentElement !== slot) slot.replaceChildren(pager);
  if (pressed !== undefined) refocus(pager, pressed);
}

function go(section: Element, view: View, page: number): void {
  const pressed = page > view.table.page ? "next" : "prev";
  view.table.page = page;
  draw(section, view, pressed);
}

function resize(section: Element, view: View, size: PageSize): void {
  savePageSize(size);
  view.size = size;
  view.table.page = 1;
  draw(section, view);
}

/** The step button just pressed is now disabled (the first or the last page): focus goes to the other one. */
function refocus(pager: Element, pressed: Step): void {
  const button = (step: Step) => pager.querySelector<HTMLButtonElement>(`button[data-step="${step}"]`);
  if (button(pressed)?.disabled) button(pressed === "next" ? "prev" : "next")?.focus({ preventScroll: true });
}

/**
 * Shows the members matching `query` in an already rendered members panel, from page 1, without rebuilding the
 * search box.
 * `filtered`: the numbers are narrowed by a filter, so the bars speak of the filtered tokens.
 */
export function applyMemberSearch(
  doc: Document,
  root: ParentNode,
  stats: Stats,
  lang: Lang,
  today: string,
  query: string,
  filtered = false,
): void {
  const section = root.querySelector('section[aria-labelledby="members-heading"]');
  const view = section && views.get(section);
  if (!section || !view) return;
  view.context = { doc, stats, lang, today, filtered };
  view.query = query;
  view.table.page = 1;
  draw(section, view);
}

function pressSort(section: Element, event: Event): void {
  const button = (event.target as Element | null)?.closest<HTMLElement>("button[data-sort]");
  const by = button?.dataset.sort as MemberSort["by"] | undefined;
  const view = views.get(section);
  if (by === undefined || !view) return;
  view.table.sort = nextSort(view.table.sort, by);
  view.table.page = 1;
  draw(section, view);
}

function tableHead(doc: Document, lang: Lang): HTMLElement {
  return h(
    doc,
    "thead",
    {},
    h(
      doc,
      "tr",
      {},
      sortHead(doc, lang, "name", t(lang, "colMember"), true),
      sortHead(doc, lang, "tokens", t(lang, "colTokens"), false),
      sortHead(doc, lang, "cost", t(lang, "colCost"), false),
      plainHead(doc, t(lang, "colAgentMix")),
      plainHead(doc, t(lang, "colAccounts")),
      sortHead(doc, lang, "lastSync", t(lang, "colLastSync"), false),
      h(doc, "td", { class: "chev-cell", "aria-hidden": "true" }),
    ),
  );
}

function searchBox(doc: Document, lang: Lang, query: string): HTMLElement {
  const attrs = { type: "search", id: "member-search", autocomplete: "off", spellcheck: "false" };
  const input = h(doc, "input", attrs) as HTMLInputElement;
  input.placeholder = t(lang, "searchPlaceholder");
  input.value = query; // a property, never markup
  const label = h(doc, "label", { for: "member-search", class: "sr" }, t(lang, "searchMembers"));
  return h(doc, "div", { class: "search" }, label, icon(doc, "search", "search-icon"), input);
}

function heading(doc: Document, lang: Lang, members: number): HTMLElement {
  const title = h(doc, "h2", { id: "members-heading" }, ...counted(doc, lang, t(lang, "members"), members));
  return h(doc, "div", {}, title, h(doc, "p", { class: "hint" }, t(lang, "membersHint")));
}

export function membersPanel(
  doc: Document,
  stats: Stats,
  lang: Lang,
  today: string,
  opts: MembersOptions,
): HTMLElement {
  const table = h(doc, "table", { id: "members" }, tableHead(doc, lang), h(doc, "tbody"));
  const section = h(
    doc,
    "section",
    { class: "panel", "aria-labelledby": "members-heading" },
    h(doc, "div", { class: "panel-head" }, heading(doc, lang, stats.members.length), searchBox(doc, lang, opts.query)),
    h(doc, "p", { id: "members-count", class: "count", "aria-live": "polite" }),
    h(doc, "div", { class: "scroll" }, table),
    h(doc, "div", { class: "pager-slot" }),
    h(doc, "p", { class: "mix-note" }, t(lang, "mixNote")),
  );
  const context = { doc, stats, lang, today, filtered: opts.filtered };
  if (opts.table.stats !== stats) Object.assign(opts.table, { page: 1, stats });
  const view: View = { context, query: opts.query, table: opts.table, size: loadPageSize(), pager: null };
  views.set(section, view);
  section.addEventListener("click", (event) => pressSort(section, event));
  draw(section, view);
  return section;
}
