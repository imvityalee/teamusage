import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { UsageRecord } from "@teamusage/shared";
import { migrate } from "./migrate.js";
import { ensureSingleTeam } from "./teams.js";

export type Db = import("better-sqlite3").Database;

/** The machine id is already registered to a different member. */
export class MachineOwnedError extends Error {
  constructor() {
    super("machine id already registered to another member");
    this.name = "MachineOwnedError";
  }
}

export const now = (): string => new Date().toISOString();
const sha256 =(s: string): string => createHash("sha256").update(s).digest("hex");

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  db.pragma("foreign_keys = ON");
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
  const teamId = ensureSingleTeam(db);
  db.transaction(() => {
    setSetting(db, "invite_code", code);
    db.prepare("delete from sessions where team_id = ?").run(teamId);
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
  const teamId = ensureSingleTeam(db);
  return db.transaction(() => {
    const at = now();
    db.prepare(
      "insert into members (team_id, email, name, created_at) values (?, ?, ?, ?) on conflict (team_id, email) do update set name = excluded.name",
    ).run(teamId, email, a.name, at);
    const { id: memberId } = db.prepare("select id from members where team_id = ? and email = ?").get(teamId, email) as {
      id: number;
    };
    const existing = db.prepare("select member_id from machines where team_id = ? and id = ?").get(teamId, a.machineId) as
      | { member_id: number }
      | undefined;
    if (existing && existing.member_id !== memberId) {
      throw new MachineOwnedError();
    }
    if (existing) {
      db.prepare("update machines set label = ?, token_hash = ? where team_id = ? and id = ?").run(
        a.machineLabel,
        tokenHash,
        teamId,
        a.machineId,
      );
    } else {
      db.prepare(
        "insert into machines (team_id, id, member_id, label, token_hash, created_at) values (?, ?, ?, ?, ?, ?)",
      ).run(teamId, a.machineId, memberId, a.machineLabel, tokenHash, at);
    }
    return { token, memberId };
  })();
}

export function authenticate(db: Db, token: string): { teamId: number; memberId: number; machineId: string } | null {
  const row = db.prepare("select team_id, member_id, id from machines where token_hash = ?").get(sha256(token)) as
    | { team_id: number; member_id: number; id: string }
    | undefined;
  return row ? { teamId: row.team_id, memberId: row.member_id, machineId: row.id } : null;
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
  // The plan follows the label: a different account replaces it (even with none), the same account only gains or
  // updates one, and history (same total) may fill a missing plan but never relabel. Right-hand references see the old row.
  const SAME_ACCOUNT =
    "excluded.account_kind is usage.account_kind and coalesce(excluded.account_org, '') = coalesce(usage.account_org, '')";
  const PLAN = `case
        when ${TAKE_LABEL} and not (${SAME_ACCOUNT}) then excluded.account_plan
        when excluded.account_kind is not null and ${SAME_ACCOUNT} and excluded.account_plan is not null
          and (excluded.total > usage.total or usage.account_plan is null) then excluded.account_plan
        else usage.account_plan end`;
  // A day's usage only grows, so a lower incoming total means local logs were pruned: keep the stored counts. Such a
  // record may still fill an empty label (and the same account's missing plan), so pruned days can be labelled too.
  const GROWS = "excluded.total >= usage.total";
  const keepOr = (col: string) => `${col} = case when ${GROWS} then excluded.${col} else usage.${col} end`;
  const FILLS = `excluded.account_kind is not null and (usage.account_kind is null
        or (${SAME_ACCOUNT} and usage.account_plan is null and excluded.account_plan is not null))`;
  const stmt = db.prepare(`
    insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced, account_kind, account_org, account_plan)
    values (@teamId, @memberId, @machineId, @date, @agent, @model, @input, @output, @cacheCreate, @cacheRead, @total, @costUsd, @unpriced, @accountKind, @accountOrg, @accountPlan)
    on conflict (team_id, machine_id, date, agent, model) do update set
      ${["member_id", "input", "output", "cache_create", "cache_read", "total", "cost_usd", "unpriced"].map(keepOr).join(",\n      ")},
      account_org = case when ${TAKE_LABEL} then excluded.account_org else usage.account_org end,
      account_kind = case when ${TAKE_LABEL} then excluded.account_kind else usage.account_kind end,
      account_plan = ${PLAN}
    where ${GROWS} or (${FILLS})`);
  const teamId = ensureSingleTeam(db);
  return db.transaction(() => {
    let stored = 0;
    let kept = 0;
    for (const r of records) {
      const res = stmt.run({
        teamId,
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
        accountPlan: r.account?.plan ?? null,
      });
      if (res.changes > 0) stored++;
      else kept++;
    }
    db.prepare("update machines set last_sync_at = ? where team_id = ? and id = ?").run(now(), teamId, who.machineId);
    return { stored, kept };
  })();
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(db: Db): string {
  const id = randomBytes(32).toString("hex");
  // Expired sessions are useless; dropping them here keeps the table from growing without bound.
  db.prepare("delete from sessions where created_at < ?").run(new Date(Date.now() - SESSION_TTL_MS).toISOString());
  db.prepare("insert into sessions (id, team_id, created_at) values (?, ?, ?)").run(sha256(id), ensureSingleTeam(db), now());
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
  const teamId = ensureSingleTeam(db);
  const members = db.prepare("select id, name, email from members where team_id = ? order by id").all(teamId) as {
    id: number;
    name: string;
    email: string;
  }[];
  const machines = db
    .prepare("select id, member_id, label, last_sync_at from machines where team_id = ? order by created_at, id")
    .all(teamId) as { id: string; member_id: number; label: string; last_sync_at: string | null }[];
  return members.map((m) => ({
    ...m,
    machines: machines
      .filter((x) => x.member_id === m.id)
      .map((x) => ({ id: x.id, label: x.label, lastSyncAt: x.last_sync_at })),
  }));
}

export function removeMember(db: Db, email: string): boolean {
  const teamId = ensureSingleTeam(db);
  return db.transaction(() => {
    const row = db
      .prepare("select id from members where team_id = ? and email = ?")
      .get(teamId, email.trim().toLowerCase()) as { id: number } | undefined;
    if (!row) return false;
    db.prepare("delete from usage where team_id = ? and member_id = ?").run(teamId, row.id);
    db.prepare("delete from machines where team_id = ? and member_id = ?").run(teamId, row.id);
    db.prepare("delete from members where team_id = ? and id = ?").run(teamId, row.id);
    return true;
  })();
}

export function removeMachine(db: Db, machineId: string): boolean {
  const teamId = ensureSingleTeam(db);
  return db.transaction(() => {
    db.prepare("delete from usage where team_id = ? and machine_id = ?").run(teamId, machineId);
    return db.prepare("delete from machines where team_id = ? and id = ?").run(teamId, machineId).changes > 0;
  })();
}
