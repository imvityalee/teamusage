import { expect, test } from "vitest";
import { getStoredInviteCode, openDb } from "./db.js";
import { createTeamSession, findSession } from "./sessions.js";
import { createTeam, ensureSingleTeam, rotateInviteCode, singleTeamCodes } from "./teams.js";

const teamCount = (db: ReturnType<typeof openDb>) => (db.prepare("select count(*) as n from teams").get() as { n: number }).n;

test("ensureSingleTeam creates team 1 on an empty database and then keeps returning it", () => {
  const db = openDb(":memory:");
  expect(ensureSingleTeam(db)).toBe(1);
  expect(ensureSingleTeam(db)).toBe(1);
  expect(teamCount(db)).toBe(1);
});

test("ensureSingleTeam returns the lowest team id", () => {
  const db = openDb(":memory:");
  const insert = db.prepare("insert into teams (id, public_id, name, created_at) values (?, ?, 'T', 't')");
  insert.run(5, "p5");
  insert.run(3, "p3");
  expect(ensureSingleTeam(db)).toBe(3);
  expect(teamCount(db)).toBe(2);
});

test("createTeam gives each team its own 16-hex-character public id", () => {
  const db = openDb(":memory:");
  const ids = [createTeam(db, "A"), createTeam(db, "B")].map(
    (id) => (db.prepare("select public_id from teams where id = ?").get(id) as { public_id: string }).public_id,
  );
  for (const id of ids) expect(id).toMatch(/^[a-f0-9]{16}$/);
  expect(ids[0]).not.toBe(ids[1]);
});

test("singleTeamCodes gives the team for its code and null for anything else", () => {
  const teamForCode = singleTeamCodes(7, () => "the-code");
  expect(teamForCode("the-code")).toBe(7);
  expect(teamForCode("other")).toBeNull();
  expect(teamForCode(undefined)).toBeNull();
  expect(teamForCode(42)).toBeNull();
});

test("rotating the code ends only that team's sessions", () => {
  const db = openDb(":memory:");
  const A = createTeam(db, "A");
  const B = createTeam(db, "B");
  const sa = createTeamSession(db, A);
  const sb = createTeamSession(db, B);
  const code = rotateInviteCode(db, A);
  expect(code).toMatch(/^[a-f0-9]{24}$/);
  expect(getStoredInviteCode(db)).toBe(code);
  expect(findSession(db, sa)).toBeNull();
  expect(findSession(db, sb)).toEqual({ kind: "team", teamId: B });
});
