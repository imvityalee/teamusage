import { codeHash, newTeamCode, openCode, sealCode } from "./codes.js";
import { dropDashboardLinks } from "./dashboard-links.js";
import type { Db } from "./db.js";
import type { DashboardAccess } from "./hosted-teams.js";
import { endTeamSessions } from "./sessions.js";

/** Sets the team's name; `name` is already trimmed and valid. */
export function renameTeam(db: Db, teamId: number, name: string): void {
  db.prepare("update teams set name = ? where id = ?").run(name, teamId);
}

/** Sets who may see the team's numbers. Switching to "admins" ends its members' sessions and drops their pending links in the same step. */
export function setDashboardAccess(db: Db, teamId: number, access: DashboardAccess): void {
  db.transaction(() => {
    db.prepare("update teams set dashboard_access = ? where id = ?").run(access, teamId);
    if (access === "admins") {
      endTeamSessions(db, teamId);
      dropDashboardLinks(db, teamId);
    }
  })();
}

/** The team's code, opened with `key`; null when the team has none or it was sealed under another key. */
export function teamCode(db: Db, teamId: number, key: Buffer): string | null {
  const row = db.prepare("select code_sealed from teams where id = ?").get(teamId) as { code_sealed: string | null } | undefined;
  return row?.code_sealed == null ? null : openCode(row.code_sealed, key);
}

/** Gives the team a new code, hashed and sealed with `key`, and returns it; the old code joins nobody from then on. Nobody is signed out. */
export function rotateTeamCode(db: Db, teamId: number, key: Buffer): string {
  const code = newTeamCode();
  db.prepare("update teams set code_hash = ?, code_sealed = ? where id = ?").run(codeHash(code), sealCode(code, key), teamId);
  return code;
}
