import { randomBytes } from "node:crypto";
import { sha256, type Db } from "./db.js";
import type { MachineIdentity } from "./team-data.js";

/** How long a sign-in link works, in seconds. */
export const DASHBOARD_LINK_SECONDS = 300;

type LinkRow = { team_id: number; machine_id: string; member_id: number; expires_at: string };

/** A new link for the machine, replacing the one it had; returns its token, which is stored only as a hash. `now` is epoch milliseconds. */
export function createDashboardLink(db: Db, who: MachineIdentity, now: number): string {
  const token = randomBytes(32).toString("hex");
  db.prepare(
    `insert into dashboard_links (token_hash, team_id, machine_id, member_id, expires_at) values (?, ?, ?, ?, ?)
     on conflict (team_id, machine_id) do update
       set token_hash = excluded.token_hash, member_id = excluded.member_id, expires_at = excluded.expires_at`,
  ).run(sha256(token), who.teamId, who.machineId, who.memberId, new Date(now + DASHBOARD_LINK_SECONDS * 1000).toISOString());
  return token;
}

/**
 * Uses up the link: the machine it was made for; null when the token is unknown, used or expired. One statement finds
 * and deletes the link, so of two requests with one token exactly one gets the machine.
 */
export function takeDashboardLink(db: Db, token: string, now: number): MachineIdentity | null {
  const row = db
    .prepare("delete from dashboard_links where token_hash = ? returning team_id, machine_id, member_id, expires_at")
    .get(sha256(token)) as LinkRow | undefined;
  if (row === undefined || now >= Date.parse(row.expires_at)) return null;
  return { teamId: row.team_id, memberId: row.member_id, machineId: row.machine_id };
}

/** Drops the pending links of team `teamId`. */
export function dropDashboardLinks(db: Db, teamId: number): void {
  db.prepare("delete from dashboard_links where team_id = ?").run(teamId);
}

/** Drops the pending link of machine `machineId` of team `teamId`. */
export function dropMachineLink(db: Db, teamId: number, machineId: string): void {
  db.prepare("delete from dashboard_links where team_id = ? and machine_id = ?").run(teamId, machineId);
}
