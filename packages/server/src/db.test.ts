import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import { createSession, getInviteCode, hasSession, openDb, rotateInviteCode, type Db } from "./db.js";
import { LEGACY_SCHEMA } from "./legacy-schema.fixture.js";
import { authenticate } from "./team-data.js";

const MID = "a".repeat(32);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("invite code and sessions", () => {
  test("getInviteCode: env wins, otherwise generated once and stable", () => {
    expect(getInviteCode(db, "from-env")).toBe("from-env");
    const code = getInviteCode(db);
    expect(code).toMatch(/^[0-9a-f]{24}$/);
    expect(getInviteCode(db)).toBe(code);
  });

  test("rotateInviteCode changes the code and ends sessions", () => {
    const old = getInviteCode(db);
    const sid = createSession(db);
    expect(hasSession(db, sid)).toBe(true);
    const next = rotateInviteCode(db);
    expect(next).not.toBe(old);
    expect(getInviteCode(db)).toBe(next);
    expect(hasSession(db, sid)).toBe(false);
  });

  test("unknown session id is not valid and ids are unique", () => {
    expect(hasSession(db, "nope")).toBe(false);
    expect(createSession(db)).not.toBe(createSession(db));
  });

  test("session ids are stored hashed", () => {
    const sid = createSession(db);
    const rows = db.prepare("select * from sessions").all() as Record<string, unknown>[];
    expect(rows.flatMap((r) => Object.values(r))).not.toContain(sid);
    expect(hasSession(db, sid)).toBe(true);
  });

  test("sessions expire after 30 days", () => {
    const sid = createSession(db);
    const day = 24 * 60 * 60 * 1000;
    expect(hasSession(db, sid, new Date(Date.now() + 29 * day))).toBe(true);
    expect(hasSession(db, sid, new Date(Date.now() + 31 * day))).toBe(false);
  });

  test("creating a session deletes sessions older than 30 days", () => {
    const old = createSession(db);
    const fresh = createSession(db);
    const day = 24 * 60 * 60 * 1000;
    const set = db.prepare("update sessions set created_at = ? where id = ?");
    set.run(new Date(Date.now() - 31 * day).toISOString(), sha(old));
    set.run(new Date(Date.now() - 29 * day).toISOString(), sha(fresh));
    createSession(db);
    expect((db.prepare("select count(*) as n from sessions").get() as { n: number }).n).toBe(2);
    expect(hasSession(db, fresh)).toBe(true);
  });

  test("a token and a session from before the upgrade still work", () => {
    const dir = mkdtempSync(join(tmpdir(), "teamusage-"));
    const file = join(dir, "t.sqlite");
    const token = "t".repeat(64);
    const session = "c".repeat(64);
    const old = new Database(file);
    old.exec(LEGACY_SCHEMA);
    old.exec(`insert into members (id, email, name, created_at) values (1, 'ann@x.com', 'Ann', 't');
      insert into machines (id, member_id, label, token_hash, created_at) values ('${MID}', 1, 'mbp', '${sha(token)}', 't');
      insert into sessions (id, created_at) values ('${sha(session)}', '${new Date().toISOString()}');`);
    old.close();
    const db = openDb(file);
    expect(authenticate(db, token)).toEqual({ teamId: 1, memberId: 1, machineId: MID });
    expect(hasSession(db, session)).toBe(true);
    db.close();
    rmSync(dir, { recursive: true });
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
