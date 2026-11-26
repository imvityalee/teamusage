import { expect, test } from "vitest";
import { openDb, type Db } from "../db.js";
import { migrate, runSteps, STEPS } from "../migrate.js";
import { legacyWithData, MID } from "./legacy.fixture.js";

/** Adds team 2 with one member, one machine and three usage rows to a version 4 database. */
function addSecondTeam(db: Db): void {
  db.exec(`
    insert into teams (id, public_id, name, created_at) values (2, 'second', 'B', '2026-11-01T00:00:00.000Z');
    insert into members (id, team_id, email, name, created_at) values (8, 2, 'bob@x.com', 'Bob', '2026-11-01T00:00:00.000Z');
    insert into machines (team_id, id, member_id, label, token_hash, created_at)
      values (2, '${MID}', 8, 'box', '${"g".repeat(64)}', '2026-11-01T00:00:00.000Z');
    insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
      values (2, 8, '${MID}', '2026-11-01', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0),
             (2, 8, '${MID}', '2026-11-02', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0),
             (2, 8, '${MID}', '2026-11-03', 'claude', 'm', 1, 1, 1, 1, 4, 0.5, 0);
  `);
}

test("an upgraded database counts the rows each team already holds", () => {
  const db = legacyWithData();
  runSteps(db, STEPS.slice(0, 4));
  addSecondTeam(db);
  const held = db.prepare("select team_id, count(*) as n from usage group by team_id order by team_id").all();
  expect(held).toEqual([{ team_id: 1, n: 2 }, { team_id: 2, n: 3 }]);
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
