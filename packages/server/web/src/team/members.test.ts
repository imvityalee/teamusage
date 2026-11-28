import { beforeEach, describe, expect, test } from "vitest";
import type { MemberRow } from "./members.js";
import { FIRST_DIRECTION, keepExisting, MAX_TICKED, tick, tickAll, tickState, toRows, untickAll, visible, type MemberListView } from "./members.js";
import { machine, member, rowsOf, team, TODAY } from "./members.fixture.js";

const view = (over: Partial<MemberListView> = {}): MemberListView => ({ query: "", onlyStale: false, sort: { by: "name", dir: "asc" }, page: 1, size: 25, ...over });
const ids = (rows: MemberRow[]) => rows.map((r) => r.id);
const idsOf = (set: ReadonlySet<number>) => [...set];

describe("toRows", () => {
  test("a member's last sync is the newest of their machines, and nobody syncing for 7 days is not syncing", () => {
    const rows = toRows(
      [member(1, [machine("2026-11-27"), machine("2026-11-01")]), member(2, [machine("2026-11-20")]), member(3, [machine("2026-11-21")]), member(4, [machine(null)]), member(5, [])],
      TODAY,
    );
    expect(rows.map((r) => [r.id, r.days, r.stale])).toEqual([[1, 0, false], [2, 7, true], [3, 6, false], [4, null, true], [5, null, true]]);
  });

  test("the newest sync is found wherever its machine stands in the list", () => {
    const [row] = toRows([member(1, [machine("2026-11-01"), machine("2026-11-26"), machine("2026-11-10"), machine(null)])], TODAY);
    expect([row?.days, row?.stale]).toEqual([1, false]);
    expect(row?.lastSyncAt).toBe(member(1, [machine("2026-11-26")]).machines[0]?.lastSyncAt);
  });

  test("a member whose machines never synced has no last sync", () => {
    const [row] = toRows([member(1, [machine(null), machine(null)])], TODAY);
    expect([row?.lastSyncAt, row?.days, row?.stale]).toEqual([null, null, true]);
  });
});

describe("visible: search, filter and the counts", () => {
  const members = [...team(511, 14), member(900, [machine(TODAY)], { name: "Aigerim Toktosunova", email: "a.t@acme.example" })];
  let rows: MemberRow[] = [];
  beforeEach(() => void (rows = rowsOf(members)));

  test("the count of people not syncing covers the whole team while a search narrows the list", () => {
    const shown = visible(rows, view({ query: "aigerim" }), "en");
    expect([shown.matching.length, shown.staleCount]).toEqual([1, 14]);
  });

  test("the search reads the name and the email, in any case", () => {
    expect(ids(visible(rows, view({ query: "A.T@ACME" }), "en").matching)).toEqual([900]);
    expect(visible(rows, view({ query: "person 0007" }), "en").matching).toHaveLength(1);
  });

  test("the filter leaves the people not syncing, and the search narrows them further", () => {
    const stale = visible(rows, view({ onlyStale: true }), "en");
    expect([stale.matching.length, stale.page.total, stale.staleCount]).toEqual([14, 14, 14]);
    expect(stale.matching.every((r) => r.stale)).toBe(true);
    expect(ids(visible(rows, view({ onlyStale: true, query: "0003" }), "en").matching)).toEqual([3]);
    expect(visible(rows, view({ onlyStale: true, query: "aigerim" }), "en").matching).toEqual([]);
  });

  test("a page is a part of the match; the match is everyone, so ticking can cover every page", () => {
    const shown = visible(rows, view({ page: 3 }), "en");
    expect([shown.matching.length, shown.page.rows.length, shown.page.from, shown.page.to]).toEqual([512, 25, 51, 75]);
  });

  test("a page past the end is the last one", () => {
    expect(visible(rows, view({ page: 99 }), "en").page.page).toBe(21);
  });
});

describe("visible: the order", () => {
  let rows: MemberRow[] = [];
  beforeEach(() => void (rows = rowsOf([
    member(1, [machine("2026-11-27")], { name: "Zoya", joinedAt: "2026-09-03T12:00:00.000Z" }),
    member(2, [machine("2026-11-20"), machine("2026-11-01")], { name: "Anna", joinedAt: "2026-10-01T12:00:00.000Z" }),
    member(3, [machine(null)], { name: "Bo", joinedAt: "2026-09-01T12:00:00.000Z" }),
    member(4, [machine("2026-11-25"), machine("2026-11-26"), machine("2026-11-24")], { name: "Anna", joinedAt: "2026-09-03T12:00:00.000Z" }),
  ])));
  const order = (by: MemberListView["sort"]["by"], dir: MemberListView["sort"]["dir"], lang: "en" | "ru" = "en") => ids(visible(rows, view({ sort: { by, dir } }), lang).matching);

  test("by name from A, equal names by id", () => {
    expect(order("name", "asc")).toEqual([2, 4, 3, 1]);
    expect(order("name", "desc")).toEqual([1, 3, 2, 4]);
  });

  test("by the number of machines", () => {
    expect(order("machines", "desc")).toEqual([4, 2, 1, 3]);
    expect(order("machines", "asc")).toEqual([1, 3, 2, 4]);
  });

  test("by last sync, and a member who never synced is last either way", () => {
    expect(order("lastSync", "desc")).toEqual([1, 4, 2, 3]);
    expect(order("lastSync", "asc")).toEqual([2, 4, 1, 3]);
  });

  test("by the day they joined", () => {
    expect(order("joined", "desc")).toEqual([2, 1, 4, 3]);
    expect(order("joined", "asc")).toEqual([3, 1, 4, 2]);
  });

  test("names compare in the language's own order", () => {
    const russian = rowsOf([member(1, [], { name: "Ёлена" }), member(2, [], { name: "Егор" }), member(3, [], { name: "Яна" }), member(4, [], { name: "Аскар" })]);
    expect(ids(visible(russian, view(), "ru").matching)).toEqual([4, 2, 1, 3]);
  });

  test("each column starts the way people look for it: names from A, the rest largest or newest first", () => {
    expect(FIRST_DIRECTION).toEqual({ name: "asc", machines: "desc", lastSync: "desc", joined: "desc" });
  });
});

describe("ticks", () => {
  let rows: MemberRow[] = [];
  beforeEach(() => void (rows = rowsOf(team(512))));

  test("ticking everyone ticks every match on every page, and stops at 500", () => {
    expect(tickAll(new Set(), rows).size).toBe(500);
    expect(tickAll(new Set(), rowsOf(team(14))).size).toBe(14);
    expect(idsOf(tickAll(new Set(), rows))).toEqual(ids(rows.slice(0, MAX_TICKED)));
  });

  test("the cap is 500", () => {
    expect(MAX_TICKED).toBe(500);
  });

  test("ticking everyone keeps what was ticked before, still within 500", () => {
    const some = new Set([rows[510]?.id as number]);
    const all = tickAll(some, rows);
    expect(all.size).toBe(500);
    expect(all.has(rows[510]?.id as number)).toBe(true);
    expect(all.has(rows[499]?.id as number)).toBe(false);
  });

  test("a tick beyond 500 is not added, and an untick always works", () => {
    const full = tickAll(new Set(), rows);
    expect(tick(full, rows[511]?.id as number)).toBe(full);
    expect(tick(full, rows[0]?.id as number).size).toBe(499);
    expect(tick(new Set([1]), 2)).toEqual(new Set([1, 2]));
  });

  test("a tick does not change the set it was given", () => {
    const before = new Set([1]);
    tick(before, 2);
    expect(before).toEqual(new Set([1]));
  });

  test("unticking everyone takes off the matches and leaves the rest", () => {
    const ticked = new Set([1, 2, 3, 600]);
    expect(untickAll(ticked, rows.slice(0, 2))).toEqual(new Set([3, 600]));
  });

  test("after a reload, ticks of people who are gone are dropped", () => {
    const kept = keepExisting(new Set([1, 2, 777, 778]), rowsOf(team(5)));
    expect(idsOf(kept).sort()).toEqual([1, 2]);
  });

  test("the header's box is unticked, ticked or mixed, by the people the search and the filter leave", () => {
    const some = rows.slice(0, 5);
    expect(tickState(new Set(), some)).toBe("none");
    expect(tickState(new Set([some[0]?.id as number]), some)).toBe("some");
    expect(tickState(new Set(ids(some)), some)).toBe("all");
    expect(tickState(new Set(ids(some)), rows.slice(0, 6))).toBe("some");
    expect(tickState(new Set([999]), some)).toBe("some");
    expect(tickState(new Set(), [])).toBe("none");
  });

  test("with more than 500 matches, the first 500 ticked is all that can be ticked", () => {
    expect(tickState(tickAll(new Set(), rows), rows)).toBe("all");
  });
});
