import { randomBytes } from "node:crypto";
import { now, safeEqual, storeInviteCode, type Db } from "./db.js";
import { endTeamSessions } from "./sessions.js";

/** Adds a team whose members see the team's numbers; returns its id. */
export function createTeam(db: Db, name: string): number {
  const { lastInsertRowid } = db
    .prepare("insert into teams (public_id, name, dashboard_access, created_at) values (?, ?, 'members', ?)")
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
