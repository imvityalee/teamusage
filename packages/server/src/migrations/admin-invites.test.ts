import { expect, test } from "vitest";
import type { Db } from "../db.js";
import { runSteps, STEPS } from "../migrate.js";
import { adminInvites } from "./admin-invites.js";
import { hostedAt7, selfHostedAt7, T } from "./earlier-version.fixture.js";

const INVITES = "admin_invites";

/** Every schema entry and every row of every table, other than the table of invites. */
function everythingButInvites(db: Db) {
  const schema = db.prepare(`select type, name, tbl_name, sql from sqlite_master where tbl_name <> '${INVITES}' order by type, name`).all();
  const tables = (schema as { type: string; name: string }[]).filter((s) => s.type === "table" && !s.name.startsWith("sqlite_"));
  return { schema, rows: Object.fromEntries(tables.map((t) => [t.name, db.prepare(`select * from ${t.name} order by rowid`).all()])) };
}

/** A hosted database upgraded to version 8; its team is team 1. */
function hostedAt8(): Db {
  const db = hostedAt7();
  runSteps(db, STEPS.slice(0, 8));
  return db;
}

const insertInvite = (db: Db, id: string, role: string, tokenHash: string) =>
  db.prepare(`insert into ${INVITES} (id, team_id, role, token_hash, created_at, expires_at) values (?, 1, ?, ?, ?, ?)`).run(id, role, tokenHash, T, T);

test.each([
  ["a hosted database", hostedAt7],
  ["a self-hosted database", selfHostedAt7],
])("in %s step 8 adds an empty table of invites and changes nothing else", (_, build) => {
  expect(STEPS[7]).toBe(adminInvites);
  const db = build();
  const before = everythingButInvites(db);
  runSteps(db, STEPS.slice(0, 8));
  expect(everythingButInvites(db)).toEqual(before);
  expect(db.prepare(`select count(*) as n from ${INVITES}`).get()).toEqual({ n: 0 });
  expect(db.pragma("user_version", { simple: true })).toBe(8);
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
test("an invite is an admin's or a viewer's, its token hash is held once, and it goes with its team", () => {
  const db = hostedAt8();
  expect(db.prepare(`select name from sqlite_master where type = 'index' and tbl_name = '${INVITES}' and name not like 'sqlite_%'`).all()).toEqual([
    { name: "admin_invites_team" },
  ]);
  insertInvite(db, "1".repeat(16), "admin", "h".repeat(64));
  insertInvite(db, "2".repeat(16), "viewer", "i".repeat(64));
  expect(() => insertInvite(db, "3".repeat(16), "owner", "j".repeat(64))).toThrow(/CHECK constraint failed/);
  expect(() => insertInvite(db, "4".repeat(16), "admin", "h".repeat(64))).toThrow(/UNIQUE constraint failed: admin_invites\.token_hash$/);
  db.prepare("delete from teams where id = 1").run();
  expect(db.prepare(`select count(*) as n from ${INVITES}`).get()).toEqual({ n: 0 });
});
