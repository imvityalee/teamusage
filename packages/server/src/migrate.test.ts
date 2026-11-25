import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
test("adds columns to an old database", () => {
  const dir = mkdtempSync(join(tmpdir(), "tu-"));
  const file = join(dir, "old.db");
  const old = new Database(file);
  old.exec(`
    create table members (id integer primary key autoincrement, email text not null unique, name text not null, created_at text not null);
    create table machines (id text primary key, member_id integer not null references members(id) on delete cascade, label text not null, token_hash text not null unique, created_at text not null, last_sync_at text);
    create table usage (member_id integer not null, machine_id text not null, date text not null, agent text not null, model text not null,
      input integer not null, output integer not null, cache_create integer not null, cache_read integer not null, total integer not null,
      cost_usd real not null, unpriced integer not null, primary key (machine_id, date, agent, model));
    insert into members values (1, 'a@example.com', 'A', 't');
    insert into machines values ('m1', 1, 'mbp', 'h', 't', null);
    insert into usage values (1, 'm1', '2026-11-17', 'claude', 'x', 1, 0, 0, 0, 1, 0, 0);
  `);
  old.close();
  openDb(file).close();
  const again = openDb(file);
  const cols = (again.prepare("pragma table_info(usage)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("account_kind");
  expect(cols).toContain("account_org");
  expect(again.prepare("select account_kind, account_org from usage").get()).toEqual({
    account_kind: null,
    account_org: null,
  });
  again.close();
  rmSync(dir, { recursive: true });
});
test("adds account_plan to an old database", () => {
  const dir = mkdtempSync(join(tmpdir(), "tu-"));
  const file = join(dir, "old03.db");
  const old = new Database(file);
  old.exec(`
    create table members (id integer primary key autoincrement, email text not null unique, name text not null, created_at text not null);
    create table machines (id text primary key, member_id integer not null references members(id) on delete cascade, label text not null, token_hash text not null unique, created_at text not null, last_sync_at text);
    create table usage (member_id integer not null, machine_id text not null, date text not null, agent text not null, model text not null,
      input integer not null, output integer not null, cache_create integer not null, cache_read integer not null, total integer not null,
      cost_usd real not null, unpriced integer not null, account_kind text, account_org text, primary key (machine_id, date, agent, model));
    insert into members values (1, 'a@example.com', 'A', 't');
    insert into machines values ('m1', 1, 'mbp', 'h', 't', null);
    insert into usage values (1, 'm1', '2026-11-17', 'claude', 'x', 1, 0, 0, 0, 1, 0, 0, 'team', 'D');
  `);
  old.close();
  const again = openDb(file);
  const cols = (again.prepare("pragma table_info(usage)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("account_plan");
  expect(again.prepare("select account_plan from usage").get()).toEqual({ account_plan: null });
  again.close();
  rmSync(dir, { recursive: true });
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

/** An empty 0.3 database: it has the account columns and has never recorded a version. */
function legacy03(): Db {
  const db = legacy();
  runSteps(db, [STEPS[0]!]);
  db.pragma("user_version = 0");
  return db;
}

/** A 0.3 database: one member, one machine, two usage rows, one session. */
function legacyWithData(): Db {
  const db = legacy03();
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
  runSteps(db, STEPS.slice(0, 2));
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
test("a version 2 database swaps the usage indexes for the ordered ones and keeps its rows", () => {
  const db = legacyWithData();
  runSteps(db, STEPS.slice(0, 2));
  const rows = () => db.prepare("select * from usage order by date, agent, model").all();
  const before = rows();
  runSteps(db, STEPS.slice(0, 3));
  expect(version(db)).toBe(3);
  const names = (db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'usage' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((r) => r.name);
  expect(names).toEqual(["usage_by_day", "usage_by_member"]);
  expect(rows()).toEqual(before);
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
test("every column of every row is copied unchanged into team 1", () => {
  const db = legacy03();
  db.exec(`
    insert into members (id, email, name, created_at) values (7, 'ann@x.com', 'Ann', '2026-10-01T01:00:00.000Z');
    insert into machines (id, member_id, label, token_hash, created_at, last_sync_at)
      values ('${MID}', 7, 'mbp', '${H}', '2026-10-02T02:00:00.000Z', '2026-10-03T03:00:00.000Z');
    insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced,
        account_kind, account_org, account_plan)
      values (7, '${MID}', '2026-10-04', 'codex', 'gpt', 11, 12, 13, 14, 50, 0.75, 1, 'team', 'Org', 'team_premium');
    insert into sessions (id, created_at) values ('${S}', '2026-10-05T05:00:00.000Z');
  `);
  migrate(db);
  expect(db.prepare("select * from members").all()).toEqual([
    { id: 7, team_id: 1, email: "ann@x.com", name: "Ann", created_at: "2026-10-01T01:00:00.000Z" },
  ]);
  expect(db.prepare("select * from machines").all()).toEqual([
    {
      team_id: 1, id: MID, member_id: 7, label: "mbp", token_hash: H,
      created_at: "2026-10-02T02:00:00.000Z", last_sync_at: "2026-10-03T03:00:00.000Z",
    },
  ]);
  expect(db.prepare("select * from usage").all()).toEqual([
    {
      team_id: 1, member_id: 7, machine_id: MID, date: "2026-10-04", agent: "codex", model: "gpt",
      input: 11, output: 12, cache_create: 13, cache_read: 14, total: 50, cost_usd: 0.75, unpriced: 1,
      account_kind: "team", account_org: "Org", account_plan: "team_premium",
    },
  ]);
  expect(db.prepare("select * from sessions").all()).toEqual([{ id: S, team_id: 1, created_at: "2026-10-05T05:00:00.000Z" }]);
});
/** Inserts a usage row with dangling references switched off, as a database from before versioned upgrades may hold. */
const insertOrphanUsage = (db: Db, memberId: number, machineId: string) => {
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
       values (?, ?, '2026-11-03', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0)`,
  ).run(memberId, machineId);
};
test("a usage row whose machine is gone is dropped and the upgrade finishes", () => {
  const db = legacyWithData();
  insertOrphanUsage(db, 7, "c".repeat(32));
  migrate(db);
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect(db.prepare("select count(*) as n from usage").get()).toEqual({ n: 2 });
});
test("a usage row whose member is gone is dropped and the upgrade finishes", () => {
  const db = legacyWithData();
  insertOrphanUsage(db, 99, MID);
  migrate(db);
  expect(version(db)).toBe(SCHEMA_VERSION);
  expect(db.prepare("select count(*) as n from usage").get()).toEqual({ n: 2 });
});
test("a database with sessions and no members still moves into team 1 and keeps the session", () => {
  const db = legacy03();
  db.exec(`insert into sessions (id, created_at) values ('${S}', '2026-11-01T00:00:00.000Z')`);
  migrate(db);
  expect(db.prepare("select id from teams").all()).toEqual([{ id: 1 }]);
  expect(db.prepare("select * from sessions").all()).toEqual([{ id: S, team_id: 1, created_at: "2026-11-01T00:00:00.000Z" }]);
});
test("the team schema has its indexes and every foreign key cascades on delete", () => {
  const db = openDb(":memory:");
  const indexes = db.prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_autoindex%' order by name").all();
  expect(indexes.map((r) => (r as { name: string }).name)).toEqual([
    "machines_team_member",
    "sessions_team",
    "usage_by_day",
    "usage_by_member",
  ]);
  /** One "<parent table> <on delete>" entry per foreign key; a key over two columns is listed once. */
  const foreignKeys = (table: string): string[] => {
    const rows = db.pragma(`foreign_key_list(${table})`) as { id: number; table: string; on_delete: string }[];
    return [...new Map(rows.map((r) => [r.id, `${r.table} ${r.on_delete}`])).values()].sort();
  };
  expect(foreignKeys("members")).toEqual(["teams CASCADE"]);
  expect(foreignKeys("machines")).toEqual(["members CASCADE", "teams CASCADE"]);
  expect(foreignKeys("usage")).toEqual(["machines CASCADE", "members CASCADE"]);
  expect(foreignKeys("sessions")).toEqual(["teams CASCADE"]);
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
