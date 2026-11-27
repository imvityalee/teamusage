import type { Stats } from "@teamusage/shared";
import { counted, h, icon } from "../dom.js";
import { matchCount, t, type Lang } from "../i18n.js";
import { matchMembers } from "../search.js";
import { loadPageSize, pageOf, savePageSize, type PageSize } from "../site/paging.js";
import { renderPager } from "../site/pager.js";
import { memberRows } from "./member-rows.js";
import { nextSort, sortMembers, type MemberSort } from "./members-table.js";

/**
 * The members panel: a search box and a table that draws one page of the members that match, in the order of the
 * pressed header, with a pager under it. Search and sorting cover every member; only the rows drawn are one page.
 */

export interface MembersOptions {
  query: string;
  /** The numbers are narrowed by a filter, so the bars speak of the filtered tokens. */
  filtered: boolean;
  sort: MemberSort;
  /** Told the new sort when a header is pressed, so a caller that repaints can give it back. */
  onSort?: (sort: MemberSort) => void;
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
  sort: MemberSort;
  page: number;
  size: PageSize;
  onSort: ((sort: MemberSort) => void) | undefined;
}

const views = new WeakMap<Element, View>();

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
  for (const th of table.querySelectorAll("thead th:has(button[data-sort])")) {
    const button = th.querySelector("button") as HTMLElement;
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
function draw(section: Element, view: View): void {
  const { doc, stats, lang, today, filtered } = view.context;
  const table = section.querySelector("#members");
  const body = table?.querySelector("tbody");
  const countLine = section.querySelector<HTMLElement>("#members-count");
  const slot = section.querySelector(".pager-slot");
  const scroll = table?.parentElement;
  if (!table || !body || !countLine || !slot || !scroll) return;
  const matched = matchMembers(stats.members, view.query);
  const page = pageOf(sortMembers(matched, view.sort, lang), view.page, view.size);
  view.page = page.page;
  body.replaceChildren(...memberRows(doc, stats, lang, today, page.rows, filtered));
  showCount(countLine, lang, view.query, matched.length, stats.members.length);
  scroll.hidden = matched.length === 0;
  markSorted(table, view.sort, doc);
  const go = (n: number) => {
    view.page = n;
    draw(section, view);
  };
  const resize = (size: PageSize) => {
    savePageSize(size);
    view.size = size;
    go(1);
  };
  slot.replaceChildren(...(matched.length === 0 ? [] : [renderPager(doc, page, view.size, lang, { page: go, size: resize })]));
}

/**
 * Shows the members matching `query` in an already rendered members panel, from page 1, without rebuilding the search box.
 * `filtered`: the numbers are narrowed by a filter, so the bars speak of the filtered tokens.
 */
export function applyMemberSearch(doc: Document, root: ParentNode, stats: Stats, lang: Lang, today: string, query: string, filtered = false): void {
  const section = root.querySelector('section[aria-labelledby="members-heading"]');
  const view = section && views.get(section);
  if (!section || !view) return;
  view.context = { doc, stats, lang, today, filtered };
  view.query = query;
  view.page = 1;
  draw(section, view);
}

function pressSort(section: Element, event: Event): void {
  const by = (event.target as Element | null)?.closest<HTMLElement>("button[data-sort]")?.dataset.sort as MemberSort["by"] | undefined;
  const view = views.get(section);
  if (by === undefined || !view) return;
  view.sort = nextSort(view.sort, by);
  view.page = 1;
  view.onSort?.(view.sort);
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
  const input = h(doc, "input", { type: "search", id: "member-search", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  input.placeholder = t(lang, "searchPlaceholder");
  input.value = query; // a property, never markup
  return h(doc, "div", { class: "search" }, h(doc, "label", { for: "member-search", class: "sr" }, t(lang, "searchMembers")), icon(doc, "search", "search-icon"), input);
}

export function membersPanel(doc: Document, stats: Stats, lang: Lang, today: string, opts: MembersOptions): HTMLElement {
  const table = h(doc, "table", { id: "members" }, tableHead(doc, lang), h(doc, "tbody"));
  const heading = h(doc, "div", {}, h(doc, "h2", { id: "members-heading" }, ...counted(doc, t(lang, "members"), stats.members.length)), h(doc, "p", { class: "hint" }, t(lang, "membersHint")));
  const section = h(
    doc,
    "section",
    { class: "panel", "aria-labelledby": "members-heading" },
    h(doc, "div", { class: "panel-head" }, heading, searchBox(doc, lang, opts.query)),
    h(doc, "p", { id: "members-count", class: "count", "aria-live": "polite" }),
    h(doc, "div", { class: "scroll" }, table),
    h(doc, "div", { class: "pager-slot" }),
    h(doc, "p", { class: "mix-note" }, t(lang, "mixNote")),
  );
  const view: View = { context: { doc, stats, lang, today, filtered: opts.filtered }, query: opts.query, sort: opts.sort, page: 1, size: loadPageSize(), onSort: opts.onSort };
  views.set(section, view);
  section.addEventListener("click", (event) => pressSort(section, event));
  draw(section, view);
  return section;
}
