import { describe, expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { pageOf, type PageSize } from "./paging.js";
import { renderPager } from "./pager.js";
import { chooseSize } from "./pager.fixture.js";
import type { Lang } from "../lang.js";

const doc = () => new Window().document as unknown as Document;

/** The no-break space the runtime's Russian number format puts between thousands (U+00A0 on this runtime; the assertion below names it). */
const THOUSANDS = new Intl.NumberFormat("ru-RU").format(2000).charAt(1);

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
    expect(THOUSANDS).toBe(" "); // U+00A0 NO-BREAK SPACE is what this runtime's ru-RU format gives
    expect(pager(2000, 1, 25, "ru").range).toBe(`1–25 из 2${THOUSANDS}000`);
  });
});

describe("Previous and Next", () => {
  test("Previous is disabled on the first page and Next on the last", () => {
    expect([pager(512, 1).prev.disabled, pager(512, 1).next.disabled]).toEqual([true, false]);
    expect([pager(512, 21).prev.disabled, pager(512, 21).next.disabled]).toEqual([false, true]);
    expect([pager(10, 1).prev.disabled, pager(10, 1).next.disabled]).toEqual([true, true]);
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
