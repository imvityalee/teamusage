import { randomBytes } from "node:crypto";
import { now, sha256, type Db } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Opens a dashboard session of team `teamId`; returns its id, which is stored only as a hash. */
export function createSession(db: Db, teamId: number): string {
  const id = randomBytes(32).toString("hex");
  // Expired sessions are useless; dropping them here keeps the table from growing without bound.
  db.prepare("delete from sessions where created_at < ?").run(new Date(Date.now() - SESSION_TTL_MS).toISOString());
  db.prepare("insert into sessions (id, team_id, created_at) values (?, ?, ?)").run(sha256(id), teamId, now());
  return id;
}

/** The team of the session `id`, in whichever team it was opened; null when it is unknown or expired. */
export function findSession(db: Db, id: string, at: Date = new Date()): { teamId: number } | null {
  const row = db.prepare("select team_id, created_at from sessions where id = ?").get(sha256(id)) as
    | { team_id: number; created_at: string }
    | undefined;
  return row !== undefined && at.getTime() - Date.parse(row.created_at) <= SESSION_TTL_MS ? { teamId: row.team_id } : null;
}

/** Ends every session of team `teamId`. */
export function endTeamSessions(db: Db, teamId: number): void {
  db.prepare("delete from sessions where team_id = ?").run(teamId);
}
