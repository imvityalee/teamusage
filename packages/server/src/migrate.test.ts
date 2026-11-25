import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { LEGACY_SCHEMA } from "./legacy-schema.fixture.js";
import { migrate, NewerSchemaError, runSteps, SCHEMA_VERSION, STEPS, type Step } from "./migrate.js";
import { createTeam } from "./teams.js";

const version = (db: Db) => db.pragma("user_version", { simple: true });
const legacy = (): Db => { const db = new Database(":memory:"); db.exec(LEGACY_SCHEMA); return db; };
const insertOrphanMachine = (db: Db) =>
  db.exec("insert into machines (id, member_id, label, token_hash, created_at) values ('m', 99, 'l', 'h', 't')");

test("a new database ends at the current schema version", () => {
  expect(version(openDb(":memory:"))).toBe(SCHEMA_VERSION);
});
test("a 0.1 database without account columns gets them", () => {
  const db = legacy();
  migrate(db);
  const cols = (db.prepare("pragma table_info(usage)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining(["account_kind", "account_org", "account_plan"]));
});
test("migrating twice changes nothing", () => {
  const db = legacy();
  migrate(db);
  const before = db.prepare("select sql from sqlite_master order by name").all();
  migrate(db);
  expect(db.prepare("select sql from sqlite_master order by name").all()).toEqual(before);
});
test("a database from a newer release is refused and left untouched", () => {
  const db = legacy();
  db.pragma("user_version = 99");
  expect(() => migrate(db)).toThrow(NewerSchemaError);
  expect(version(db)).toBe(99);
});
test("a failing step leaves the version and the tables as they were", () => {
  const db = legacy();
  const boom: Step = (d) => { d.exec("create table half_done (x)"); throw new Error("boom"); };
  expect(() => runSteps(db, [STEPS[0]!, boom])).toThrow("boom");
  expect(version(db)).toBe(1);
  expect(db.prepare("select 1 from sqlite_master where name = 'half_done'").get()).toBeUndefined();
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});
test("a later step that leaves a dangling reference is rolled back", () => {
  const db = legacy();
  expect(() => runSteps(db, [STEPS[0]!, insertOrphanMachine])).toThrow("refers to a missing row");
  expect(version(db)).toBe(1);
  expect(db.prepare("select count(*) as n from machines").get()).toEqual({ n: 0 });
});
test("a legacy database with a dangling row still upgrades", () => {
  const db = legacy();
  db.pragma("foreign_keys = OFF");
  insertOrphanMachine(db);
  migrate(db);
  expect(version(db)).toBe(SCHEMA_VERSION);
});
test("a step that was already applied is not run again and the version does not move backwards", () => {
  const ran: number[] = [];
  const steps: Step[] = [() => { ran.push(1); }, () => { ran.push(2); }];
  const atTwo = new Database(":memory:");
  atTwo.pragma("user_version = 2");
  runSteps(atTwo, steps);
  expect(ran).toEqual([]);
  expect(version(atTwo)).toBe(2);
  const atOne = new Database(":memory:");
  atOne.pragma("user_version = 1");
  runSteps(atOne, steps);
  expect(ran).toEqual([2]);
  expect(version(atOne)).toBe(2);
});

const MID = "a".repeat(32);
const H = "h".repeat(64); // a token hash
const S = "s".repeat(64); // a session id hash

/** A 0.3 database: one member, one machine, two usage rows, one session. */
function legacyWithData(): Db {
  const db = legacy();
  runSteps(db, [STEPS[0]!]);
  // A 0.3 database has the account columns and has never recorded a version.
  db.pragma("user_version = 0");
  db.exec(`
    insert into members (id, email, name, created_at) values (7, 'ann@x.com', 'Ann', '2026-11-01T00:00:00.000Z');
    insert into machines (id, member_id, label, token_hash, created_at, last_sync_at)
      values ('${MID}', 7, 'mbp', '${H}', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
    insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
      values (7, '${MID}', '2026-11-01', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0),
             (7, '${MID}', '2026-11-02', 'claude', 'm', 2, 2, 2, 2, 8, 1.0, 0);
    insert into sessions (id, created_at) values ('${S}', '${new Date().toISOString()}');
  `);
  return db;
}

test("a 0.3 database moves into team 1 and keeps its ids, tokens, usage and sessions", () => {
  const db = legacyWithData();
  migrate(db);
  expect(version(db)).toBe(2);
  expect(db.prepare("select id, name, dashboard_access from teams").all()).toEqual([{ id: 1, name: "Team", dashboard_access: "code" }]);
  expect(db.prepare("select id, team_id, email from members").all()).toEqual([{ id: 7, team_id: 1, email: "ann@x.com" }]);
  expect(db.prepare("select team_id, id, member_id, token_hash, last_sync_at from machines").all()).toEqual([
    { team_id: 1, id: MID, member_id: 7, token_hash: H, last_sync_at: "2026-11-02T00:00:00.000Z" },
  ]);
  expect(db.prepare("select sum(total) as total, count(*) as n from usage where team_id = 1").get()).toEqual({ total: 12, n: 2 });
  expect(db.prepare("select team_id from sessions where id = ?").get(S)).toEqual({ team_id: 1 });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("an empty database gets the tables and no team", () => {
  const db = openDb(":memory:");
  expect(db.prepare("select count(*) as n from teams").get()).toEqual({ n: 0 });
});
test("orphan machines and usage are dropped and the upgrade finishes", () => {
  const db = legacyWithData();
  db.pragma("foreign_keys = OFF");
  db.exec(`insert into machines (id, member_id, label, token_hash, created_at) values ('${"b".repeat(32)}', 99, 'ghost', 'x', 't');
    insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
      values (99, '${"c".repeat(32)}', '2026-11-01', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0);`);
  migrate(db);
  expect(db.prepare("select count(*) as n from machines").get()).toEqual({ n: 1 });
  expect(db.prepare("select count(*) as n from usage").get()).toEqual({ n: 2 });
});
test("one email twice in a team is refused, in two teams it is allowed", () => {
  const db = openDb(":memory:");
  const a = createTeam(db, "A");
  const b = createTeam(db, "B");
  const member = db.prepare("insert into members (team_id, email, name, created_at) values (?, 'ann@x.com', 'Ann', 't')");
  member.run(a);
  member.run(b);
  expect(() => member.run(a)).toThrow();
});
test("a machine cannot point at a member of another team", () => {
  const db = openDb(":memory:");
  const a = createTeam(db, "A");
  const b = createTeam(db, "B");
  const id = db.prepare("insert into members (team_id, email, name, created_at) values (?, 'ann@x.com', 'Ann', 't')").run(a).lastInsertRowid;
  expect(() =>
    db.prepare("insert into machines (team_id, id, member_id, label, token_hash, created_at) values (?, ?, ?, 'l', 'h', 't')").run(b, MID, id),
  ).toThrow();
});
test("the id of a member removed before the upgrade is not handed out again", () => {
  const db = legacy();
  db.exec("insert into members (email, name, created_at) values ('a@x.com', 'A', 't'), ('b@x.com', 'B', 't'); delete from members where id = 2;");
  migrate(db);
  const next = db.prepare("insert into members (team_id, email, name, created_at) values (1, 'c@x.com', 'C', 't')").run();
  expect(next.lastInsertRowid).toBe(3);
});
