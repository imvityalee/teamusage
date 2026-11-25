import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDb, type Db } from "./db.js";
import { LEGACY_SCHEMA } from "./migrations/legacy.fixture.js";
import { createTeamSession, createUserSession, endSession, endTeamSessions, findSession } from "./sessions.js";
import { authenticate } from "./team-data.js";
import { createTeam } from "./teams.js";

const MID = "a".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const ANN = { githubId: 7, login: "ann" };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sessionCount = () => (db.prepare("select count(*) as n from sessions").get() as { n: number }).n;

let db: Db;
let A: number;
let B: number;
beforeEach(() => {
  db = openDb(":memory:");
  A = createTeam(db, "A");
  B = createTeam(db, "B");
});
afterEach(() => {
  vi.useRealTimers();
});

test("a team session is found as its team's", () => {
  expect(findSession(db, createTeamSession(db, A))).toEqual({ kind: "team", teamId: A });
  expect(findSession(db, createTeamSession(db, B))).toEqual({ kind: "team", teamId: B });
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

test("sessions of both kinds expire after 30 days", () => {
  for (const sid of [createTeamSession(db, A), createUserSession(db, ANN)]) {
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

test("endTeamSessions ends one team's sessions and leaves another team's and every user's", () => {
  const a = createTeamSession(db, A);
  const b = createTeamSession(db, B);
  const user = createUserSession(db, ANN);
  endTeamSessions(db, A);
  expect(findSession(db, a)).toBeNull();
  expect(findSession(db, b)).toEqual({ kind: "team", teamId: B });
  expect(findSession(db, user)).toEqual({ kind: "user", ...ANN });
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

test("the oldest are chosen by creation time before insertion order", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:01:00.000Z"));
  const newest = createTeamSession(db, A, 3);
  vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
  const older = Array.from({ length: 4 }, () => createTeamSession(db, A, 3));
  expect([newest, ...older].map((sid) => findSession(db, sid) !== null)).toEqual([true, false, false, true, true]);
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
