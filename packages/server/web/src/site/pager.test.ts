import { describe, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { pageOf, type PageSize } from "./paging.js";
import { renderPager, updatePager } from "./pager.js";
import { chooseSize } from "./pager.fixture.js";
import type { Lang } from "../lang.js";

const doc = () => new Window().document as unknown as Document;

/** U+00A0 NO-BREAK SPACE, which this runtime's Russian number format puts between thousands. */
const NBSP = "\u00a0";

function pager(total: number, page: number, size: PageSize = 25, lang: Lang = "en") {
  const on = { page: vi.fn(), size: vi.fn() };
  const p = pageOf(Array.from({ length: total }, (_, i) => i), page, size);
  const el = renderPager(doc(), p, size, lang, on);
  return { el, on, range: el.querySelector(".pager-range")?.textContent, prev: el.querySelector<HTMLButtonElement>('button[data-step="prev"]')!, next: el.querySelector<HTMLButtonElement>('button[data-step="next"]')!, select: el.querySelector<HTMLSelectElement>("select")! };
}

describe("the range line", () => {
  test.each([
    [512, 1, "1–25 of 512"],
    [512, 21, "501–512 of 512"],
    [1, 1, "1–1 of 1"],
    [2000, 1, "1–25 of 2,000"],
  ])("%i members, page %i reads %s", (total, page, text) => {
    expect(pager(total, page).range).toBe(text);
  });

  test("Russian reads 1–25 из 2 000, with the thousands separator of the runtime", () => {
    expect(pager(2000, 1, 25, "ru").range).toBe(`1–25 из 2${NBSP}000`);
  });
});

describe("when everything fits on the smallest page", () => {
  const hidden = (el: HTMLElement) => [el.querySelector<HTMLElement>(".pager-size")?.hidden, el.querySelector<HTMLElement>(".pager-steps")?.hidden];

  test("3 members show the range alone: the select and the buttons are hidden", () => {
    const { el, range } = pager(3, 1);
    expect(range).toBe("1–3 of 3");
    expect(hidden(el)).toEqual([true, true]);
  });

  test.each([[25, false], [26, true]])("%i members: the select and both buttons show only above 25 (%s)", (total, shown) => {
    expect(hidden(pager(total, 1).el)).toEqual([!shown, !shown]);
  });

  test("updatePager changes the same element: the range, the buttons, the select and what is hidden", () => {
    const { el } = pager(3, 1);
    const range = el.querySelector(".pager-range");
    updatePager(el, pageOf(Array.from({ length: 60 }, (_, i) => i), 2, 50), 50, "en");
    expect(el.querySelector(".pager-range")).toBe(range);
    expect(range?.textContent).toBe("51–60 of 60");
    expect(hidden(el)).toEqual([false, false]);
    expect(el.querySelector<HTMLSelectElement>("select")?.value).toBe("50");
    expect(el.querySelector<HTMLButtonElement>('button[data-step="next"]')?.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('button[data-step="prev"]')?.disabled).toBe(false);
  });

  test("the buttons ask for the neighbour of the page last shown, not the page drawn first", () => {
    const { el, on } = pager(512, 1);
    updatePager(el, pageOf(Array.from({ length: 512 }, (_, i) => i), 7, 25), 25, "en");
    el.querySelector<HTMLButtonElement>('button[data-step="next"]')?.click();
    expect(on.page).toHaveBeenCalledExactlyOnceWith(8);
  });

  test("the range is a polite live region, so a page change is announced", () => {
    expect(pager(512, 1).el.querySelector(".pager-range")?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("Previous and Next", () => {
  test("Previous is disabled on the first page and Next on the last", () => {
    expect([pager(512, 1).prev.disabled, pager(512, 1).next.disabled]).toEqual([true, false]);
    expect([pager(512, 21).prev.disabled, pager(512, 21).next.disabled]).toEqual([false, true]);
  });

  test("pressing them asks for the neighbouring page", () => {
    const mid = pager(512, 5);
    mid.next.click();
    mid.prev.click();
    expect(mid.on.page.mock.calls).toEqual([[6], [4]]);
  });

  test("they are buttons that submit nothing, named in both languages", () => {
    expect(pager(512, 5).prev.type).toBe("button");
    expect([pager(512, 5).prev.textContent, pager(512, 5).next.textContent]).toEqual(["Previous", "Next"]);
    expect([pager(512, 5, 25, "ru").prev.textContent, pager(512, 5, 25, "ru").next.textContent]).toEqual(["Назад", "Вперёд"]);
  });
});

describe("rows per page", () => {
  test("a labelled select offers 25, 50 and 100 and shows the current one", () => {
    const { el, select } = pager(512, 1, 50);
    expect([...select.options].map((o) => o.value)).toEqual(["25", "50", "100"]);
    expect(select.value).toBe("50");
    expect(el.querySelector("label")?.textContent).toContain("Rows per page");
    expect(el.querySelector("label")?.contains(select)).toBe(true);
    expect(pager(512, 1, 25, "ru").el.querySelector("label")?.textContent).toContain("Строк на странице");
  });

  test("choosing a size reports it as a number", () => {
    const { select, on } = pager(512, 1);
    chooseSize(select, "100");
    expect(on.size).toHaveBeenCalledExactlyOnceWith(100);
  });

  test("a value that is not a size is not reported", () => {
    const { select, on } = pager(512, 1);
    select.add(Object.assign(select.ownerDocument.createElement("option"), { value: "7" }));
    chooseSize(select, "7");
    expect(on.size).not.toHaveBeenCalled();
  });
});
