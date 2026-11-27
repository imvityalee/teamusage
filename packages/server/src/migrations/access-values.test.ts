import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { codeHash, newTeamCode, sealCode } from "../codes.js";
import type { Db } from "../db.js";
import { newPublicId } from "../hosted-teams.js";
import { runSteps, STEPS } from "../migrate.js";
import { accessValues } from "./access-values.js";

const T = "2026-11-01T00:00:00.000Z";
const MID = "a".repeat(32);
const KEY = Buffer.alloc(32, 9);

/** An empty database brought to version 5 by the steps of that release. */
function atVersion5(): Db {
  const db = new Database(":memory:");
  runSteps(db, STEPS.slice(0, 5));
  return db;
}

/** Inserts a hosted team with its code hashed and sealed; returns its id. */
function insertHostedTeam(db: Db, name: string, access: string): number {
  const code = newTeamCode();
  const { lastInsertRowid } = db
    .prepare("insert into teams (public_id, name, dashboard_access, code_hash, code_sealed, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(newPublicId(), name, access, codeHash(code), sealCode(code, KEY), T);
  return Number(lastInsertRowid);
}

/** A self-hosted server at version 5: its invite code, its one team on code and without a code hash, and a browser signed in with the code. */
function selfHostedAt5(): Db {
  const db = atVersion5();
  db.exec(`
    insert into settings (key, value) values ('invite_code', '${"e".repeat(24)}');
    insert into teams (public_id, name, dashboard_access, created_at) values ('${"1".repeat(16)}', 'Team', 'code', '${T}');
    insert into sessions (id, kind, team_id, created_at) values ('${"s".repeat(64)}', 'team', 1, '${T}');
  `);
  return db;
}

/**
 * A hosted server at version 5: marked as hosted, team 1 on admins and team 2 on code, each with its owner; team 2's member 7
 * has a machine and a usage row.
 */
function hostedAt5(): Db {
  const db = atVersion5();
  db.exec("insert into settings (key, value) values ('mode', 'hosted')");
  const admins = insertHostedTeam(db, "Aurora", "admins");
  const open = insertHostedTeam(db, "Borealis", "code");
  db.exec(`
    insert into users (id, github_id, login, created_at) values (4, 31, 'ann', '${T}'), (5, 41, 'bob', '${T}');
    insert into team_roles (team_id, user_id, role, created_at) values (${admins}, 4, 'owner', '${T}'), (${open}, 5, 'owner', '${T}');
    insert into sessions (id, kind, github_id, github_login, created_at) values ('${"u".repeat(64)}', 'user', 41, 'bob', '${T}');
    insert into members (id, team_id, email, name, created_at) values (7, ${open}, 'zeb@x.com', 'Zeb', '${T}');
    insert into machines (team_id, id, member_id, label, token_hash, created_at, last_sync_at)
      values (${open}, '${MID}', 7, 'box', '${"g".repeat(64)}', '${T}', '${T}');
    insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total,
        cost_usd, unpriced, account_kind, account_org, account_plan)
      values (${open}, 7, '${MID}', '2026-11-01', 'claude', 'm', 1, 2, 3, 4, 10, 0.25, 0, 'org', 'Acme', 'max');
    insert into usage_counts (team_id, rows, day, added) values (${open}, 1, '2026-11-01', 1);
  `);
  return db;
}

/** A hosted database upgraded to version 6. */
function hostedAt6(): Db {
  const db = hostedAt5();
  runSteps(db, STEPS.slice(0, 6));
  return db;
}

const TEAMS_BUT_ACCESS = "select id, public_id, name, created_at, code_hash, code_sealed from teams order by id";
const OTHER_TABLES = ["settings", "users", "team_roles", "sessions", "members", "machines", "usage", "usage_counts"];
const everythingButAccess = (db: Db) => ({
  teams: db.prepare(TEAMS_BUT_ACCESS).all(),
  ...Object.fromEntries(OTHER_TABLES.map((t) => [t, db.prepare(`select * from ${t} order by rowid`).all()])),
});

test.each([
  ["a self-hosted database", selfHostedAt5, ["members"]],
  ["a hosted database", hostedAt5, ["admins", "members"]],
])("in %s code becomes members, admins stays, and nothing else of a team changes", (_, build, access) => {
  expect(STEPS[5]).toBe(accessValues);
  const db = build();
  const before = everythingButAccess(db);
  runSteps(db, STEPS.slice(0, 6));
  expect(everythingButAccess(db)).toEqual(before);
  expect(db.prepare("select dashboard_access as a from teams order by id").all()).toEqual(access.map((a) => ({ a })));
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("the old value is refused from then on, and a new team's default is members", () => {
  const db = hostedAt6();
  expect(() => db.prepare("update teams set dashboard_access = 'code' where id = 1").run()).toThrow(/CHECK constraint failed/);
  const { lastInsertRowid } = db
    .prepare("insert into teams (public_id, name, code_hash, code_sealed, created_at) values (?, 'Cygnus', ?, 'v1.x', ?)")
    .run(newPublicId(), "c".repeat(64), T);
  expect(db.prepare("select dashboard_access as a from teams where id = ?").get(lastInsertRowid)).toEqual({ a: "members" });
});
test("team ids are still never handed out again", () => {
  const db = hostedAt6();
  db.prepare("delete from teams where id = 2").run();
  expect(insertHostedTeam(db, "Cygnus", "members")).toBe(3);
});
test("two teams still cannot share a code hash", () => {
  const db = hostedAt6();
  const { code_hash } = db.prepare("select code_hash from teams where id = 2").get() as { code_hash: string };
  const insert = db.prepare("insert into teams (public_id, name, code_hash, code_sealed, created_at) values (?, 'Cygnus', ?, 'v1.x', ?)");
  expect(() => insert.run(newPublicId(), code_hash, T)).toThrow(/UNIQUE constraint failed: teams\.code_hash$/);
});
