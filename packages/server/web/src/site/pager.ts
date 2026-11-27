import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { translator } from "./i18n.js";
import { PAGE_SIZES, type Page, type PageSize } from "./paging.js";
import { strings } from "./strings.js";

const t = translator(strings);
const LOCALES: Record<Lang, string> = { en: "en-US", ru: "ru-RU" };

const asPageSize = (value: string): PageSize | undefined => PAGE_SIZES.find((size) => String(size) === value);

function stepButton(doc: Document, step: "prev" | "next", label: string, disabled: boolean, go: () => void): HTMLElement {
  const button = h(doc, "button", { type: "button", "data-step": step }, label) as HTMLButtonElement;
  button.disabled = disabled;
  button.addEventListener("click", go);
  return button;
}

function sizeSelect(doc: Document, size: PageSize, lang: Lang, choose: (size: PageSize) => void): HTMLElement {
  const select = h(doc, "select", {}, ...PAGE_SIZES.map((s) => h(doc, "option", { value: String(s) }, String(s)))) as HTMLSelectElement;
  select.value = String(size);
  select.addEventListener("change", () => {
    const chosen = asPageSize(select.value);
    if (chosen !== undefined) choose(chosen);
  });
  return h(doc, "label", { class: "pager-size" }, h(doc, "span", {}, t(lang, "pagerRows")), select);
}

/** "1–25 of 512", the rows-per-page select, Previous and Next; Previous is disabled on the first page, Next on the last. */
export function renderPager(doc: Document, page: Page<unknown>, size: PageSize, lang: Lang, on: { page(n: number): void; size(s: PageSize): void }): HTMLElement {
  const format = new Intl.NumberFormat(LOCALES[lang]).format;
  const range = t(lang, "pagerRange", { from: format(page.from), to: format(page.to), total: format(page.total) });
  return h(
    doc,
    "nav",
    { class: "pager", "aria-label": t(lang, "pagerLabel") },
    h(doc, "span", { class: "pager-range" }, range),
    sizeSelect(doc, size, lang, on.size),
    h(
      doc,
      "div",
      { class: "pager-steps" },
      stepButton(doc, "prev", t(lang, "pagerPrevious"), page.page <= 1, () => on.page(page.page - 1)),
      stepButton(doc, "next", t(lang, "pagerNext"), page.page >= page.pages, () => on.page(page.page + 1)),
    ),
  );
}
