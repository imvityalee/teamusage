import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { LEGACY_SCHEMA } from "./legacy-schema.fixture.js";
import { createSession, endTeamSessions, findSession } from "./sessions.js";
import { authenticate } from "./team-data.js";
import { createTeam } from "./teams.js";

const MID = "a".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let db: Db;
let A: number;
let B: number;
beforeEach(() => {
  db = openDb(":memory:");
  A = createTeam(db, "A");
  B = createTeam(db, "B");
});

test("a created session is found with its team", () => {
  expect(findSession(db, createSession(db, A))).toEqual({ teamId: A });
  expect(findSession(db, createSession(db, B))).toEqual({ teamId: B });
});

test("an unknown session id is null and ids are unique", () => {
  expect(findSession(db, "nope")).toBeNull();
  expect(createSession(db, A)).not.toBe(createSession(db, A));
});

test("session ids are stored hashed", () => {
  const sid = createSession(db, A);
  const rows = db.prepare("select * from sessions").all() as Record<string, unknown>[];
  expect(rows.flatMap((r) => Object.values(r))).not.toContain(sid);
  expect(findSession(db, sid)).toEqual({ teamId: A });
});

test("sessions expire after 30 days", () => {
  const sid = createSession(db, A);
  expect(findSession(db, sid, new Date(Date.now() + 29 * DAY_MS))).toEqual({ teamId: A });
  expect(findSession(db, sid, new Date(Date.now() + 31 * DAY_MS))).toBeNull();
});

test("creating a session deletes sessions older than 30 days", () => {
  const old = createSession(db, A);
  const fresh = createSession(db, B);
  const set = db.prepare("update sessions set created_at = ? where id = ?");
  set.run(new Date(Date.now() - 31 * DAY_MS).toISOString(), sha(old));
  set.run(new Date(Date.now() - 29 * DAY_MS).toISOString(), sha(fresh));
  createSession(db, A);
  expect((db.prepare("select count(*) as n from sessions").get() as { n: number }).n).toBe(2);
  expect(findSession(db, fresh)).toEqual({ teamId: B });
});

test("endTeamSessions ends one team's sessions and leaves another team's", () => {
  const a = createSession(db, A);
  const b = createSession(db, B);
  endTeamSessions(db, A);
  expect(findSession(db, a)).toBeNull();
  expect(findSession(db, b)).toEqual({ teamId: B });
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
  expect(findSession(upgraded, session)).toEqual({ teamId: 1 });
  upgraded.close();
  rmSync(dir, { recursive: true });
});
