import { afterEach, describe, expect, test, vi } from "vitest";
import { loadPageSize, pageOf, PAGE_SIZES, ROWS_KEY, savePageSize, type PageSize } from "./paging.js";

test.each([
  [0, 1, 25, { rows: 0, page: 1, pages: 1, from: 0, to: 0, total: 0 }],
  [1, 1, 25, { rows: 1, page: 1, pages: 1, from: 1, to: 1, total: 1 }],
  [512, 1, 25, { rows: 25, page: 1, pages: 21, from: 1, to: 25, total: 512 }],
  [512, 21, 25, { rows: 12, page: 21, pages: 21, from: 501, to: 512, total: 512 }],
  [512, 99, 25, { rows: 12, page: 21, pages: 21, from: 501, to: 512, total: 512 }],
  [512, 0, 100, { rows: 100, page: 1, pages: 6, from: 1, to: 100, total: 512 }],
  [25, 1, 25, { rows: 25, page: 1, pages: 1, from: 1, to: 25, total: 25 }],
  [26, 2, 25, { rows: 1, page: 2, pages: 2, from: 26, to: 26, total: 26 }],
  [50, 2, 25, { rows: 25, page: 2, pages: 2, from: 26, to: 50, total: 50 }],
])("pageOf(%i items, page %i, %i rows)", (n, page, size, expected) => {
  const p = pageOf(Array.from({ length: n }, (_, i) => i), page, size as PageSize);
  expect({ ...p, rows: p.rows.length }).toEqual(expected);
});

test("a page holds the items that follow the earlier pages, in order", () => {
  const all = Array.from({ length: 60 }, (_, i) => i);
  expect(pageOf(all, 2, 25).rows).toEqual(all.slice(25, 50));
});

test("a page that is not a number is the first", () => {
  expect(pageOf([1, 2, 3], Number.NaN, 25).page).toBe(1);
});

describe("the rows-per-page choice", () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial));
    vi.stubGlobal("localStorage", { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
    return map;
  };

  test("lives under teamusage.rows and nothing else is written", () => {
    const map = store();
    savePageSize(100);
    expect(ROWS_KEY).toBe("teamusage.rows");
    expect([...map]).toEqual([["teamusage.rows", "100"]]);
    expect(loadPageSize()).toBe(100);
  });

  test("is 25 when nothing is stored", () => {
    store();
    expect(loadPageSize()).toBe(25);
  });

  test.each(PAGE_SIZES)("a stored %i is read back", (size) => {
    store({ [ROWS_KEY]: String(size) });
    expect(loadPageSize()).toBe(size);
  });

  test.each(["10", "0", "-25", "26", "101", "2000", "050", "25.0", "1e2", "", " 25", "abc", "null"])("a stored %j is not a size: 25", (value) => {
    store({ [ROWS_KEY]: value });
    expect(loadPageSize()).toBe(25);
  });

  test("a blocked storage gives 25 and saving does not throw", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(loadPageSize()).toBe(25);
    expect(() => savePageSize(50)).not.toThrow();
  });
});
