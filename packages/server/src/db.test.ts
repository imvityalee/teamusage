import { beforeEach, describe, expect, test } from "vitest";
import { getInviteCode, openDb, rotateInviteCode, type Db } from "./db.js";
import { createSession, findSession } from "./sessions.js";
import { ensureSingleTeam } from "./teams.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("invite code", () => {
  test("getInviteCode: env wins, otherwise generated once and stable", () => {
    expect(getInviteCode(db, "from-env")).toBe("from-env");
    const code = getInviteCode(db);
    expect(code).toMatch(/^[0-9a-f]{24}$/);
    expect(getInviteCode(db)).toBe(code);
  });

  test("rotateInviteCode changes the code and ends sessions", () => {
    const old = getInviteCode(db);
    const sid = createSession(db, ensureSingleTeam(db));
    expect(findSession(db, sid)).not.toBeNull();
    const next = rotateInviteCode(db);
    expect(next).not.toBe(old);
    expect(getInviteCode(db)).toBe(next);
    expect(findSession(db, sid)).toBeNull();
  });
});

describe("settings", () => {
  test("getSetting and setSetting round-trip and overwrite", async () => {
    const { openDb, getSetting, setSetting } = await import("./db.js");
    const db = openDb(":memory:");
    expect(getSetting(db, "k")).toBeUndefined();
    setSetting(db, "k", "1");
    setSetting(db, "k", "2");
    expect(getSetting(db, "k")).toBe("2");
  });
});
