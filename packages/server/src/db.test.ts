import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import type { UsageRecord } from "@teamusage/shared";
import {
  authenticate,
  createSession,
  getInviteCode,
  hasSession,
  listMembers,
  openDb,
  registerMachine,
  removeMachine,
  removeMember,
  rotateInviteCode,
  upsertUsage,
  type Db,
} from "./db.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const reg = (machineId: string, over: Partial<Parameters<typeof registerMachine>[1]> = {}) => ({
  name: "A",
  email: "a@example.com",
  machineId,
  machineLabel: "mbp",
  ...over,
});

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  date: "2026-11-01",
  agent: "claude",
  model: "opus",
  input: 10,
  output: 0,
  cacheCreate: 0,
  cacheRead: 0,
  total: 10,
  costUsd: 1,
  unpriced: false,
  ...over,
});

const count = (table: string): number =>
  (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("registration", () => {
  test("email is trimmed and lower-cased: one member", () => {
    const a = registerMachine(db, { name: "A", email: " Vlad@Example.com ", machineId: "m1", machineLabel: "mbp" });
    const b = registerMachine(db, { name: "A", email: "vlad@example.com", machineId: "m2", machineLabel: "mini" });
    expect(a.memberId).toBe(b.memberId);
    expect(listMembers(db)[0]!.machines).toHaveLength(2);
  });

  test("re-registering a machine rotates its token and keeps one machine", () => {
    const first = registerMachine(db, reg("m1"));
    const second = registerMachine(db, reg("m1"));
    expect(authenticate(db, first.token)).toBeNull();
    expect(authenticate(db, second.token)).toEqual({ memberId: second.memberId, machineId: "m1" });
    expect(listMembers(db)[0]!.machines).toHaveLength(1);
  });

  test("latest registration wins the display name", () => {
    registerMachine(db, reg("m1", { name: "Old" }));
    registerMachine(db, reg("m2", { name: "New" }));
    expect(listMembers(db)[0]!.name).toBe("New");
  });

  test("a machine id already owned by another member is rejected", () => {
    registerMachine(db, reg("m1"));
    expect(() => registerMachine(db, reg("m1", { email: "b@example.com" }))).toThrow(/another member/);
  });

  test("token is 32 random bytes hex and unknown tokens do not authenticate", () => {
    const { token } = registerMachine(db, reg("m1"));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(authenticate(db, "nope")).toBeNull();
  });

  test("tokens are not stored in clear", () => {
    const { token } = registerMachine(db, reg("m1"));
    const row = db.prepare("select * from machines").get() as Record<string, unknown>;
    expect(Object.values(row)).not.toContain(token);
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

describe("usage", () => {
  const setup = () => {
    const { memberId } = registerMachine(db, reg("m1"));
    return { memberId, machineId: "m1" };
  };

  test("same batch twice stores one row", () => {
    const who = setup();
    upsertUsage(db, who, [rec()]);
    upsertUsage(db, who, [rec()]);
    expect(count("usage")).toBe(1);
  });

  test("higher total replaces, lower total is kept", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ total: 100, input: 100 })]);
    expect(upsertUsage(db, who, [rec({ total: 40, input: 40 })])).toEqual({ stored: 0, kept: 1 });
    expect(upsertUsage(db, who, [rec({ total: 150, input: 150 })])).toEqual({ stored: 1, kept: 0 });
    expect((db.prepare("select total, input from usage").get() as { total: number; input: number })).toEqual({
      total: 150,
      input: 150,
    });
  });

  test("duplicate keys within one batch end with the higher total, in either order", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ total: 50, input: 50 }), rec({ total: 20, input: 20 })]);
    upsertUsage(db, who, [rec({ date: "2026-11-02", total: 20, input: 20 }), rec({ date: "2026-11-02", total: 50, input: 50 })]);
    const rows = db.prepare("select total from usage order by date").all();
    expect(rows).toEqual([{ total: 50 }, { total: 50 }]);
  });

  test("identity comes from who, not from fields on the record", () => {
    const a = registerMachine(db, reg("m1"));
    const b = registerMachine(db, reg("m2", { email: "b@example.com" }));
    upsertUsage(db, { memberId: b.memberId, machineId: "m2" }, [rec({ total: 77, input: 77 })]);
    const evil = { ...rec({ total: 5, input: 5 }), machineId: "m2", memberId: b.memberId };
    upsertUsage(db, { memberId: a.memberId, machineId: "m1" }, [evil]);
    expect(db.prepare("select machine_id, member_id, total from usage order by machine_id").all()).toEqual([
      { machine_id: "m1", member_id: a.memberId, total: 5 },
      { machine_id: "m2", member_id: b.memberId, total: 77 },
    ]);
  });

  test("upsert for a machine that no longer exists fails and stores nothing", () => {
    const who = setup();
    removeMachine(db, "m1");
    expect(() => upsertUsage(db, who, [rec()])).toThrow();
    expect(count("usage")).toBe(0);
  });

  test("sets last_sync_at on the machine", () => {
    const who = setup();
    expect(listMembers(db)[0]!.machines[0]!.lastSyncAt).toBeNull();
    upsertUsage(db, who, [rec()]);
    expect(listMembers(db)[0]!.machines[0]!.lastSyncAt).not.toBeNull();
  });

  test("two machines of one member keep separate rows for the same day", () => {
    const a = registerMachine(db, reg("m1"));
    const b = registerMachine(db, reg("m2"));
    upsertUsage(db, { memberId: a.memberId, machineId: "m1" }, [rec()]);
    upsertUsage(db, { memberId: b.memberId, machineId: "m2" }, [rec()]);
    expect(count("usage")).toBe(2);
  });
});

describe("account label", () => {
  const setup = () => {
    const { memberId } = registerMachine(db, reg("m1"));
    return { memberId, machineId: "m1" };
  };
  const base = { date: "2026-11-17", agent: "claude" as const, model: "x" };
  const label = (): { account_kind: string | null; account_org: string | null; total: number } =>
    db.prepare("select account_kind, account_org, total from usage").get() as {
      account_kind: string | null;
      account_org: string | null;
      total: number;
    };

  test("stores label", () => {
    upsertUsage(db, setup(), [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D" });
  });

  test("keeps label when total unchanged", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "personal" } })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D" });
  });

  test("relabels when total grows", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 150, account: { kind: "personal" } })]);
    expect(label()).toMatchObject({ account_kind: "personal", account_org: null, total: 150 });
  });

  test("null never clears", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 200 })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D", total: 200 });
  });

  test("fills a missing label", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100 })]);
    expect(label().account_kind).toBeNull();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "api" } })]);
    expect(label()).toMatchObject({ account_kind: "api", account_org: null });
  });

  test("lower total changes nothing", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 50, account: { kind: "personal" } })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D", total: 100 });
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
});

describe("account plan", () => {
  const setup = () => {
    const { memberId } = registerMachine(db, reg("m1"));
    return { memberId, machineId: "m1" };
  };
  const base = { date: "2026-11-17", agent: "claude" as const, model: "x" };
  const row = () =>
    db.prepare("select account_kind, account_org, account_plan from usage").get() as {
      account_kind: string | null;
      account_org: string | null;
      account_plan: string | null;
    };

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

  test("stores the plan with a new label", () => {
    upsertUsage(db, setup(), [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
  });

  test("history fills plans but never relabels", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "A" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });

    db.prepare("delete from usage").run();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "personal" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "personal", account_org: null, account_plan: null });
  });

  test("an older client never clears a plan", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 200, account: { kind: "team", org: "A" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
  });

  test("a new account replaces the plan", () => {
    const who = setup();
    upsertUsage(db, who, [rec({ ...base, total: 100, account: { kind: "personal", plan: "pro" } })]);
    upsertUsage(db, who, [rec({ ...base, total: 200, account: { kind: "team", org: "A" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: null });
  });
});

describe("removal", () => {
  test("removeMember deletes its machines, usage and tokens", () => {
    const a = registerMachine(db, reg("m1"));
    const other = registerMachine(db, reg("m2", { email: "b@example.com" }));
    upsertUsage(db, { memberId: a.memberId, machineId: "m1" }, [rec()]);
    upsertUsage(db, { memberId: other.memberId, machineId: "m2" }, [rec()]);
    expect(removeMember(db, " A@Example.com ")).toBe(true);
    expect(authenticate(db, a.token)).toBeNull();
    expect(count("usage")).toBe(1);
    expect(count("machines")).toBe(1);
    expect(listMembers(db)).toHaveLength(1);
    expect(removeMember(db, "a@example.com")).toBe(false);
  });

  test("removeMachine deletes the machine and its usage only", () => {
    const a = registerMachine(db, reg("m1"));
    registerMachine(db, reg("m2"));
    upsertUsage(db, { memberId: a.memberId, machineId: "m1" }, [rec()]);
    expect(removeMachine(db, "m1")).toBe(true);
    expect(count("usage")).toBe(0);
    expect(listMembers(db)[0]!.machines.map((m) => m.id)).toEqual(["m2"]);
    expect(removeMachine(db, "m1")).toBe(false);
  });
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
    const hash = (id: string) => createHash("sha256").update(id).digest("hex");
    set.run(new Date(Date.now() - 31 * day).toISOString(), hash(old));
    set.run(new Date(Date.now() - 29 * day).toISOString(), hash(fresh));
    createSession(db);
    expect((db.prepare("select count(*) as n from sessions").get() as { n: number }).n).toBe(2);
    expect(hasSession(db, fresh)).toBe(true);
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
