import Database from "better-sqlite3";
import { codeHash, newTeamCode, sealCode } from "../codes.js";
import type { Db } from "../db.js";
import { newPublicId } from "../hosted-teams.js";
import { runSteps, STEPS } from "../migrate.js";

/** The time written to every row these databases hold. */
export const T = "2026-11-01T00:00:00.000Z";
/** The code key the hosted teams of these databases are sealed with. */
const KEY = Buffer.alloc(32, 9);

/** An empty database brought to `version` by the steps of that release. */
export function atVersion(version: number): Db {
  const db = new Database(":memory:");
  runSteps(db, STEPS.slice(0, version));
  return db;
}

/** Inserts a hosted team with its code hashed and sealed, with SQL of version 4 onward; returns its id. */
export function insertHostedTeam(db: Db, name: string, access: string): number {
  const code = newTeamCode();
  const { lastInsertRowid } = db
    .prepare("insert into teams (public_id, name, dashboard_access, code_hash, code_sealed, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(newPublicId(), name, access, codeHash(code), sealCode(code, KEY), T);
  return Number(lastInsertRowid);
}
