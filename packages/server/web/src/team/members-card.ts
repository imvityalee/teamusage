import { counted, h } from "../dom.js";
import type { Lang } from "../lang.js";
import { pressedColumn, markSorted, nextSort } from "../site/sort-head.js";
import { searchField } from "../site/search-field.js";
import { loadPageSize, savePageSize, type PageSize } from "../site/paging.js";
import { refocusStep, renderPager, updatePager } from "../site/pager.js";
import type { Machine } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { FIRST_DIRECTION, keepExisting, MAX_TICKED, tick, tickState, toggleAll, visible, type MemberListView, type MemberRow, type Ticked } from "./members.js";
import { memberRows } from "./members-rows.js";
import { ticksBar } from "./members-bar.js";
import { membersReader } from "./members-read.js";
import { staleFilter, tableHead } from "./members-table.js";
import { summaryText } from "./members-text.js";
import { tt } from "./strings.js";

/**
 * The members card (board 3): the team's members, searched, filtered to those not syncing, sorted, paged and ticked in the
 * browser. The list arrives whole; one page of rows is ever in the document. `onRemove` is what "Remove", "Remove machine" and
 * "Remove selected…" call; the removal dialog is not this card's.
 */

/** What a removal button chose: whole members, and machines of members. */
export type Removal = { members: MemberRow[]; machines: { member: MemberRow; machine: Machine }[] };

export type MembersCard = Card & {
  /** "512 members, 14 not syncing": the line under the team's name, which the page puts there. Empty until the list is read. */
  summary: HTMLElement;
  /** Reads the list again, keeping the ticks of members who are still there. */
  reload(): Promise<void>;
  /** Takes every tick off. */
  clearTicks(): void;
};

export type MembersOptions = {
  /** A local ISO date: the day "not syncing" is counted to. */
  today(): string;
  /** The reader's time zone unless a test says one. */
  timeZone?: string;
  /** `opener` is the button that was pressed, which a dialog gives focus back to. */
  onRemove(what: Removal, opener: HTMLElement): void;
};

export function membersCard(ctx: TeamContext, options: MembersOptions): MembersCard {
  const { doc } = ctx;
  let rows: MemberRow[] | null = null;
  let byId = new Map<number, MemberRow>();
  let ticked: Ticked = new Set();
  let shown: ReturnType<typeof visible> | null = null;
  const view: MemberListView = { query: "", onlyStale: false, sort: { by: "name", dir: "asc" }, page: 1, size: loadPageSize() };
  /** The members whose machines are open. */
  const open = new Set<number>();
  /** The language the head and the pager were built in. */
  let builtIn: Lang | null = null;

  const title = h(doc, "h2", { id: "members-title", tabindex: "-1" });
  const summary = h(doc, "p", { id: "team-summary", class: "team-summary", hidden: "" });
  const filter = staleFilter(doc, (onlyStale) => change({ onlyStale }));
  const search = searchField(doc, { id: "member-search", label: "", placeholder: "", query: "" });
  const input = search.querySelector("input") as HTMLInputElement;
  const bar = ticksBar(doc);
  const loading = h(doc, "p", { class: "card-note" });
  const reader = membersReader(ctx, {
    today: options.today,
    accept(read) {
      rows = read;
      byId = new Map(read.map((r) => [r.id, r]));
      ticked = keepExisting(ticked, read);
      for (const id of open) if (!byId.has(id)) open.delete(id);
      view.page = 1;
    },
    changed: paint,
    refocus: title,
  });
  const empty = h(doc, "p", { id: "members-empty", class: "card-note", hidden: "" });
  const body = h(doc, "tbody");
  let head = tableHead(doc, ctx.lang());
  head.box.addEventListener("change", onTickAll);
  const table = h(doc, "table", { id: "members-table", class: "members-table" }, head.thead, body);
  const scroll = h(doc, "div", { class: "scroll" }, table);
  const pagerSlot = h(doc, "div", { class: "pager-slot" });
  let pager: HTMLElement | null = null;
  const element = h(doc, "section", { id: "members-card", class: "card", "aria-labelledby": "members-title" }, h(doc, "div", { class: "card-head" }, title, h(doc, "div", { class: "members-tools" }, filter.element, search)), loading, reader.error, reader.retry, bar.status, bar.element, empty, pagerSlot);

  const lang = (): Lang => ctx.lang();

  /** The members ticked now, in the list's order and not only those on the page drawn. */
  const tickedRows = (): MemberRow[] => (rows ?? []).filter((r) => ticked.has(r.id));

  /** Ticks, the header's box and the bar, changed in place so that focus stays where it is. */
  function showTicks(): void {
    const matching = shown?.matching ?? [];
    const capped = ticked.size >= MAX_TICKED;
    for (const box of body.querySelectorAll<HTMLInputElement>("input[data-tick]")) {
      const on = ticked.has(Number(box.dataset.id));
      box.checked = on;
      box.disabled = capped && !on;
    }
    const state = tickState(ticked, matching);
    head.box.checked = state === "all";
    head.box.indeterminate = state === "some";
    head.box.disabled = matching.length === 0;
    bar.paint(lang(), ticked.size, (rows?.length ?? 0) > MAX_TICKED);
  }

  function setTicked(next: Ticked): void {
    ticked = next;
    showTicks();
  }

  /** The text under the heading and the line that stands in for an empty table. */
  function showCounts(): void {
    const l = lang();
    title.replaceChildren(...(rows === null ? [tt(l, "membersTitle")] : counted(doc, l, tt(l, "membersTitle"), rows.length)));
    summary.hidden = rows === null;
    summary.textContent = rows === null || shown === null ? "" : summaryText(l, rows.length, shown.staleCount);
    filter.paint(l, view.onlyStale, shown?.staleCount ?? null);
    const none = rows !== null && rows.length === 0;
    const noMatch = rows !== null && !none && shown?.matching.length === 0;
    empty.hidden = !none && !noMatch;
    empty.textContent = none ? tt(l, "membersEmpty") : noMatch ? tt(l, view.query.trim() === "" ? "membersNoStale" : "membersNoMatch") : "";
  }

  function showPager(): void {
    if (shown === null) return;
    const on = { page: (n: number) => go(n), size: (s: PageSize) => resize(s) };
    pager ??= renderPager(doc, shown.page, view.size, lang(), on);
    updatePager(pager, shown.page, view.size, lang());
    if (shown.matching.length === 0) pagerSlot.replaceChildren();
    else if (pager.parentElement !== pagerSlot) pagerSlot.replaceChildren(pager);
  }

  /** The rows of the page, the header's sort marks, the counts and the pager: all that changes with the search, the filter, the order and the page. */
  function draw(pressed?: "prev" | "next"): void {
    if (rows === null) return;
    const l = lang();
    shown = visible(rows, view, l);
    view.page = shown.page.page;
    const o = { lang: l, today: options.today(), timeZone: options.timeZone };
    body.replaceChildren(...shown.page.rows.flatMap((r) => memberRows(doc, r, { ...o, open: open.has(r.id) })));
    markSorted(table, view.sort, doc);
    scroll.hidden = shown.matching.length === 0;
    showCounts();
    showPager();
    showTicks();
    if (pressed !== undefined && pager !== null) refocusStep(pager, pressed);
  }

  /** The search box's words are set once and again in a new language, which also draws the head and the pager anew. */
  function paintLanguage(): void {
    const l = lang();
    if (builtIn === l) return;
    if (builtIn !== null) {
      head = tableHead(doc, l);
      table.querySelector("thead")?.replaceWith(head.thead);
      head.box.addEventListener("change", onTickAll);
      pager = null;
    }
    builtIn = l;
    search.querySelector("label")!.textContent = tt(l, "membersSearchLabel");
    input.placeholder = tt(l, "membersSearchPlaceholder");
  }

  function paint(): void {
    const l = lang();
    paintLanguage();
    loading.hidden = rows !== null || reader.problem() !== null;
    loading.textContent = tt(l, "membersLoading");
    reader.paint(l);
    const hasRows = rows !== null && rows.length > 0;
    for (const part of [filter.element, search]) part.hidden = !hasRows;
    scroll.hidden = !hasRows;
    if (hasRows && scroll.parentElement === null) element.insertBefore(scroll, empty);
    if (!hasRows) scroll.remove();
    draw();
    if (rows === null) showCounts();
  }

  /** Changes what the list shows and starts again from its first page. */
  function change(changes: Partial<MemberListView>): void {
    Object.assign(view, changes, { page: 1 });
    draw();
  }

  const go = (page: number): void => {
    const pressed = page > view.page ? "next" : "prev";
    view.page = page;
    draw(pressed);
  };

  function resize(size: PageSize): void {
    savePageSize(size);
    change({ size });
  }

  function onTickAll(): void {
    const matching = shown?.matching ?? [];
    setTicked(toggleAll(ticked, matching));
  }

  /** A press or change inside the table: a tick, "and 2 more", "Remove" or "Remove machine". */
  function onTable(event: Event): void {
    const target = event.target as HTMLElement;
    const id = Number(target.dataset.id);
    const member = byId.get(id);
    if (member === undefined) return;
    if (event.type === "change" && target.dataset.tick !== undefined) return setTicked(tick(ticked, id));
    if (event.type !== "click") return;
    const button = target.closest<HTMLButtonElement>("button[data-action]");
    if (button === null) return;
    if (button.dataset.action === "more") toggleMachines(member, button);
    else if (button.dataset.action === "remove") options.onRemove({ members: [member], machines: [] }, button);
    else if (button.dataset.action === "remove-machine") {
      const machine = member.machines.find((m) => m.id === button.dataset.machine);
      if (machine !== undefined) options.onRemove({ members: [], machines: [{ member, machine }] }, button);
    }
  }

  function toggleMachines(member: MemberRow, button: HTMLElement): void {
    const panel = doc.getElementById(button.getAttribute("aria-controls") ?? "");
    const opening = !open.has(member.id);
    if (opening) open.add(member.id);
    else open.delete(member.id);
    button.setAttribute("aria-expanded", String(opening));
    if (panel !== null) panel.hidden = !opening;
  }

  body.addEventListener("click", onTable);
  body.addEventListener("change", onTable);
  input.addEventListener("input", () => change({ query: input.value }));
  table.addEventListener("click", (event) => {
    const by = pressedColumn(event) as MemberListView["sort"]["by"] | undefined;
    if (by !== undefined) change({ sort: nextSort(view.sort, by, FIRST_DIRECTION) });
  });
  bar.clear.addEventListener("click", () => {
    setTicked(new Set());
    head.box.focus();
  });
  bar.remove.addEventListener("click", () => options.onRemove({ members: tickedRows(), machines: [] }, bar.remove));
  paint();
  void reader.read();
  return { element, paint, summary, reload: reader.read, clearTicks: () => setTicked(new Set()) };
}
