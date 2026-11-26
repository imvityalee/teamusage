import { afterEach, expect, test, vi } from "vitest";
import { hostedLimits } from "./hosted-limits.js";
import type { DiskSpace } from "./storage-guard.js";
import { HOSTED_CAPS, UPLOADS_PER_MINUTE } from "./team-limits.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("a hosted server's limits are the hosted caps and the uploads a machine may send a minute", () => {
  expect(hostedLimits("/data", () => ({ free: 90, total: 100 }))).toEqual({
    team: { ...HOSTED_CAPS, storageLow: expect.any(Function) },
    uploadsPerMinute: UPLOADS_PER_MINUTE,
  });
});

test("its volume is nearly full when the directory it was given measures so", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const measured: string[] = [];
  let space: DiskSpace = { free: 90, total: 100 };
  const { team } = hostedLimits("/srv/teamusage", (dir) => {
    measured.push(dir);
    return space;
  });
  expect(team.storageLow()).toBe(false);
  space = { free: 10, total: 100 };
  expect(team.storageLow()).toBe(true);
  expect(measured).toEqual(["/srv/teamusage", "/srv/teamusage"]);
});
