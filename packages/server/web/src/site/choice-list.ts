import { h } from "../dom.js";

/**
 * A choice of one among a few: radio buttons, each row a title and lines under it (`.options` in site.css). Shared by the
 * dialogs that ask for one value, with the current value chosen or, with `current: null`, none.
 */

export type Choice<V extends string> = { value: V; title: string; lines: string[] };

export type ChoiceList<V extends string> = {
  /** The group; it sends `change` when the person chooses. */
  element: HTMLElement;
  /** The chosen value, or null while none is. */
  chosen(): V | null;
};

/** `name` ties the radio buttons into one group, so it is unique on the page (`uniqueId`). The one that takes focus is the chosen one, or the first. */
export function choiceList<V extends string>(doc: Document, o: { name: string; choices: Choice<V>[]; current: V | null }): ChoiceList<V> {
  const rows = o.choices.map((choice, n) => {
    const input = h(doc, "input", { type: "radio", name: o.name, value: choice.value }) as HTMLInputElement;
    input.checked = choice.value === o.current;
    if (input.checked || (o.current === null && n === 0)) input.setAttribute("autofocus", "");
    const lines = choice.lines.map((line) => h(doc, "span", { class: "small" }, line));
    const text = h(doc, "span", { class: "option-text" }, h(doc, "span", { class: "option-title" }, choice.title), ...lines);
    return { input, value: choice.value, label: h(doc, "label", { class: "option" }, input, text) };
  });
  return {
    element: h(doc, "fieldset", { class: "options" }, ...rows.map((row) => row.label)),
    chosen: () => rows.find((row) => row.input.checked)?.value ?? null,
  };
}
