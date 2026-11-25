import { randomBytes } from "node:crypto";
import { codeHash, newTeamCode, sealCode } from "./codes.js";
import { now, type Db } from "./db.js";
import { ensureUser } from "./users.js";

export type Role = "owner" | "admin" | "viewer";
export type DashboardAccess = "code" | "admins";
export type TeamInfo = { id: number; publicId: string; name: string; dashboardAccess: DashboardAccess };
/** A team as its user sees it in a list: `id` is the public id. */
export type UserTeam = { id: string; name: string; role: Role; dashboardAccess: DashboardAccess };

/** Most teams one GitHub user may own. */
export const MAX_TEAMS_PER_USER = 5;

/** A team was not created because the server, or its owner, already holds the most teams allowed. */
export class TeamLimitError extends Error {
  readonly limit: "user" | "server";
  constructor(limit: "user" | "server") {
    super(limit === "server" ? "the server holds the most teams it allows" : "the user owns the most teams allowed");
    this.name = "TeamLimitError";
    this.limit = limit;
  }
}

const TEAM_COLUMNS = "id, public_id as publicId, name, dashboard_access as dashboardAccess";
const TEAM_CODE = /^[a-f0-9]{24}$/;

const countOf = (db: Db, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

/** Inserts the team with its code hashed and sealed; returns its id. */
function insertTeam(db: Db, team: Omit<TeamInfo, "id">, code: string, codeKey: Buffer): number {
  const { lastInsertRowid } = db
    .prepare(
      `insert into teams (public_id, name, dashboard_access, code_hash, code_sealed, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(team.publicId, team.name, team.dashboardAccess, codeHash(code), sealCode(code, codeKey), now());
  return Number(lastInsertRowid);
}

/** Creates the team and makes `owner` its owner in one step; the code is returned only here. */
export function createHostedTeam(
  db: Db,
  a: {
    name: string;
    dashboardAccess: DashboardAccess;
    owner: { githubId: number; login: string };
    codeKey: Buffer;
    maxTeams: number;
  },
): { team: TeamInfo; code: string } {
  // Immediate, so that two requests cannot both pass a limit before either inserts; a throw rolls every row back.
  return db.transaction(() => {
    if (countOf(db, "select count(*) as n from teams") >= a.maxTeams) throw new TeamLimitError("server");
    const user = ensureUser(db, a.owner);
    const owned = countOf(db, "select count(*) as n from team_roles where user_id = ? and role = 'owner'", user.id);
    if (owned >= MAX_TEAMS_PER_USER) throw new TeamLimitError("user");
    const code = newTeamCode();
    const fields = { publicId: randomBytes(8).toString("hex"), name: a.name, dashboardAccess: a.dashboardAccess };
    const id = insertTeam(db, fields, code, a.codeKey);
    db.prepare("insert into team_roles (team_id, user_id, role, created_at) values (?, ?, 'owner', ?)").run(id, user.id, now());
    return { team: { id, ...fields }, code };
  }).immediate();
}

/** The team a code opens: a 24-character lowercase hex string whose hash is a team's; otherwise null. */
export function hostedTeamCodes(db: Db): (code: unknown) => number | null {
  const byHash = db.prepare("select id from teams where code_hash = ?");
  return (code) => {
    if (typeof code !== "string" || !TEAM_CODE.test(code)) return null;
    return (byHash.get(codeHash(code)) as { id: number } | undefined)?.id ?? null;
  };
}

/** True when a hosted server has created a team here: a team with a code hash exists. */
export function holdsHostedTeam(db: Db): boolean {
  return db.prepare("select 1 from teams where code_hash is not null limit 1").get() !== undefined;
}

export function teamByPublicId(db: Db, publicId: string): TeamInfo | null {
  return (db.prepare(`select ${TEAM_COLUMNS} from teams where public_id = ?`).get(publicId) as TeamInfo | undefined) ?? null;
}

export function teamById(db: Db, teamId: number): TeamInfo | null {
  return (db.prepare(`select ${TEAM_COLUMNS} from teams where id = ?`).get(teamId) as TeamInfo | undefined) ?? null;
}

export function roleIn(db: Db, teamId: number, githubId: number): Role | null {
  const row = db
    .prepare("select r.role from team_roles r join users u on u.id = r.user_id where r.team_id = ? and u.github_id = ?")
    .get(teamId, githubId) as { role: Role } | undefined;
  return row?.role ?? null;
}

/** The teams the GitHub user has a role in, by name, then public id. */
export function teamsOf(db: Db, githubId: number): UserTeam[] {
  return db
    .prepare(
      `select t.public_id as id, t.name, r.role, t.dashboard_access as dashboardAccess
       from team_roles r join users u on u.id = r.user_id join teams t on t.id = r.team_id
       where u.github_id = ?
       order by t.name, t.public_id`,
    )
    .all(githubId) as UserTeam[];
}
