import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import type { UsageRecord } from "@teamusage/shared";
import { openDb, type Db } from "./db.js";
import { authenticate, forTeam, MachineOwnedError, type TeamData } from "./team-data.js";
import { createTeam, ensureSingleTeam } from "./teams.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const reg = (machineId: string, over: Partial<Parameters<TeamData["registerMachine"]>[0]> = {}) => ({
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

/** The team of a self-hosted server, as db.ts reaches it. */
const team = (): TeamData => forTeam(db, ensureSingleTeam(db));

const count = (table: string): number =>
  (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("registration", () => {
  test("email is trimmed and lower-cased: one member", () => {
    const a = team().registerMachine({ name: "A", email: " Vlad@Example.com ", machineId: "m1", machineLabel: "mbp" });
    const b = team().registerMachine({ name: "A", email: "vlad@example.com", machineId: "m2", machineLabel: "mini" });
    expect(a.memberId).toBe(b.memberId);
    expect(team().listMembers()[0]!.machines).toHaveLength(2);
  });

  test("re-registering a machine rotates its token and keeps one machine", () => {
    const first = team().registerMachine(reg("m1"));
    const second = team().registerMachine(reg("m1"));
    expect(authenticate(db, first.token)).toBeNull();
    expect(authenticate(db, second.token)).toEqual({ teamId: 1, memberId: second.memberId, machineId: "m1" });
    expect(team().listMembers()[0]!.machines).toHaveLength(1);
  });

  test("latest registration wins the display name", () => {
    team().registerMachine(reg("m1", { name: "Old" }));
    team().registerMachine(reg("m2", { name: "New" }));
    expect(team().listMembers()[0]!.name).toBe("New");
  });

  test("a machine id already owned by another member is rejected", () => {
    team().registerMachine(reg("m1"));
    expect(() => team().registerMachine(reg("m1", { email: "b@example.com" }))).toThrow(/another member/);
  });

  test("token is 32 random bytes hex and unknown tokens do not authenticate", () => {
    const { token } = team().registerMachine(reg("m1"));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(authenticate(db, "nope")).toBeNull();
  });

  test("tokens are not stored in clear", () => {
    const { token } = team().registerMachine(reg("m1"));
    const row = db.prepare("select * from machines").get() as Record<string, unknown>;
    expect(Object.values(row)).not.toContain(token);
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});

describe("usage", () => {
  const setup = () => {
    const { memberId } = team().registerMachine(reg("m1"));
    return { memberId, machineId: "m1" };
  };

  test("same batch twice stores one row", () => {
    const who = setup();
    team().upsertUsage(who, [rec()]);
    team().upsertUsage(who, [rec()]);
    expect(count("usage")).toBe(1);
  });

  test("higher total replaces, lower total is kept", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ total: 100, input: 100 })]);
    expect(team().upsertUsage(who, [rec({ total: 40, input: 40 })])).toEqual({ stored: 0, kept: 1 });
    expect(team().upsertUsage(who, [rec({ total: 150, input: 150 })])).toEqual({ stored: 1, kept: 0 });
    expect((db.prepare("select total, input from usage").get() as { total: number; input: number })).toEqual({
      total: 150,
      input: 150,
    });
  });

  test("duplicate keys within one batch end with the higher total, in either order", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ total: 50, input: 50 }), rec({ total: 20, input: 20 })]);
    team().upsertUsage(who, [rec({ date: "2026-11-02", total: 20, input: 20 }), rec({ date: "2026-11-02", total: 50, input: 50 })]);
    const rows = db.prepare("select total from usage order by date").all();
    expect(rows).toEqual([{ total: 50 }, { total: 50 }]);
  });

  test("identity comes from who, not from fields on the record", () => {
    const a = team().registerMachine(reg("m1"));
    const b = team().registerMachine(reg("m2", { email: "b@example.com" }));
    team().upsertUsage({ memberId: b.memberId, machineId: "m2" }, [rec({ total: 77, input: 77 })]);
    const evil = { ...rec({ total: 5, input: 5 }), machineId: "m2", memberId: b.memberId };
    team().upsertUsage({ memberId: a.memberId, machineId: "m1" }, [evil]);
    expect(db.prepare("select machine_id, member_id, total from usage order by machine_id").all()).toEqual([
      { machine_id: "m1", member_id: a.memberId, total: 5 },
      { machine_id: "m2", member_id: b.memberId, total: 77 },
    ]);
  });

  test("upsert for a machine that no longer exists fails and stores nothing", () => {
    const who = setup();
    team().removeMachine("m1");
    expect(() => team().upsertUsage(who, [rec()])).toThrow();
    expect(count("usage")).toBe(0);
  });

  test("sets last_sync_at on the machine", () => {
    const who = setup();
    expect(team().listMembers()[0]!.machines[0]!.lastSyncAt).toBeNull();
    team().upsertUsage(who, [rec()]);
    expect(team().listMembers()[0]!.machines[0]!.lastSyncAt).not.toBeNull();
  });

  test("two machines of one member keep separate rows for the same day", () => {
    const a = team().registerMachine(reg("m1"));
    const b = team().registerMachine(reg("m2"));
    team().upsertUsage({ memberId: a.memberId, machineId: "m1" }, [rec()]);
    team().upsertUsage({ memberId: b.memberId, machineId: "m2" }, [rec()]);
    expect(count("usage")).toBe(2);
  });
});

describe("account label", () => {
  const setup = () => {
    const { memberId } = team().registerMachine(reg("m1"));
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
    team().upsertUsage(setup(), [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D" });
  });

  test("keeps label when total unchanged", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "personal" } })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D" });
  });

  test("relabels when total grows", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 150, account: { kind: "personal" } })]);
    expect(label()).toMatchObject({ account_kind: "personal", account_org: null, total: 150 });
  });

  test("null never clears", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 200 })]);
    expect(label()).toMatchObject({ account_kind: "team", account_org: "D", total: 200 });
  });

  test("fills a missing label", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100 })]);
    expect(label().account_kind).toBeNull();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "api" } })]);
    expect(label()).toMatchObject({ account_kind: "api", account_org: null });
  });

  test("lower total changes nothing", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "D" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 50, account: { kind: "personal" } })]);
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
});

describe("account plan", () => {
  const setup = () => {
    const { memberId } = team().registerMachine(reg("m1"));
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

  test("stores the plan with a new label", () => {
    team().upsertUsage(setup(), [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
  });

  test("history fills plans but never relabels", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "A" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });

    db.prepare("delete from usage").run();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "personal" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "personal", account_org: null, account_plan: null });
  });

  test("an older client never clears a plan", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 200, account: { kind: "team", org: "A" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
  });

  test("a lower total (pruned logs) still fills an empty label and plan but keeps the stored tokens", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, input: 100, total: 100 })]);
    const res = team().upsertUsage(who, [rec({ ...base, input: 90, total: 90, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(res).toEqual({ stored: 1, kept: 0 });
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
    expect(db.prepare("select input, total from usage").get()).toEqual({ input: 100, total: 100 });
  });

  test("a lower total fills a missing plan for the same account only", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "A" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 90, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
    team().upsertUsage(who, [rec({ ...base, total: 90, account: { kind: "personal", plan: "pro" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
    expect(db.prepare("select total from usage").get()).toEqual({ total: 100 });
  });

  test("a lower total without a label changes nothing", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100 })]);
    expect(team().upsertUsage(who, [rec({ ...base, total: 90 })])).toEqual({ stored: 0, kept: 1 });
    expect(row()).toEqual({ account_kind: null, account_org: null, account_plan: null });
  });

  test("a row with no kind (0.1/0.2) takes the label and plan at the same total, then keeps them", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100 })]);
    expect(row()).toEqual({ account_kind: null, account_org: null, account_plan: null });
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "team", org: "A", plan: "team_premium" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
    team().upsertUsage(who, [rec({ ...base, total: 100 })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: "team_premium" });
  });

  test("a new account replaces the plan", () => {
    const who = setup();
    team().upsertUsage(who, [rec({ ...base, total: 100, account: { kind: "personal", plan: "pro" } })]);
    team().upsertUsage(who, [rec({ ...base, total: 200, account: { kind: "team", org: "A" } })]);
    expect(row()).toEqual({ account_kind: "team", account_org: "A", account_plan: null });
  });
});

describe("removal", () => {
  test("removeMember deletes its machines, usage and tokens", () => {
    const a = team().registerMachine(reg("m1"));
    const other = team().registerMachine(reg("m2", { email: "b@example.com" }));
    team().upsertUsage({ memberId: a.memberId, machineId: "m1" }, [rec()]);
    team().upsertUsage({ memberId: other.memberId, machineId: "m2" }, [rec()]);
    expect(team().removeMember(" A@Example.com ")).toBe(true);
    expect(authenticate(db, a.token)).toBeNull();
    expect(count("usage")).toBe(1);
    expect(count("machines")).toBe(1);
    expect(team().listMembers()).toHaveLength(1);
    expect(team().removeMember("a@example.com")).toBe(false);
  });

  test("removeMachine deletes the machine and its usage only", () => {
    const a = team().registerMachine(reg("m1"));
    team().registerMachine(reg("m2"));
    team().upsertUsage({ memberId: a.memberId, machineId: "m1" }, [rec()]);
    expect(team().removeMachine("m1")).toBe(true);
    expect(count("usage")).toBe(0);
    expect(team().listMembers()[0]!.machines.map((m) => m.id)).toEqual(["m2"]);
    expect(team().removeMachine("m1")).toBe(false);
  });
});

describe("two teams", () => {
  const MID = "a".repeat(32);
  const MID2 = "b".repeat(32);
  const usageRows = (teamId: number) => (db.prepare("select count(*) as n from usage where team_id = ?").get(teamId) as { n: number }).n;
  let A: number, B: number, a: TeamData, b: TeamData;
  beforeEach(() => {
    A = createTeam(db, "A");
    B = createTeam(db, "B");
    a = forTeam(db, A);
    b = forTeam(db, B);
  });

  test("the same email and machine id in two teams are two members and two machines", () => {
    const ra = a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    expect(ra.memberId).not.toBe(rb.memberId);
    expect(authenticate(db, ra.token)).toEqual({ teamId: A, memberId: ra.memberId, machineId: MID });
    expect(authenticate(db, rb.token)).toEqual({ teamId: B, memberId: rb.memberId, machineId: MID });
  });
  test("usage is stored in its own team only", () => {
    const ra = a.registerMachine(reg(MID));
    b.registerMachine(reg(MID));
    a.upsertUsage({ memberId: ra.memberId, machineId: MID }, [rec()]);
    expect([usageRows(A), usageRows(B)]).toEqual([1, 0]);
  });
  test("a member of another team cannot be written through this team", () => {
    a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    expect(() => a.upsertUsage({ memberId: rb.memberId, machineId: MID }, [rec()])).toThrow();
    expect([usageRows(A), usageRows(B)]).toEqual([0, 0]);
  });
  test("a machine id taken by another member is refused inside a team, not across teams", () => {
    a.registerMachine(reg(MID));
    expect(() => a.registerMachine(reg(MID, { email: "bob@x.com" }))).toThrow(MachineOwnedError);
    expect(() => b.registerMachine(reg(MID, { email: "bob@x.com" }))).not.toThrow();
  });
  test("ids that exist only in another team look unknown", () => {
    const rb = b.registerMachine(reg(MID2, { email: "bob@x.com" }));
    expect(a.memberExists(rb.memberId)).toBe(false);
    expect(a.removeMachine(MID2)).toBe(false);
    expect(a.removeMember("bob@x.com")).toBe(false);
    expect(a.listMembers()).toEqual([]);
    expect(b.listMembers().map((m) => m.email)).toEqual(["bob@x.com"]);
  });
  test("removing a member removes only that team's member, machines and usage", () => {
    const ra = a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    a.upsertUsage({ memberId: ra.memberId, machineId: MID }, [rec()]);
    b.upsertUsage({ memberId: rb.memberId, machineId: MID }, [rec()]);
    expect(a.removeMember("a@example.com")).toBe(true);
    expect([usageRows(A), usageRows(B)]).toEqual([0, 1]);
    expect(authenticate(db, ra.token)).toBeNull();
    expect(authenticate(db, rb.token)).not.toBeNull();
  });
  test("a given clock stamps new rows and the last sync", () => {
    const fixed = forTeam(db, A, () => "2026-11-24T12:00:00.000Z");
    const r = fixed.registerMachine(reg(MID));
    fixed.upsertUsage({ memberId: r.memberId, machineId: MID }, [rec()]);
    expect(fixed.listMembers()[0]!.machines[0]!.lastSyncAt).toBe("2026-11-24T12:00:00.000Z");
    expect(db.prepare("select created_at from members where id = ?").get(r.memberId)).toEqual({ created_at: "2026-11-24T12:00:00.000Z" });
  });
});
