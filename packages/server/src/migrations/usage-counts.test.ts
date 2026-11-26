import { expect, test } from "vitest";
import { openDb, type Db } from "../db.js";
import { migrate, runSteps, STEPS } from "../migrate.js";
import { legacyWithData } from "./legacy.fixture.js";

test("an upgraded database counts the rows each team already holds", () => {
  const db = legacyWithData();
  runSteps(db, STEPS.slice(0, 4));
  const held = db.prepare("select team_id, count(*) as n from usage group by team_id order by team_id").all();
  expect(held.length).toBeGreaterThan(0);
  runSteps(db, STEPS.slice(0, 5));
  expect(db.prepare("select team_id, rows as n from usage_counts order by team_id").all()).toEqual(held);
  expect(db.prepare("select day, added from usage_counts").all()).toEqual(held.map(() => ({ day: "", added: 0 })));
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("a new database and an upgraded one end with the same usage_counts table", () => {
  const schema = (db: Db) =>
    db.prepare("select type, name, sql from sqlite_master where tbl_name = 'usage_counts' order by type, name").all();
  const upgraded = legacyWithData();
  migrate(upgraded);
  const fresh = schema(openDb(":memory:"));
  expect(fresh).toHaveLength(1);
  expect(schema(upgraded)).toEqual(fresh);
});
