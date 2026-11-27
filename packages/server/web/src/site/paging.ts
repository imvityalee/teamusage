/** Paging a long list into pages of rows, and the one thing the table pages store: how many rows a page holds. */

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export type Page<T> = { rows: T[]; page: number; pages: number; from: number; to: number; total: number };

/** Page `page` (from 1) of `all`; a page past the end is the last one. `from` and `to` count from 1 and are 0 for an empty list. */
export function pageOf<T>(all: T[], page: number, size: PageSize): Page<T> {
  const pages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(Math.trunc(page) || 1, 1), pages);
  const start = (current - 1) * size;
  const rows = all.slice(start, start + size);
  return { rows, page: current, pages, from: rows.length === 0 ? 0 : start + 1, to: start + rows.length, total: all.length };
}

export const ROWS_KEY = "teamusage.rows";

/** The stored page size; 25 when nothing valid is stored or storage is blocked. */
export function loadPageSize(): PageSize {
  try {
    const stored = localStorage.getItem(ROWS_KEY);
    return PAGE_SIZES.find((size) => String(size) === stored) ?? PAGE_SIZES[0];
  } catch {
    return PAGE_SIZES[0];
  }
}

/** Remembers the page size. A blocked or full storage means the choice lasts for this visit only. */
export function savePageSize(size: PageSize): void {
  try {
    localStorage.setItem(ROWS_KEY, String(size));
  } catch {
    // Storage blocked or full: the choice lasts for this visit.
  }
}
