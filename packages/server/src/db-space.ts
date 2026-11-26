import type { Db } from "./db.js";

/** The bytes of the database file that hold nothing and that SQLite fills before it grows the file. */
export function reusableBytes(db: Db): number {
  const pages = db.pragma("freelist_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  return pages * pageSize;
}
