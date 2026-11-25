import { expect, test } from "vitest";
import { openDb, type Db } from "../db.js";
import { migrate, runSteps, SCHEMA_VERSION, STEPS } from "../migrate.js";
import { createTeam } from "../teams.js";
import { H, legacy, legacy03, legacyWithData, MID, S } from "./legacy.fixture.js";

const version = (db: Db) => db.pragma("user_version", { simple: true });

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
