import { afterEach, expect, test, vi } from "vitest";
import { openDb } from "./db.js";
import { reusableBytes } from "./db-space.js";
import { hostedLimits } from "./hosted-limits.js";
import type { DiskSpace } from "./storage-guard.js";
import { removeMachineRows, storeRows } from "./team-data.fixture.js";
import { HOSTED_CAPS, UPLOADS_PER_MINUTE } from "./team-limits.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("a hosted server's limits are the hosted caps, the uploads a machine may send a minute and a team's budgets a minute", () => {
  expect(hostedLimits({ dataDir: "/data", db: openDb(":memory:"), measure: () => ({ free: 90, total: 100 }) })).toEqual({
    team: { ...HOSTED_CAPS, storageLow: expect.any(Function) },
    uploadsPerMinute: UPLOADS_PER_MINUTE,
    teamUploadRecordsPerMinute: 60_000,
    teamStatsMsPerMinute: 6_000,
  });
});

test("its volume is nearly full when the directory it was given measures so", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const measured: string[] = [];
  let space: DiskSpace = { free: 90, total: 100 };
  const { team } = hostedLimits({
    dataDir: "/srv/teamusage",
    db: openDb(":memory:"),
    measure: (dir) => {
      measured.push(dir);
      return space;
    },
  });
  expect(team.storageLow()).toBe(false);
  space = { free: 10, total: 100 };
  expect(team.storageLow()).toBe(true);
  expect(measured).toEqual(["/srv/teamusage", "/srv/teamusage"]);
});

test("room that removed rows left in its database lifts the guard", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const db = openDb(":memory:");
  const { team } = hostedLimits({ dataDir: "/data", db, measure: () => ({ free: 1_000_000, total: 10_000_000 }) });
  expect(team.storageLow()).toBe(true);
  storeRows(db, "M1", 5000);
  removeMachineRows(db, "M1");
  expect(reusableBytes(db)).toBeGreaterThanOrEqual(500_000);
  expect(team.storageLow()).toBe(false);
});
