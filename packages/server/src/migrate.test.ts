import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { LEGACY_SCHEMA } from "./legacy-schema.fixture.js";
import { migrate, NewerSchemaError, runSteps, SCHEMA_VERSION, STEPS, type Step } from "./migrate.js";

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
