import { expect, test } from "vitest";
import { openDb, sha256, type Db } from "../db.js";
import { runSteps, STEPS } from "../migrate.js";
import { findSession, type Session } from "../sessions.js";
import { forTeam } from "../team-data.js";
import { reg } from "../team-data.fixture.js";
import { createTeam } from "../teams.js";
import { atVersion, insertHostedTeam, T } from "./earlier-version.fixture.js";
import { memberSessions } from "./member-sessions.js";

/** The ids of a browser signed in with a team's code and of one signed in with GitHub; the databases hold their hashes. */
const CODE_SESSION = "c".repeat(64);
const USER_SESSION = "u".repeat(64);
const MID = "a".repeat(32);

const insertCodeSession = (db: Db, teamId: number) =>
  db.prepare("insert into sessions (id, kind, team_id, created_at) values (?, 'team', ?, ?)").run(sha256(CODE_SESSION), teamId, T);

/** A hosted server at version 6: marked as hosted, a team with its code hashed and sealed and its owner, a browser signed in with the code and one with GitHub. */
function hostedAt6(): Db {
  const db = atVersion(6);
  db.exec("insert into settings (key, value) values ('mode', 'hosted')");
  const team = insertHostedTeam(db, "Aurora", "members");
  db.exec(`
    insert into users (id, github_id, login, created_at) values (4, 41, 'bob', '${T}');
    insert into team_roles (team_id, user_id, role, created_at) values (${team}, 4, 'owner', '${T}');
  `);
  insertCodeSession(db, team);
  db.prepare("insert into sessions (id, kind, github_id, github_login, created_at) values (?, 'user', 41, 'bob', ?)").run(sha256(USER_SESSION), T);
  return db;
}

/** A self-hosted server at version 6: its invite code, its one team without a code hash, and a browser signed in with the code. */
function selfHostedAt6(): Db {
  const db = atVersion(6);
  db.exec(`
    insert into settings (key, value) values ('invite_code', '${"e".repeat(24)}');
    insert into teams (public_id, name, created_at) values ('${"1".repeat(16)}', 'Team', '${T}');
  `);
  insertCodeSession(db, 1);
  return db;
}

const SESSIONS = "select id, kind, team_id, github_id, github_login, created_at from sessions order by id";

test.each<[string, () => Db, [string, Session][]]>([
  ["a hosted database", hostedAt6, [[CODE_SESSION, { kind: "team", teamId: 1 }], [USER_SESSION, { kind: "user", githubId: 41, login: "bob" }]]],
  ["a self-hosted database", selfHostedAt6, [[CODE_SESSION, { kind: "team", teamId: 1 }]]],
])("in %s every session stays as it was, signed in and no member's", (_, build, sessions) => {
  expect(STEPS[6]).toBe(memberSessions);
  const db = build();
  const before = db.prepare(SESSIONS).all();
  runSteps(db, STEPS.slice(0, 7));
  expect(db.prepare(SESSIONS).all()).toEqual(before);
  expect(db.prepare("select machine_id, member_id from sessions").all()).toEqual(sessions.map(() => ({ machine_id: null, member_id: null })));
  for (const [id, session] of sessions) expect(findSession(db, id, new Date(T))).toEqual(session);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

test("on a current database a session holds exactly the columns of its kind, and a member's machine is one its team has", () => {
  const db = openDb(":memory:");
  const a = createTeam(db, "A");
  const b = createTeam(db, "B");
  const { memberId } = forTeam(db, b).registerMachine(reg(MID));
  const insert = db.prepare(
    "insert into sessions (id, kind, team_id, machine_id, member_id, github_id, github_login, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  expect(() => insert.run("1", "member", b, null, memberId, null, null, T)).toThrow(/CHECK constraint failed/);
  expect(() => insert.run("2", "team", b, MID, null, null, null, T)).toThrow(/CHECK constraint failed/);
  expect(() => insert.run("3", "user", null, MID, null, 41, "bob", T)).toThrow(/CHECK constraint failed/);
  expect(() => insert.run("4", "member", a, MID, memberId, null, null, T)).toThrow(/FOREIGN KEY constraint failed/);
  expect(() => insert.run("5", "member", b, MID, memberId, null, null, T)).not.toThrow();
});
