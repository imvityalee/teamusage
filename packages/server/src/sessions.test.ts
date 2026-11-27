import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDb, type Db } from "./db.js";
import { machineIdOf } from "./hosted.fixture.js";
import { migrate } from "./migrate.js";
import { LEGACY_SCHEMA } from "./migrations/legacy.fixture.js";
import { createMemberSession, createTeamSession, createUserSession, endSession, endTeamSessions, findSession, MAX_TEAM_SESSIONS, MAX_USER_SESSIONS } from "./sessions.js";
import { authenticate, forTeam, type MachineIdentity } from "./team-data.js";
import { reg } from "./team-data.fixture.js";
import { createTeam } from "./teams.js";

const MID = "a".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const ANN = { githubId: 7, login: "ann" };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sessionCount = () => (db.prepare("select count(*) as n from sessions").get() as { n: number }).n;
/** Machine `n` of the member with `email` in team `teamId`, as its token identifies it. */
const machineOf = (teamId: number, email: string, n: number): MachineIdentity =>
  authenticate(db, forTeam(db, teamId).registerMachine(reg(machineIdOf(n), { email })).token)!;
const found = (sid: string) => findSession(db, sid) !== null;

let db: Db;
let A: number;
let B: number;
/** A's member ann, then B's members sam (two machines) and tia; B's member ids differ from A's and from both team ids. */
let ann: MachineIdentity, samOne: MachineIdentity, samTwo: MachineIdentity, tia: MachineIdentity;
beforeEach(() => {
  db = openDb(":memory:");
  A = createTeam(db, "A");
  B = createTeam(db, "B");
  ann = machineOf(A, "ann@x.com", 1);
  machineOf(A, "abe@x.com", 2);
  samOne = machineOf(B, "sam@x.com", 3);
  // tia joins before sam's second machine: registering a known member's machine uses up a member id.
  tia = machineOf(B, "tia@x.com", 5);
  samTwo = machineOf(B, "sam@x.com", 4);
});
afterEach(() => {
  vi.useRealTimers();
});

test("a team session is found as its team's", () => {
  expect(findSession(db, createTeamSession(db, A))).toEqual({ kind: "team", teamId: A });
  expect(findSession(db, createTeamSession(db, B))).toEqual({ kind: "team", teamId: B });
});

test("a member's session is found as that member's, from the machine that opened it", () => {
  expect([samOne.memberId, tia.memberId]).toEqual([3, 4]);
  expect(findSession(db, createMemberSession(db, samTwo))).toEqual({ kind: "member", teamId: B, memberId: samTwo.memberId, machineId: samTwo.machineId });
});

test("a user session is found as its user's", () => {
  expect(findSession(db, createUserSession(db, ANN))).toEqual({ kind: "user", githubId: 7, login: "ann" });
});

test("an unknown session id is null and ids are unique", () => {
  expect(findSession(db, "nope")).toBeNull();
  expect(createTeamSession(db, A)).not.toBe(createTeamSession(db, A));
  expect(createUserSession(db, ANN)).not.toBe(createUserSession(db, ANN));
});

test("session ids of both kinds are stored only as their hashes", () => {
  const ids = [createTeamSession(db, A), createUserSession(db, ANN)];
  const rows = db.prepare("select * from sessions").all() as Record<string, unknown>[];
  const stored = rows.flatMap((r) => Object.values(r));
  for (const id of ids) expect(stored).not.toContain(id);
  expect(rows.map((r) => r.id)).toEqual(ids.map(sha));
});

test("sessions of every kind expire after 30 days", () => {
  for (const sid of [createTeamSession(db, A), createMemberSession(db, samOne), createUserSession(db, ANN)]) {
    expect(findSession(db, sid, new Date(Date.now() + 29 * DAY_MS))).not.toBeNull();
    expect(findSession(db, sid, new Date(Date.now() + 31 * DAY_MS))).toBeNull();
  }
});

test("creating a session of either kind deletes sessions older than 30 days", () => {
  const set = db.prepare("update sessions set created_at = ? where id = ?");
  const ageDays = (sid: string, days: number) => set.run(new Date(Date.now() - days * DAY_MS).toISOString(), sha(sid));
  const fresh = createTeamSession(db, B);
  ageDays(fresh, 29);
  ageDays(createTeamSession(db, A), 31);
  createTeamSession(db, A);
  expect(sessionCount()).toBe(2);
  ageDays(createUserSession(db, ANN), 31);
  createUserSession(db, ANN);
  expect(sessionCount()).toBe(3);
  expect(findSession(db, fresh)).toEqual({ kind: "team", teamId: B });
});

test("endSession ends only that session", () => {
  const [a1, a2, user] = [createTeamSession(db, A), createTeamSession(db, A), createUserSession(db, ANN)];
  endSession(db, a1);
  endSession(db, "nope");
  expect(findSession(db, a1)).toBeNull();
  expect(findSession(db, a2)).toEqual({ kind: "team", teamId: A });
  expect(findSession(db, user)).toEqual({ kind: "user", ...ANN });
  endSession(db, user);
  expect(findSession(db, user)).toBeNull();
});

test("endTeamSessions ends one team's code and member sessions and leaves another team's and every user's", () => {
  const ended = [createTeamSession(db, B), createMemberSession(db, samOne), createMemberSession(db, tia)];
  const kept = [createTeamSession(db, A), createMemberSession(db, ann), createUserSession(db, ANN)];
  endTeamSessions(db, B);
  expect(ended.map(found)).toEqual([false, false, false]);
  expect(kept.map(found)).toEqual([true, true, true]);
});

test("a member holding more than its maximum keeps its newest sessions; another member's and another team's are not counted or dropped", () => {
  const others = [createMemberSession(db, tia), createMemberSession(db, ann), createTeamSession(db, B), createUserSession(db, ANN)];
  const sam = [createMemberSession(db, samOne, 2), createMemberSession(db, samTwo, 2), createMemberSession(db, samOne, 2)];
  expect(sam.map(found)).toEqual([false, true, true]);
  expect(others.map(found)).toEqual([true, true, true, true]);
});

test("a team holding more than its maximum keeps its newest sessions, oldest dropped first within one millisecond", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  const b = createTeamSession(db, B);
  const user = createUserSession(db, ANN);
  const a = Array.from({ length: 5 }, () => createTeamSession(db, A, 3));
  expect(a.map((sid) => findSession(db, sid) !== null)).toEqual([false, false, true, true, true]);
  expect(findSession(db, b)).toEqual({ kind: "team", teamId: B });
  expect(findSession(db, user)).toEqual({ kind: "user", ...ANN });
});

test("the cap on a team's sessions is 2,000", () => {
  expect(MAX_TEAM_SESSIONS).toBe(2000);
});

test("the oldest are chosen by creation time before insertion order", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:01:00.000Z"));
  const newest = createTeamSession(db, A, 3);
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  const older = Array.from({ length: 4 }, () => createTeamSession(db, A, 3));
  expect([newest, ...older].map((sid) => findSession(db, sid) !== null)).toEqual([true, false, false, true, true]);
});

test("the cap on one account's sessions is 20", () => expect(MAX_USER_SESSIONS).toBe(20));

test("an account holding more than its maximum keeps its newest sessions; other accounts and teams keep theirs", () => {
  const bob = createUserSession(db, { githubId: 8, login: "bob" });
  const team = createTeamSession(db, A);
  const ann = Array.from({ length: 5 }, () => createUserSession(db, ANN, 3));
  expect(ann.map((sid) => findSession(db, sid) !== null)).toEqual([false, false, true, true, true]);
  expect(findSession(db, bob)).toEqual({ kind: "user", githubId: 8, login: "bob" });
  expect(findSession(db, team)).toEqual({ kind: "team", teamId: A });
});

test("a team's cap leaves a user session alone, and an account's cap leaves a team session alone", () => {
  const account = { githubId: A, login: "same-number-as-the-team" };
  for (let i = 0; i < 3; i++) {
    createTeamSession(db, A, 1);
    createUserSession(db, account, 1);
  }
  expect(db.prepare("select kind from sessions order by kind").all()).toEqual([{ kind: "team" }, { kind: "user" }]);
});

test("an account's sessions are capped at 20 when no maximum is given", () => {
  const sessions = Array.from({ length: MAX_USER_SESSIONS + 1 }, () => createUserSession(db, ANN));
  expect(sessions.map((sid) => findSession(db, sid) !== null)).toEqual([false, ...Array(MAX_USER_SESSIONS).fill(true)]);
});

test.each(["team", "user"] as const)("a %s session opened after the clock stepped back is kept, and the oldest other one is dropped", (kind) => {
  const open = () => (kind === "team" ? createTeamSession(db, A, 3) : createUserSession(db, ANN, 3));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:01:00.000Z"));
  const earlier = [open(), open(), open()];
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  const latest = open();
  expect(findSession(db, latest)).not.toBeNull();
  expect(earlier.map((sid) => findSession(db, sid) !== null)).toEqual([false, true, true]);
});

test.each([
  ["an account's", "user", "sessions_github"],
  ["a member's", "member", "sessions_member"],
] as const)("%s sessions are found through their index", (_, kind, index) => {
  const seen: string[] = [];
  const verboseDb = new Database(":memory:", { verbose: (sql) => seen.push(String(sql)) });
  migrate(verboseDb);
  if (kind === "user") createUserSession(verboseDb, ANN);
  else createMemberSession(verboseDb, authenticate(verboseDb, forTeam(verboseDb, createTeam(verboseDb, "A")).registerMachine(reg(MID)).token)!);
  const plans = seen
    .filter((sql) => /delete from sessions where rowid in/.test(sql) && sql.includes(`'${kind}'`))
    .map((sql) => (verboseDb.prepare(`explain query plan ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | "));
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain(index);
});

test("a token and a session from before the upgrade still work", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamusage-"));
  const file = join(dir, "t.sqlite");
  const token = "t".repeat(64);
  const session = "c".repeat(64);
  const old = new Database(file);
  old.exec(LEGACY_SCHEMA);
  old.exec(`insert into members (id, email, name, created_at) values (1, 'ann@x.com', 'Ann', 't');
    insert into machines (id, member_id, label, token_hash, created_at) values ('${MID}', 1, 'mbp', '${sha(token)}', 't');
    insert into sessions (id, created_at) values ('${sha(session)}', '${new Date().toISOString()}');`);
  old.close();
  const upgraded = openDb(file);
  expect(authenticate(upgraded, token)).toEqual({ teamId: 1, memberId: 1, machineId: MID });
  expect(findSession(upgraded, session)).toEqual({ kind: "team", teamId: 1 });
  upgraded.close();
  rmSync(dir, { recursive: true });
});
