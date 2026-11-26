import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import { MID, MID2 } from "./app.fixture.js";
import { db as appDb, bearer, getStatsReq, login, RANGE, register, sessionCookie, useFreshApp } from "./app.harness.js";
import type { Db } from "./db.js";
import { migrate } from "./migrate.js";
import { STATS_BOUNDS, StatsTooLargeError, type StatsBounds } from "./stats-bounds.js";
import { getStats } from "./stats.js";
import { newTeam, Q, rec, seed } from "./stats.fixture.js";
import { forTeam } from "./team-data.js";
import { createTeam, ensureSingleTeam } from "./teams.js";

type Rec = ReturnType<typeof rec>;
type Member = { memberId: number; machineId: string };

const small: StatsBounds = { memberGroups: 4, dayGroups: 6, agents: 2, models: 3 };
const DAY = "2026-11-02";

let db: Db;
let team: number;
let ann: Member;
let machines = 0;

/** Registers a new member of team `t` with one machine and stores `records` for it. */
function addMember(t: number, records: Rec[]): Member {
  const n = ++machines;
  const machineId = n.toString(16).padStart(32, "0");
  const data = forTeam(db, t);
  const { memberId } = data.registerMachine({ name: `M${n}`, email: `m${n}@x.com`, machineId, machineLabel: "l" });
  data.upsertUsage({ memberId, machineId }, records);
  return { memberId, machineId };
}

const storeForAnn = (records: Rec[]) => forTeam(db, team).upsertUsage(ann, records);

beforeEach(() => {
  ({ db, team } = newTeam());
  ann = addMember(team, []);
});

type Bound = "member groups" | "day groups" | "agents" | "models";

/** The i-th group or name of each bound, as one usage record. */
const nth: Record<Bound, (i: number) => Rec> = {
  "member groups": () => rec(DAY, "claude", "m1", 10),
  "day groups": (i) => rec(`2026-11-0${i + 1}`, "claude", "m1", 10),
  agents: (i) => rec(DAY, `agent${i}`, "m1", 10),
  models: (i) => rec(DAY, "claude", `m${i}`, 10),
};
const SIZE: Record<Bound, number> = {
  "member groups": small.memberGroups,
  "day groups": small.dayGroups,
  agents: small.agents,
  models: small.models,
};

/** Stores usage up to the bound ("at") or one group or name past it ("over"); each member group is a member of its own. */
function fillTo(bound: Bound, size: "at" | "over"): void {
  const [from, to] = size === "at" ? [0, SIZE[bound]] : [SIZE[bound], SIZE[bound] + 1];
  for (let i = from; i < to; i++) {
    if (bound === "member groups") addMember(team, [nth[bound](i)]);
    else storeForAnn([nth[bound](i)]);
  }
}

test("the bounds are the agreed values", () =>
  expect(STATS_BOUNDS).toEqual({ memberGroups: 30000, dayGroups: 60000, agents: 50, models: 2000 }));

test("usage within the bounds gives the answer it gives without them", () => {
  const s = seed();
  const unbounded = { memberGroups: 1e9, dayGroups: 1e9, agents: 1e9, models: 1e9 };
  expect(getStats(s.db, s.team, Q, unbounded)).toEqual(getStats(s.db, s.team, Q));
});

test.each<[Bound, string]>([
  ["member groups", "four members each on one agent are shown; a fifth member's usage is too much"],
  ["day groups", "one model on six days is shown; on a seventh day it is too much"],
  ["agents", "two agents are shown; a third is too much"],
  ["models", "three models of one agent are shown; a fourth is too much"],
])("%s: %s", (bound) => {
  fillTo(bound, "at");
  expect(() => getStats(db, team, Q, small)).not.toThrow();
  fillTo(bound, "over");
  expect(() => getStats(db, team, Q, small)).toThrow(StatsTooLargeError);
});

test("rows outside the range, and another team's rows, do not count towards a bound", () => {
  fillTo("models", "at");
  storeForAnn([rec("2026-10-31", "claude", "before", 10), rec("2026-11-11", "claude", "after", 10)]);
  const other = createTeam(db, "Other");
  for (let i = 0; i < 5; i++) addMember(other, [rec(DAY, `agent${i}`, `other${i}`, 10)]);
  expect(() => getStats(db, other, Q, small)).toThrow(StatsTooLargeError);
  expect(() => getStats(db, team, Q, small)).not.toThrow();
});

test("a filter does not hide usage that is too large", () => {
  fillTo("models", "at");
  fillTo("models", "over");
  const filter = { agents: ["claude"], models: [{ agent: "claude", model: "m0" }] };
  expect(() => getStats(db, team, { ...Q, ...filter }, small)).toThrow(StatsTooLargeError);
});

test("a member's view is bounded too", () => {
  fillTo("day groups", "at");
  expect(() => getStats(db, team, { ...Q, memberId: ann.memberId }, small)).not.toThrow();
  fillTo("day groups", "over");
  expect(() => getStats(db, team, { ...Q, memberId: ann.memberId }, small)).toThrow(StatsTooLargeError);
});

/** Each statement on `usage` that getStats runs, as `<its first group column> <its limit>`. */
function usageLimits(q: { memberId?: number; agents?: string[] }): string[] {
  const seen: string[] = [];
  const captured = new Database(":memory:", { verbose: (sql) => seen.push(String(sql)) });
  migrate(captured);
  const t = createTeam(captured, "A");
  seen.length = 0;
  getStats(captured, t, { ...Q, ...q }, small);
  return seen
    .filter((sql) => /from usage u/.test(sql))
    .map((sql) => `${/group by u\.(\w+)/.exec(sql)?.[1]} ${Number(/\blimit ([\d.]+)\s*$/.exec(sql)?.[1])}`);
}
test("every pass asks SQLite for no more than its bound plus one", () => {
  expect(usageLimits({})).toEqual(["date 7", "member_id 5"]);
  expect(usageLimits({ memberId: 1 })).toEqual(["date 7", "member_id 5"]);
  expect(usageLimits({ agents: ["claude"] })).toEqual(["date 7", "date 7", "member_id 5"]);
});

describe("GET /api/stats of a team whose usage is too large", () => {
  useFreshApp();
  const TOO_LARGE = { error: "this team's usage has too many different agents, models or accounts to show", limit: "stats" };
  const BATCH = 500;

  /** Registers Ann and stores 2,001 different models in range for her machine; returns her token. */
  async function fillTeam(): Promise<string> {
    const { token, memberId } = await register();
    const records = Array.from({ length: 2001 }, (_, i) => rec(DAY, "claude", `m${i}`, 10));
    const data = forTeam(appDb, ensureSingleTeam(appDb));
    for (let i = 0; i < records.length; i += BATCH) data.upsertUsage({ memberId, machineId: MID }, records.slice(i, i + BATCH));
    return token;
  }

  async function expectTooLarge(res: Response): Promise<void> {
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(TOO_LARGE);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  }

  test("a machine token and a session are answered 409, with no-store", async () => {
    const token = await fillTeam();
    await expectTooLarge(await getStatsReq(RANGE, bearer(token)));
    await expectTooLarge(await getStatsReq(RANGE, { Cookie: sessionCookie(await login()) }));
  });

  test("a request without a credential is still 401", async () => {
    await fillTeam();
    const res = await getStatsReq(RANGE);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a member's own view of their few rows is still 200", async () => {
    await fillTeam();
    const bob = await register({ name: "Bob", email: "bob@example.com", machineId: MID2 });
    const records = [rec(DAY, "claude", "m0", 10), rec(DAY, "claude", "m1", 20), rec("2026-11-03", "codex", "g", 30)];
    forTeam(appDb, ensureSingleTeam(appDb)).upsertUsage({ memberId: bob.memberId, machineId: MID2 }, records);
    const res = await getStatsReq(`${RANGE}&member=me`, bearer(bob.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { totals: { tokens: number } }).totals.tokens).toBe(60);
  });
});
