import { h, icon } from "../dom.js";

/** The search box above a table: a visually hidden label, the magnifier and a `type="search"` input (shared). */
export function searchField(doc: Document, o: { id: string; label: string; placeholder: string; query: string }): HTMLElement {
  const input = h(doc, "input", { type: "search", id: o.id, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  input.placeholder = o.placeholder;
  input.value = o.query; // a property, never markup
  const label = h(doc, "label", { for: o.id, class: "sr" }, o.label);
  return h(doc, "div", { class: "search" }, label, icon(doc, "search", "search-icon"), input);
}
