import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { legacy } from "./migrations/legacy.fixture.js";
import { migrate, NewerSchemaError, runSteps, SCHEMA_VERSION, STEPS, UpgradeFailedError, type Step } from "./migrate.js";

const version = (db: Db) => db.pragma("user_version", { simple: true });
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
test("a database from a newer release is still refused as such", () => {
  const db = legacy();
  db.pragma("user_version = 99");
  expect(() => migrate(db)).toThrow(NewerSchemaError);
});
test("a failing step leaves the version and the tables as they were", () => {
  const db = legacy();
  const boom: Step = (d) => { d.exec("create table half_done (x)"); throw new Error("boom"); };
  expect(() => runSteps(db, [STEPS[0]!, boom])).toThrow("boom");
  expect(version(db)).toBe(1);
  expect(db.prepare("select 1 from sqlite_master where name = 'half_done'").get()).toBeUndefined();
  expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
});
test("a failing step is reported with its number and its cause", () => {
  const db = legacy();
  const boom: Step = () => { throw Object.assign(new Error("boom /private/path"), { code: "SQLITE_FULL" }); };
  let caught: unknown;
  try { runSteps(db, [STEPS[0]!, boom]); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(UpgradeFailedError);
  expect((caught as UpgradeFailedError).step).toBe(2);
  expect(((caught as UpgradeFailedError).cause as Error).message).toBe("boom /private/path");
  expect(version(db)).toBe(1);
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

test("the team schema has its indexes and every foreign key cascades on delete", () => {
  const db = openDb(":memory:");
  const indexes = db.prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_autoindex%' order by name").all();
  expect(indexes.map((r) => (r as { name: string }).name)).toEqual([
    "admin_invites_team",
    "machines_team_member",
    "sessions_github",
    "sessions_machine",
    "sessions_member",
    "team_roles_one_owner",
    "team_roles_user",
    "teams_code_hash",
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
  expect(foreignKeys("sessions")).toEqual(["machines CASCADE", "teams CASCADE"]);
  expect(foreignKeys("dashboard_links")).toEqual(["machines CASCADE"]);
  expect(foreignKeys("team_roles")).toEqual(["teams CASCADE", "users CASCADE"]);
  expect(foreignKeys("admin_invites")).toEqual(["teams CASCADE"]);
  expect(foreignKeys("users")).toEqual([]);
});
