import { h } from "../dom.js";

/** The sortable column headers of a table, and the order a press on one gives: shared by the dashboard and the team page. */

export type SortDir = "asc" | "desc";
export type Sort<By extends string> = { by: By; dir: SortDir };

const ARROWS: Record<SortDir, string> = { asc: "↑", desc: "↓" };

/**
 * The sort after a press on a column: the same column turns round; a new one starts the way `first` says (the largest
 * or newest first, names from A).
 */
export function nextSort<By extends string>(current: Sort<By>, pressed: By, first: Record<By, SortDir>): Sort<By> {
  if (current.by !== pressed) return { by: pressed, dir: first[pressed] };
  return { by: pressed, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** A header that sorts: a button as tall as a finger in a `th`. `left` aligns the column's text to the left. */
export function sortHead(doc: Document, by: string, label: string, left: boolean): HTMLElement {
  const button = h(doc, "button", { type: "button", class: "sort-btn", "data-sort": by }, label);
  return h(doc, "th", { scope: "col", class: left ? "l sortable" : "sortable" }, button);
}

export function plainHead(doc: Document, label: string): HTMLElement {
  return h(doc, "th", { scope: "col", class: "l" }, label);
}

/** `aria-sort` and the arrow go on the sorted column and nowhere else; the buttons themselves stay, so focus stays. */
export function markSorted(table: Element, sort: Sort<string>, doc: Document): void {
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

/** The column of the header button an event came from, or undefined. */
export const pressedColumn = (event: Event): string | undefined => (event.target as Element | null)?.closest<HTMLElement>("button[data-sort]")?.dataset.sort;
