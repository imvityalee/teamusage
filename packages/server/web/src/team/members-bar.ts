import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { countText } from "./members-text.js";
import { MAX_TICKED } from "./members.js";
import { tt } from "./strings.js";

/**
 * The bar above the table while members are ticked: "14 selected", "Clear" and "Remove selected…". What a screen reader
 * hears is `status`, a node that stays in the document, outside the bar that hides while nothing is ticked, and is
 * empty then; the count the bar shows is the same words, hidden from assistive technology.
 */

export type TicksBar = {
  element: HTMLElement;
  /** The live region: visually hidden, never in a hidden ancestor. */
  status: HTMLElement;
  clear: HTMLButtonElement;
  remove: HTMLButtonElement;
  /** Draws the bar for `count` ticked members; `capped` says the team has more members than one removal takes. */
  paint(lang: Lang, count: number, capped: boolean): void;
};

export function ticksBar(doc: Document): TicksBar {
  const status = h(doc, "p", { id: "members-selected", class: "sr", role: "status" });
  const selected = h(doc, "span", { class: "selected", "aria-hidden": "true" });
  const clear = h(doc, "button", { type: "button", id: "members-clear", class: "link-button" }) as HTMLButtonElement;
  const remove = h(doc, "button", { type: "button", id: "members-remove-selected", class: "link-button" }) as HTMLButtonElement;
  const element = h(doc, "div", { id: "members-bar", class: "members-bar", hidden: "" }, selected, h(doc, "span", { class: "bar-actions" }, clear, remove));
  return {
    element,
    status,
    clear,
    remove,
    paint(lang, count, capped) {
      element.hidden = count === 0;
      const text = capped && count >= MAX_TICKED ? tt(lang, "selectedMax", { n: count }) : countText(lang, "selectedCount", count);
      const said = count === 0 ? "" : text;
      if (status.textContent !== said) status.textContent = said;
      selected.textContent = text;
      clear.textContent = tt(lang, "clearTicks");
      remove.textContent = tt(lang, "removeSelected");
    },
  };
}
