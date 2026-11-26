import { tmpdir } from "node:os";
import { beforeEach, expect, test } from "vitest";
import { diskSpace, storageGuard, type DiskSpace } from "./storage-guard.js";

const FULL_LINE = "teamusage: less than 15% of the data volume is free; requests that add rows are refused";
const ROOM_LINE = "teamusage: the data volume has room again; requests that add rows are accepted";
const UNMEASURABLE_LINE = "teamusage: could not measure the free space of the data volume (ENOENT); the disk guard is off";

let lines: string[];
beforeEach(() => {
  lines = [];
});

const guard = (space: () => DiskSpace) => storageGuard({ dir: "/data", measure: space, log: (l) => lines.push(l) });
const failing = (): DiskSpace => {
  throw Object.assign(new Error("no such file /private/path"), { code: "ENOENT" });
};

/** A guard whose measurement is whatever `next` says: a space, or "fail". */
function scripted() {
  let next: DiskSpace | "fail" = { free: 500, total: 1000 };
  const check = guard(() => (next === "fail" ? failing() : next));
  return {
    check,
    set: (state: "room" | "full" | "fail") => {
      next = state === "fail" ? "fail" : { free: state === "full" ? 100 : 500, total: 1000 };
    },
  };
}

test("less than 15% free is nearly full; exactly 15% is not", () => {
  expect(guard(() => ({ free: 149, total: 1000 }))()).toBe(true);
  expect(guard(() => ({ free: 150, total: 1000 }))()).toBe(false);
});
test("it measures at every call and logs only when the answer changes", () => {
  let free = 500;
  const low = guard(() => ({ free, total: 1000 }));
  expect([low(), low()]).toEqual([false, false]);
  free = 100;
  expect([low(), low()]).toEqual([true, true]);
  free = 400;
  expect(low()).toBe(false);
  expect(lines).toEqual([FULL_LINE, ROOM_LINE]);
});
test("a volume that cannot be measured is not full, and says so once", () => {
  const low = guard(failing);
  expect([low(), low()]).toEqual([false, false]);
  expect(lines).toEqual([UNMEASURABLE_LINE]);
});
test("a volume reported as empty of blocks is not full", () => expect(guard(() => ({ free: 0, total: 0 }))()).toBe(false));
test("nearly full to cannot be measured logs only that the guard is off", () => {
  const { check, set } = scripted();
  set("full");
  check();
  set("fail");
  expect(check()).toBe(false);
  expect(lines).toEqual([FULL_LINE, UNMEASURABLE_LINE]);
});
test("cannot be measured to nearly full logs the full line", () => {
  const { check, set } = scripted();
  set("fail");
  check();
  set("full");
  expect(check()).toBe(true);
  expect(lines).toEqual([UNMEASURABLE_LINE, FULL_LINE]);
});
test("cannot be measured to room logs nothing", () => {
  const { check, set } = scripted();
  set("fail");
  check();
  set("room");
  expect(check()).toBe(false);
  expect(lines).toEqual([UNMEASURABLE_LINE]);
});
test("a second run of failures after a good measurement logs again", () => {
  const { check, set } = scripted();
  set("fail");
  check();
  set("room");
  check();
  set("fail");
  check();
  check();
  expect(lines).toEqual([UNMEASURABLE_LINE, UNMEASURABLE_LINE]);
});
test("the real measurement of a real directory gives two numbers that make sense", () => {
  const { free, total } = diskSpace(tmpdir());
  expect(total).toBeGreaterThan(0);
  expect(free).toBeGreaterThanOrEqual(0);
  expect(free).toBeLessThanOrEqual(total);
});
