import { h } from "../dom.js";
import { locale, type Lang } from "../lang.js";
import { translator } from "./i18n.js";
import { PAGE_SIZES, type Page, type PageSize } from "./paging.js";
import { strings } from "./strings.js";

const t = translator(strings);

const asPageSize = (value: string): PageSize | undefined => PAGE_SIZES.find((size) => String(size) === value);

export type Step = "prev" | "next";

function stepButton(doc: Document, step: Step, label: string, go: () => void): HTMLButtonElement {
  const button = h(doc, "button", { type: "button", "data-step": step }, label) as HTMLButtonElement;
  button.addEventListener("click", go);
  return button;
}

function sizeSelect(doc: Document, lang: Lang, choose: (size: PageSize) => void): HTMLElement {
  const options = PAGE_SIZES.map((s) => h(doc, "option", { value: String(s) }, String(s)));
  const select = h(doc, "select", {}, ...options) as HTMLSelectElement;
  select.addEventListener("change", () => {
    const chosen = asPageSize(select.value);
    if (chosen !== undefined) choose(chosen);
  });
  return h(doc, "label", { class: "pager-size" }, h(doc, "span", {}, t(lang, "pagerRows")), select);
}

/**
 * "1–25 of 512", the rows-per-page select, Previous and Next. It is built once and then changed in place with
 * `updatePager`, so the range stays the same live region and keyboard focus stays on the control that was pressed.
 */
export function renderPager(
  doc: Document,
  page: Page<unknown>,
  size: PageSize,
  lang: Lang,
  on: { page(n: number): void; size(s: PageSize): void },
): HTMLElement {
  const pager = h(doc, "nav", { class: "pager", "aria-label": t(lang, "pagerLabel") });
  const current = () => Number(pager.dataset.page);
  const steps = h(
    doc,
    "div",
    { class: "pager-steps" },
    stepButton(doc, "prev", t(lang, "pagerPrevious"), () => on.page(current() - 1)),
    stepButton(doc, "next", t(lang, "pagerNext"), () => on.page(current() + 1)),
  );
  pager.append(h(doc, "span", { class: "pager-range", "aria-live": "polite" }), sizeSelect(doc, lang, on.size), steps);
  updatePager(pager, page, size, lang);
  return pager;
}

/**
 * Shows `page`: the range, the select's value and which buttons are disabled (Previous on the first page, Next on the
 * last). While everything fits on the smallest page only the range shows.
 */
export function updatePager(pager: HTMLElement, page: Page<unknown>, size: PageSize, lang: Lang): void {
  const format = new Intl.NumberFormat(locale(lang)).format;
  const range = t(lang, "pagerRange", { from: format(page.from), to: format(page.to), total: format(page.total) });
  const fits = page.total <= PAGE_SIZES[0];
  pager.dataset.page = String(page.page);
  (pager.querySelector(".pager-range") as HTMLElement).textContent = range;
  (pager.querySelector("select") as HTMLSelectElement).value = String(size);
  (pager.querySelector(".pager-size") as HTMLElement).hidden = fits;
  (pager.querySelector(".pager-steps") as HTMLElement).hidden = fits;
  (pager.querySelector('button[data-step="prev"]') as HTMLButtonElement).disabled = page.page <= 1;
  (pager.querySelector('button[data-step="next"]') as HTMLButtonElement).disabled = page.page >= page.pages;
}

/** The step button just pressed is now disabled (the first or the last page): focus goes to the other one. */
export function refocusStep(pager: Element, pressed: Step): void {
  const button = (step: Step) => pager.querySelector<HTMLButtonElement>(`button[data-step="${step}"]`);
  if (button(pressed)?.disabled) button(pressed === "next" ? "prev" : "next")?.focus({ preventScroll: true });
}
