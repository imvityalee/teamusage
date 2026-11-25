import { randomBytes, timingSafeEqual } from "node:crypto";
import { now, sha256, storeInviteCode, type Db } from "./db.js";
import { endTeamSessions } from "./sessions.js";

/** Adds a team whose dashboard opens with the invite code; returns its id. */
export function createTeam(db: Db, name: string): number {
  const { lastInsertRowid } = db
    .prepare("insert into teams (public_id, name, dashboard_access, created_at) values (?, ?, 'code', ?)")
    .run(randomBytes(8).toString("hex"), name, now());
  return Number(lastInsertRowid);
}

/** The team of a self-hosted server: the lowest team id, created as "Team" when there is none. */
export function ensureSingleTeam(db: Db): number {
  // Immediate, so that two processes opening one empty database cannot each create a team.
  return db.transaction(() => {
    const { id } = db.prepare("select min(id) as id from teams").get() as { id: number | null };
    return id ?? createTeam(db, "Team");
  }).immediate();
}

/** Constant-time: both sides are hashed first, so neither content nor length leaks through timing. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

/** The invite codes of a single-team server: `teamId` for a string equal to `inviteCode()`, read on each call. */
export function singleTeamCodes(teamId: number, inviteCode: () => string): (code: unknown) => number | null {
  return (code) => (typeof code === "string" && safeEqual(code, inviteCode()) ? teamId : null);
}

/** Stores a new invite code and ends the sessions of team `teamId` in one step; returns the code. */
export function rotateInviteCode(db: Db, teamId: number): string {
  const code = randomBytes(12).toString("hex");
  db.transaction(() => {
    storeInviteCode(db, code);
    endTeamSessions(db, teamId);
  })();
  return code;
}
