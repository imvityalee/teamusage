import { randomBytes } from "node:crypto";
import { now, sha256, type Db } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A session opened with a team's code, or by a GitHub user signing in. */
export type Session = { kind: "team"; teamId: number } | { kind: "user"; githubId: number; login: string };

/** Most sessions one team holds at a time. */
export const MAX_TEAM_SESSIONS = 2000;
/** Most sessions one GitHub account holds at a time. */
export const MAX_USER_SESSIONS = 20;

type SessionRow =
  | { kind: "team"; team_id: number; github_id: null; github_login: null; created_at: string }
  | { kind: "user"; team_id: null; github_id: number; github_login: string; created_at: string };

/** Expired sessions are useless; dropping them whenever one is opened keeps the table from growing without bound. */
function dropExpired(db: Db): void {
  db.prepare("delete from sessions where created_at < ?").run(new Date(Date.now() - SESSION_TTL_MS).toISOString());
}

const newSessionId = (): string => randomBytes(32).toString("hex");

/** Deletes an owner's sessions but the `max - 1` newest others and the session just opened; sessions opened in the same millisecond are told apart by insertion order (rowid). */
function dropOldestStatement(owner: string): string {
  return `delete from sessions where rowid in (
    select rowid from sessions where ${owner} and id <> ?
    order by created_at desc, rowid desc limit -1 offset ?)`;
}

// Each statement is built once from a fixed literal; no value is ever concatenated into SQL.
const DROP_OLDEST_OF = {
  team: dropOldestStatement("kind = 'team' and team_id = ?"),
  user: dropOldestStatement("kind = 'user' and github_id = ?"),
};

/** Inserts the session and drops its owner's oldest; the session just opened is never the one dropped, whatever the clock says. */
function openSession(db: Db, insert: () => void, drop: string, ownerValue: number, id: string, max: number): void {
  db.transaction(() => {
    dropExpired(db);
    insert();
    db.prepare(drop).run(ownerValue, sha256(id), max - 1);
  })();
}

/** Opens a session of the team; when the team then holds more than `max`, its oldest are dropped. */
export function createTeamSession(db: Db, teamId: number, max: number = MAX_TEAM_SESSIONS): string {
  const id = newSessionId();
  const insert = () =>
    db.prepare("insert into sessions (id, kind, team_id, created_at) values (?, 'team', ?, ?)").run(sha256(id), teamId, now());
  openSession(db, insert, DROP_OLDEST_OF.team, teamId, id, max);
  return id;
}

/** Opens a session of a GitHub user, creating no `users` row; when the account then holds more than `max`, its oldest are dropped. */
export function createUserSession(db: Db, user: { githubId: number; login: string }, max: number = MAX_USER_SESSIONS): string {
  const id = newSessionId();
  const insert = () =>
    db
      .prepare("insert into sessions (id, kind, github_id, github_login, created_at) values (?, 'user', ?, ?, ?)")
      .run(sha256(id), user.githubId, user.login, now());
  openSession(db, insert, DROP_OLDEST_OF.user, user.githubId, id, max);
  return id;
}

function toSession(row: SessionRow): Session {
  return row.kind === "team"
    ? { kind: "team", teamId: row.team_id }
    : { kind: "user", githubId: row.github_id, login: row.github_login };
}

/** The session `id`, of whichever team or user opened it; null when it is unknown or expired. */
export function findSession(db: Db, id: string, at: Date = new Date()): Session | null {
  const row = db
    .prepare("select kind, team_id, github_id, github_login, created_at from sessions where id = ?")
    .get(sha256(id)) as SessionRow | undefined;
  return row !== undefined && at.getTime() - Date.parse(row.created_at) <= SESSION_TTL_MS ? toSession(row) : null;
}

/** Ends the session `id`. */
export function endSession(db: Db, id: string): void {
  db.prepare("delete from sessions where id = ?").run(sha256(id));
}

/** Ends every session of team `teamId`; user sessions are left alone. */
export function endTeamSessions(db: Db, teamId: number): void {
  db.prepare("delete from sessions where kind = 'team' and team_id = ?").run(teamId);
}
