import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import { DEFAULT_SORT, nextSort, sortMembers, type MemberSort } from "./members-table.js";

type Member = Stats["members"][number];

function member(id: number, over: Partial<Member> = {}): Member {
  return { id, name: `M${id}`, email: `m${id}@example.com`, tokens: 0, costUsd: 0, machines: 1, lastSyncAt: null, byAgent: {}, byAccount: {}, byAccountPlan: [], ...over };
}
const named = (...names: string[]) => names.map((name, i) => member(i + 1, { name }));
const ids = (members: Member[]) => members.map((m) => m.id);

describe("sortMembers", () => {
  test("tokens: the largest first by default, the smallest first the other way", () => {
    const list = [member(1, { tokens: 5 }), member(2, { tokens: 9 }), member(3, { tokens: 1 })];
    expect(ids(sortMembers(list, DEFAULT_SORT, "en"))).toEqual([2, 1, 3]);
    expect(ids(sortMembers(list, { by: "tokens", dir: "asc" }, "en"))).toEqual([3, 1, 2]);
  });

  test("cost: the dearest first, or the cheapest first", () => {
    const list = [member(1, { costUsd: 2 }), member(2, { costUsd: 7 }), member(3, { costUsd: 0.5 })];
    expect(ids(sortMembers(list, { by: "cost", dir: "desc" }, "en"))).toEqual([2, 1, 3]);
    expect(ids(sortMembers(list, { by: "cost", dir: "asc" }, "en"))).toEqual([3, 1, 2]);
  });

  test("last sync: the newest first, or the oldest first", () => {
    const list = [member(1, { lastSyncAt: "2026-11-10T00:00:00.000Z" }), member(2, { lastSyncAt: "2026-11-18T00:00:00.000Z" }), member(3, { lastSyncAt: "2026-11-01T00:00:00.000Z" })];
    expect(ids(sortMembers(list, { by: "lastSync", dir: "desc" }, "en"))).toEqual([2, 1, 3]);
    expect(ids(sortMembers(list, { by: "lastSync", dir: "asc" }, "en"))).toEqual([3, 1, 2]);
  });

  test("a member who never synced is last whichever way last sync is sorted", () => {
    const list = [member(1, { lastSyncAt: null, tokens: 99 }), member(2, { lastSyncAt: "2026-11-10T00:00:00.000Z" }), member(3, { lastSyncAt: "2026-11-18T00:00:00.000Z" })];
    for (const dir of ["asc", "desc"] as const) expect(sortMembers(list, { by: "lastSync", dir }, "en").at(-1)?.id).toBe(1);
  });

  test("members who never synced keep the order of tokens, then id, among themselves", () => {
    const list = [member(4, { tokens: 1 }), member(2, { tokens: 8 }), member(3, { tokens: 8 })];
    for (const dir of ["asc", "desc"] as const) expect(ids(sortMembers(list, { by: "lastSync", dir }, "en"))).toEqual([2, 3, 4]);
  });

  test("names sort in the language's order, not by bytes", () => {
    expect(sortMembers(named("Яна", "Zed", "Ärna", "abel"), { by: "name", dir: "asc" }, "en").map((m) => m.name)).toEqual(["abel", "Ärna", "Zed", "Яна"]);
    expect(sortMembers(named("Яна", "Zed", "Ärna", "abel"), { by: "name", dir: "desc" }, "en").map((m) => m.name)).toEqual(["Яна", "Zed", "Ärna", "abel"]);
  });

  test("Russian names sort in the Russian alphabet, Ё after Е", () => {
    expect(sortMembers(named("Ёлка", "Егор", "Яна", "Анна"), { by: "name", dir: "asc" }, "ru").map((m) => m.name)).toEqual(["Анна", "Егор", "Ёлка", "Яна"]);
  });

  test("equal values keep the order of tokens, then id, whichever way they are sorted", () => {
    const list = [member(5, { costUsd: 1, tokens: 3 }), member(2, { costUsd: 1, tokens: 3 }), member(9, { costUsd: 1, tokens: 8 })];
    for (const dir of ["asc", "desc"] as const) expect(ids(sortMembers(list, { by: "cost", dir }, "en"))).toEqual([9, 2, 5]);
  });

  test("sorting does not change the list it was given", () => {
    const list = Object.freeze([member(1, { tokens: 1 }), member(2, { tokens: 2 })]) as Member[];
    expect(ids(sortMembers(list, DEFAULT_SORT, "en"))).toEqual([2, 1]);
    expect(ids(list)).toEqual([1, 2]);
  });
});

describe("nextSort", () => {
  test.each<[MemberSort, MemberSort["by"], MemberSort]>([
    [DEFAULT_SORT, "tokens", { by: "tokens", dir: "asc" }],
    [{ by: "tokens", dir: "asc" }, "tokens", { by: "tokens", dir: "desc" }],
    [DEFAULT_SORT, "name", { by: "name", dir: "asc" }],
    [DEFAULT_SORT, "cost", { by: "cost", dir: "desc" }],
    [DEFAULT_SORT, "lastSync", { by: "lastSync", dir: "desc" }],
    [{ by: "name", dir: "asc" }, "name", { by: "name", dir: "desc" }],
    [{ by: "name", dir: "desc" }, "tokens", { by: "tokens", dir: "desc" }],
  ])("from %j pressing %s gives %j", (current, pressed, expected) => {
    expect(nextSort(current, pressed)).toEqual(expected);
  });
});
