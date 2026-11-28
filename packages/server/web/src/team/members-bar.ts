import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { countText } from "./members-text.js";
import { MAX_TICKED } from "./members.js";
import { tt } from "./strings.js";

/** The bar above the table while members are ticked: "14 selected", "Clear" and "Remove selected…". Its count is a live region that stays in the document. */

export type TicksBar = {
  element: HTMLElement;
  clear: HTMLButtonElement;
  remove: HTMLButtonElement;
  /** Draws the bar for `count` ticked members; `capped` says the team has more members than one removal takes. */
  paint(lang: Lang, count: number, capped: boolean): void;
};

export function ticksBar(doc: Document): TicksBar {
  const selected = h(doc, "span", { id: "members-selected", class: "selected", role: "status" });
  const clear = h(doc, "button", { type: "button", id: "members-clear", class: "link-button" }) as HTMLButtonElement;
  const remove = h(doc, "button", { type: "button", id: "members-remove-selected", class: "link-button" }) as HTMLButtonElement;
  const element = h(doc, "div", { id: "members-bar", class: "members-bar", hidden: "" }, selected, h(doc, "span", { class: "bar-actions" }, clear, remove));
  return {
    element,
    clear,
    remove,
    paint(lang, count, capped) {
      element.hidden = count === 0;
      const text = capped && count >= MAX_TICKED ? tt(lang, "selectedMax", { n: count }) : countText(lang, "selectedCount", count);
      if (selected.textContent !== text) selected.textContent = text;
      clear.textContent = tt(lang, "clearTicks");
      remove.textContent = tt(lang, "removeSelected");
    },
  };
}
