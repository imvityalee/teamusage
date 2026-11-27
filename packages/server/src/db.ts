import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { migrate } from "./migrate.js";

export type Db = import("better-sqlite3").Database;

export const now = (): string => new Date().toISOString();
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Constant-time: both sides are hashed first, so neither content nor length leaks through timing. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

/** The `n` of a `select count(*) as n` statement run with `params`. */
export const countOf = (db: Db, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

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

const INVITE_CODE = "invite_code";

/** The stored invite code, or undefined when the server has not generated one yet. */
export function getStoredInviteCode(db: Db): string | undefined {
  return getSetting(db, INVITE_CODE);
}

/** Stores `code` as the invite code, replacing the stored one. */
export function storeInviteCode(db: Db, code: string): void {
  setSetting(db, INVITE_CODE, code);
}

export function getInviteCode(db: Db, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  db.prepare("insert into settings (key, value) values (?, ?) on conflict (key) do nothing").run(
    INVITE_CODE,
    randomBytes(12).toString("hex"),
  );
  return getStoredInviteCode(db) as string;
}
