import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { UsageRecord } from "@teamusage/shared";
import { migrate } from "./migrate.js";
import { forTeam, type TeamData } from "./team-data.js";
import { ensureSingleTeam } from "./teams.js";

export { authenticate, MachineOwnedError } from "./team-data.js";

export type Db = import("better-sqlite3").Database;

export const now = (): string => new Date().toISOString();
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

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

/** The data of the one team of a self-hosted server. */
const singleTeam = (db: Db): TeamData => forTeam(db, ensureSingleTeam(db));

export function registerMachine(db: Db, a: Parameters<TeamData["registerMachine"]>[0]) {
  return singleTeam(db).registerMachine(a);
}

export function upsertUsage(db: Db, who: Parameters<TeamData["upsertUsage"]>[0], records: UsageRecord[]) {
  return singleTeam(db).upsertUsage(who, records);
}

export function listMembers(db: Db) {
  return singleTeam(db).listMembers();
}

export function removeMember(db: Db, email: string) {
  return singleTeam(db).removeMember(email);
}

export function removeMachine(db: Db, machineId: string) {
  return singleTeam(db).removeMachine(machineId);
}
