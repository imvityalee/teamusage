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

const MID = "a".repeat(32);

/**
 * A hosted server at version 7, with SQL of that version: marked as hosted, a team with its code hashed and sealed and its
 * owner; member 7 with a machine, a usage row and its count, a browser signed in as that member and a pending sign-in link.
 */
export function hostedAt7(): Db {
  const db = atVersion(7);
  db.exec("insert into settings (key, value) values ('mode', 'hosted')");
  const team = insertHostedTeam(db, "Aurora", "members");
  db.exec(`
    insert into users (id, github_id, login, created_at) values (4, 41, 'bob', '${T}');
    insert into team_roles (team_id, user_id, role, created_at) values (${team}, 4, 'owner', '${T}');
    insert into sessions (id, kind, github_id, github_login, created_at) values ('${"u".repeat(64)}', 'user', 41, 'bob', '${T}');
    insert into members (id, team_id, email, name, created_at) values (7, ${team}, 'zeb@x.com', 'Zeb', '${T}');
    insert into machines (team_id, id, member_id, label, token_hash, created_at, last_sync_at)
      values (${team}, '${MID}', 7, 'box', '${"g".repeat(64)}', '${T}', '${T}');
    insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total,
        cost_usd, unpriced, account_kind, account_org, account_plan)
      values (${team}, 7, '${MID}', '2026-11-01', 'claude', 'm', 1, 2, 3, 4, 10, 0.25, 0, 'org', 'Acme', 'max');
    insert into usage_counts (team_id, rows, day, added) values (${team}, 1, '2026-11-01', 1);
    insert into sessions (id, kind, team_id, machine_id, member_id, created_at) values ('${"m".repeat(64)}', 'member', ${team}, '${MID}', 7, '${T}');
    insert into dashboard_links (token_hash, team_id, machine_id, member_id, expires_at)
      values ('${"l".repeat(64)}', ${team}, '${MID}', 7, '2026-11-01T00:05:00.000Z');
  `);
  return db;
}

/** A self-hosted server at version 7: its invite code, its one team without a code hash, and a browser signed in with the code. */
export function selfHostedAt7(): Db {
  const db = atVersion(7);
  db.exec(`
    insert into settings (key, value) values ('invite_code', '${"e".repeat(24)}');
    insert into teams (public_id, name, created_at) values ('${"1".repeat(16)}', 'Team', '${T}');
    insert into sessions (id, kind, team_id, created_at) values ('${"c".repeat(64)}', 'team', 1, '${T}');
  `);
  return db;
}
