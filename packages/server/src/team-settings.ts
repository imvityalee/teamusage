import { dropDashboardLinks } from "./dashboard-links.js";
import type { Db } from "./db.js";
import type { DashboardAccess } from "./hosted-teams.js";
import { endTeamSessions } from "./sessions.js";

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
