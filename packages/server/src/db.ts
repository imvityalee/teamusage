import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { UsageRecord } from "@teamusage/shared";

export type Db = import("better-sqlite3").Database;

const SCHEMA = `
create table if not exists members (
  id integer primary key autoincrement,
  email text not null unique,
  name text not null,
  created_at text not null
);
create table if not exists machines (
  id text primary key,
  member_id integer not null references members(id) on delete cascade,
  label text not null,
  token_hash text not null unique,
  created_at text not null,
  last_sync_at text
);
create table if not exists usage (
  member_id integer not null references members(id) on delete cascade,
  machine_id text not null references machines(id) on delete cascade,
  date text not null,
  agent text not null,
  model text not null,
  input integer not null,
  output integer not null,
  cache_create integer not null,
  cache_read integer not null,
  total integer not null,
  cost_usd real not null,
  unpriced integer not null,
  primary key (machine_id, date, agent, model)
);
create index if not exists usage_member_date on usage (member_id, date);
create table if not exists settings (key text primary key, value text not null);
create table if not exists sessions (id text primary key, created_at text not null);
`;

const now = (): string => new Date().toISOString();
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Databases created by 0.1/0.2 lack the account label columns; add them in place.
  const have = new Set((db.prepare("pragma table_info(usage)").all() as { name: string }[]).map((c) => c.name));
  for (const col of ["account_kind", "account_org"]) {
    if (!have.has(col)) db.exec(`alter table usage add column ${col} text`);
  }
  return db;
}

export function getSetting(db: Db, key: string): string | undefined {
  return (db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
  ).run(key, value);
}

/** The stored invite code, or undefined when the server has not generated one yet. */
export function getStoredInviteCode(db: Db): string | undefined {
  return getSetting(db, "invite_code");
}

export function getInviteCode(db: Db, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  db.prepare("insert into settings (key, value) values ('invite_code', ?) on conflict (key) do nothing").run(
    randomBytes(12).toString("hex"),
  );
  return (db.prepare("select value from settings where key = 'invite_code'").get() as { value: string }).value;
}

export function rotateInviteCode(db: Db): string {
  const code = randomBytes(12).toString("hex");
  db.transaction(() => {
    setSetting(db, "invite_code", code);
    db.prepare("delete from sessions").run();
  })();
  return code;
}

export function registerMachine(
  db: Db,
  a: { name: string; email: string; machineId: string; machineLabel: string },
): { token: string; memberId: number } {
  const email = a.email.trim().toLowerCase();
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  return db.transaction(() => {
    const at = now();
    db.prepare(
      "insert into members (email, name, created_at) values (?, ?, ?) on conflict (email) do update set name = excluded.name",
    ).run(email, a.name, at);
    const { id: memberId } = db.prepare("select id from members where email = ?").get(email) as { id: number };
    const existing = db.prepare("select member_id from machines where id = ?").get(a.machineId) as
      | { member_id: number }
      | undefined;
    if (existing && existing.member_id !== memberId) {
      throw new Error("machine id already registered to another member");
    }
    if (existing) {
      db.prepare("update machines set label = ?, token_hash = ? where id = ?").run(
        a.machineLabel,
        tokenHash,
        a.machineId,
      );
    } else {
      db.prepare(
        "insert into machines (id, member_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
      ).run(a.machineId, memberId, a.machineLabel, tokenHash, at);
    }
    return { token, memberId };
  })();
}

export function authenticate(db: Db, token: string): { memberId: number; machineId: string } | null {
  const row = db.prepare("select member_id, id from machines where token_hash = ?").get(sha256(token)) as
    | { member_id: number; id: string }
    | undefined;
  return row ? { memberId: row.member_id, machineId: row.id } : null;
}

export function upsertUsage(
  db: Db,
  who: { memberId: number; machineId: string },
  records: UsageRecord[],
): { stored: number; kept: number } {
  // The label changes only when tokens grew (or none is stored yet); a record without a label never clears one.
  // Kind and org share one condition and are set in the same statement, so they change together.
  const TAKE_LABEL =
    "excluded.account_kind is not null and (excluded.total > usage.total or usage.account_kind is null)";
  // A day's usage only grows, so a lower incoming total means local logs were pruned: keep the stored row.
  const stmt = db.prepare(`
    insert into usage (member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced, account_kind, account_org)
    values (@memberId, @machineId, @date, @agent, @model, @input, @output, @cacheCreate, @cacheRead, @total, @costUsd, @unpriced, @accountKind, @accountOrg)
    on conflict (machine_id, date, agent, model) do update set
      member_id = excluded.member_id, input = excluded.input, output = excluded.output,
      cache_create = excluded.cache_create, cache_read = excluded.cache_read, total = excluded.total,
      cost_usd = excluded.cost_usd, unpriced = excluded.unpriced,
      account_org = case when ${TAKE_LABEL} then excluded.account_org else usage.account_org end,
      account_kind = case when ${TAKE_LABEL} then excluded.account_kind else usage.account_kind end
    where excluded.total >= usage.total`);
  return db.transaction(() => {
    let stored = 0;
    let kept = 0;
    for (const r of records) {
      const res = stmt.run({
        memberId: who.memberId,
        machineId: who.machineId,
        date: r.date,
        agent: r.agent,
        model: r.model,
        input: r.input,
        output: r.output,
        cacheCreate: r.cacheCreate,
        cacheRead: r.cacheRead,
        total: r.total,
        costUsd: r.costUsd,
        unpriced: r.unpriced ? 1 : 0,
        accountKind: r.account?.kind ?? null,
        accountOrg: r.account?.org ?? null,
      });
      if (res.changes > 0) stored++;
      else kept++;
    }
    db.prepare("update machines set last_sync_at = ? where id = ?").run(now(), who.machineId);
    return { stored, kept };
  })();
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(db: Db): string {
  const id = randomBytes(32).toString("hex");
  // Expired sessions are useless; dropping them here keeps the table from growing without bound.
  db.prepare("delete from sessions where created_at < ?").run(new Date(Date.now() - SESSION_TTL_MS).toISOString());
  db.prepare("insert into sessions (id, created_at) values (?, ?)").run(sha256(id), now());
  return id;
}

export function hasSession(db: Db, id: string, now: Date = new Date()): boolean {
  const row = db.prepare("select created_at from sessions where id = ?").get(sha256(id)) as
    | { created_at: string }
    | undefined;
  return row !== undefined && now.getTime() - Date.parse(row.created_at) <= SESSION_TTL_MS;
}

export function listMembers(db: Db): {
  id: number;
  name: string;
  email: string;
  machines: { id: string; label: string; lastSyncAt: string | null }[];
}[] {
  const members = db.prepare("select id, name, email from members order by id").all() as {
    id: number;
    name: string;
    email: string;
  }[];
  const machines = db
    .prepare("select id, member_id, label, last_sync_at from machines order by created_at, id")
    .all() as { id: string; member_id: number; label: string; last_sync_at: string | null }[];
  return members.map((m) => ({
    ...m,
    machines: machines
      .filter((x) => x.member_id === m.id)
      .map((x) => ({ id: x.id, label: x.label, lastSyncAt: x.last_sync_at })),
  }));
}

export function removeMember(db: Db, email: string): boolean {
  return db.transaction(() => {
    const row = db.prepare("select id from members where email = ?").get(email.trim().toLowerCase()) as
      | { id: number }
      | undefined;
    if (!row) return false;
    db.prepare("delete from usage where member_id = ?").run(row.id);
    db.prepare("delete from machines where member_id = ?").run(row.id);
    db.prepare("delete from members where id = ?").run(row.id);
    return true;
  })();
}

export function removeMachine(db: Db, machineId: string): boolean {
  return db.transaction(() => {
    db.prepare("delete from usage where machine_id = ?").run(machineId);
    return db.prepare("delete from machines where id = ?").run(machineId).changes > 0;
  })();
}
