import { counted, h } from "../dom.js";
import type { Lang } from "../lang.js";
import { sortHead } from "../site/sort-head.js";
import { tt } from "./strings.js";

/** The header of the members table, and the filter above it: "All" and "Not syncing {n}". */

export type TableHead = { thead: HTMLElement; box: HTMLInputElement };

/** The header row: the box that ticks everyone the search and filter leave, the four sorting columns and the (screen-reader) Action column. */
export function tableHead(doc: Document, lang: Lang): TableHead {
  const box = h(doc, "input", { type: "checkbox", id: "members-tick-all", "aria-label": tt(lang, "tickAllAria") }) as HTMLInputElement;
  const row = h(
    doc,
    "tr",
    {},
    h(doc, "th", { scope: "col", class: "tick" }, h(doc, "label", { class: "tick-box" }, box)),
    sortHead(doc, "name", tt(lang, "colMember"), true),
    sortHead(doc, "machines", tt(lang, "colMachines"), true),
    sortHead(doc, "lastSync", tt(lang, "colSync"), true),
    sortHead(doc, "joined", tt(lang, "colJoined"), true),
    h(doc, "th", { scope: "col", class: "action" }, h(doc, "span", { class: "sr" }, tt(lang, "colAction"))),
  );
  return { thead: h(doc, "thead", {}, row), box };
}

export type Filter = { element: HTMLElement; paint(lang: Lang, onlyStale: boolean, staleCount: number | null): void };

/** The two-button filter: "All" and "Not syncing" with the count of everyone in the team who is not syncing. */
export function staleFilter(doc: Document, onChange: (onlyStale: boolean) => void): Filter {
  const all = h(doc, "button", { type: "button", "data-filter": "all" }) as HTMLButtonElement;
  const stale = h(doc, "button", { type: "button", "data-filter": "stale" }) as HTMLButtonElement;
  const element = h(doc, "div", { class: "seg", role: "group", id: "members-filter" }, all, stale);
  all.addEventListener("click", () => onChange(false));
  stale.addEventListener("click", () => onChange(true));
  return {
    element,
    paint(lang, onlyStale, staleCount) {
      element.setAttribute("aria-label", tt(lang, "membersFilter"));
      all.textContent = tt(lang, "filterAll");
      stale.replaceChildren(...(staleCount === null ? [tt(lang, "filterStale")] : counted(doc, lang, tt(lang, "filterStale"), staleCount)));
      all.setAttribute("aria-pressed", String(!onlyStale));
      stale.setAttribute("aria-pressed", String(onlyStale));
    },
  };
}
