#!/usr/bin/env node
import { closeSync, openSync, readSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import { getSetting, getStoredInviteCode, openDb, type Db } from "./db.js";
import { isMain } from "./entry.js";
import { holdsHostedTeam } from "./hosted-teams.js";
import { NewerSchemaError } from "./migrate.js";
import { openFailureMessage } from "./open-failure.js";
import { forTeam } from "./team-data.js";
import { ensureSingleTeam, rotateInviteCode } from "./teams.js";

const MACHINE_ID = /^[a-f0-9]{32}$/;
const CONTROL = /[\x00-\x1f\x7f]/g;
const USAGE = [
  "usage: teamusage-admin <command>",
  "  members                  list members and their machines",
  "  remove-member <email>    delete a member and all their data",
  "  remove-machine <id>      delete one machine and its data",
  "  show-invite              print the stored invite code",
  "  rotate-invite            generate a new invite code and end all dashboard sessions",
];

const PINNED_SHOW =
  "The invite code is pinned by the TEAMUSAGE_INVITE_CODE environment variable. It is not stored in the database; read it from where the variable is set.";

const HOSTED = "this database belongs to a hosted server; teamusage-admin does not manage it yet";

const clean = (s: string): string => s.replace(CONTROL, "?");

/**
 * Runs one operator command. Returns the process exit code: 0 done, 1 nothing done, 2 bad usage. A hosted server's
 * database is refused whatever the command.
 */
export function runAdmin(
  db: Db,
  argv: string[],
  out: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): number {
  // Before any command, so that none of them can create the single team or an invite code in a hosted database.
  if (holdsHostedTeam(db)) {
    out(HOSTED);
    return 1;
  }
  const usage = (): number => {
    USAGE.forEach(out);
    return 2;
  };
  const [cmd, arg, ...rest] = argv;
  // Resolved inside the commands that use it, after their arguments are checked, so show-invite and bad usage never create a team.
  const team = () => forTeam(db, ensureSingleTeam(db));
  switch (cmd) {
    case "members": {
      if (arg !== undefined) return usage();
      const members = team().listMembers();
      if (members.length === 0) out("no members");
      for (const m of members) {
        out(`${clean(m.name)} <${clean(m.email)}>`);
        for (const x of m.machines) out(`  ${x.id}  ${clean(x.label)}  last sync ${x.lastSyncAt ?? "never"}`);
      }
      return 0;
    }
    case "remove-member": {
      if (arg === undefined || rest.length > 0 || !arg.includes("@")) return usage();
      if (!team().removeMember(arg)) {
        out("no such member");
        return 1;
      }
      out("member removed");
      return 0;
    }
    case "remove-machine": {
      if (arg === undefined || rest.length > 0 || !MACHINE_ID.test(arg)) return usage();
      if (!team().removeMachine(arg)) {
        out("no such machine");
        return 1;
      }
      out("machine removed");
      return 0;
    }
    case "show-invite": {
      if (arg !== undefined) return usage();
      if (env.TEAMUSAGE_INVITE_CODE || getSetting(db, "invite_pinned") === "1") {
        out(PINNED_SHOW);
        return 1;
      }
      const code = getStoredInviteCode(db);
      if (code === undefined) {
        out("The server has not generated an invite code yet. Start the server once, then run this again.");
        return 1;
      }
      out(code);
      return 0;
    }
    case "rotate-invite": {
      if (arg !== undefined) return usage();
      if (env.TEAMUSAGE_INVITE_CODE || getSetting(db, "invite_pinned") === "1") {
        out("The invite code is pinned by the TEAMUSAGE_INVITE_CODE environment variable. Change it there and restart the server; nothing was rotated.");
        return 1;
      }
      out(`new invite code: ${rotateInviteCode(db, ensureSingleTeam(db))}`);
      out("all dashboard sessions have ended");
      return 0;
    }
    default:
      return usage();
  }
}

/** True only for a non-empty file that already holds a teamusage schema. Opens read-only and changes nothing. */
export function isTeamusageDb(file: string): boolean {
  try {
    if (!statSync(file).isFile() || statSync(file).size === 0) return false;
    const fd = openSync(file, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    closeSync(fd);
    if (head.toString("latin1") !== "SQLite format 3\0") return false;
    const ro = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return ro.prepare("select 1 from sqlite_master where type = 'table' and name = 'members'").get() !== undefined;
    } finally {
      ro.close();
    }
  } catch {
    return false;
  }
}

/** The server's database at `file`, or null after printing why it cannot be used. */
export function openServerDb(file: string, printError: (line: string) => void): Db | null {
  if (!isTeamusageDb(file)) {
    printError(`teamusage-admin: no teamusage database at ${file}; is TEAMUSAGE_DATA_DIR the server's data directory?`);
    return null;
  }
  try {
    return openDb(file);
  } catch (err) {
    if (!(err instanceof NewerSchemaError)) throw err;
    printError(openFailureMessage(err));
    return null;
  }
}

if (isMain(import.meta.url)) {
  const db = openServerDb(join(process.env.TEAMUSAGE_DATA_DIR || "/data", "teamusage.sqlite"), (l) => console.error(l));
  if (db === null) process.exit(1);
  const code = runAdmin(db, process.argv.slice(2), (l) => console.log(l));
  db.close();
  process.exit(code);
}
