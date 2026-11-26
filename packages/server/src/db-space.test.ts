import { statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openDb } from "./db.js";
import { reusableBytes } from "./db-space.js";
import { tempDir } from "./main.fixture.js";
import { removeMachineRows, storeRows } from "./team-data.fixture.js";

const PAGE_SIZE = 4096;

test("removed rows leave room that new rows fill, and the file does not shrink", () => {
  const file = join(tempDir(), "space.db");
  const db = openDb(file);
  try {
    const sizeOnDisk = () => (db.pragma("wal_checkpoint(TRUNCATE)"), statSync(file).size);
    storeRows(db, "M1", 3000);
    const before = reusableBytes(db);
    const sizeBefore = sizeOnDisk();
    removeMachineRows(db, "M1");
    const removed = reusableBytes(db);
    expect(removed % PAGE_SIZE).toBe(0);
    expect(removed - before).toBeGreaterThanOrEqual(300_000);
    expect(sizeOnDisk()).toBeGreaterThanOrEqual(sizeBefore);
    storeRows(db, "M2", 3000, 3000);
    expect(reusableBytes(db)).toBeLessThan(removed);
  } finally {
    db.close();
  }
});
