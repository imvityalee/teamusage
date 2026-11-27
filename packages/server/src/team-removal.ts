import type { Db } from "./db.js";
import { countRemovedRows } from "./usage-counts.js";

/** Usage rows removed in one slice of a removal: 9 to 22 ms of the thread when it was measured. */
export const REMOVAL_SLICE_ROWS = 5_000;
/** Members (by id) and machines (by id) of one team. */
export type Removal = { members: number[]; machines: string[] };

/** A limit SQLite reads as none. */
const NO_LIMIT = -1;

// Each statement carries the team. The ids are bound as JSON arrays and read through json_each, so a removal of any
// size is one statement with fixed text; no value is ever concatenated into SQL. `in` reads a list as a set, so the
// `union all` of the named machines and the named members' machines (read through machines_team_member) needs no sort.
const NAMED_MEMBERS = "select value from json_each(@members)";
const NAMED_MACHINES = `select value from json_each(@machines)
  union all select id from machines where team_id = @teamId and member_id in (${NAMED_MEMBERS})`;

/** Usage rows that name a named member, found through usage_by_member. */
const DELETE_MEMBERS_USAGE = `delete from usage where rowid in (
  select rowid from usage where team_id = @teamId and member_id in (${NAMED_MEMBERS}) limit @most)`;
/** Usage rows of a named machine or of a named member's machine, found through the primary key. */
const DELETE_MACHINES_USAGE = `delete from usage where rowid in (
  select rowid from usage where team_id = @teamId and machine_id in (${NAMED_MACHINES}) limit @most)`;
/** Any of the team's usage rows. */
const DELETE_ANY_USAGE = "delete from usage where rowid in (select rowid from usage where team_id = @teamId limit @most)";
const DELETE_MACHINES = `delete from machines where team_id = @teamId
  and (id in (select value from json_each(@machines)) or member_id in (${NAMED_MEMBERS}))`;
const DELETE_MEMBERS = `delete from members where team_id = @teamId and id in (${NAMED_MEMBERS})`;

const boundIds = (teamId: number, what: Removal) => ({
  teamId,
  members: JSON.stringify(what.members),
  machines: JSON.stringify(what.machines),
});

/**
 * Deletes up to `most` (`NO_LIMIT`: all) of the usage rows `what` holds in team `teamId` and takes them off its count;
 * returns how many. Each statement's own changes are counted, and the second takes only what the first left of `most`.
 */
function deleteUsageOf(db: Db, teamId: number, what: Removal, most: number): number {
  const ids = boundIds(teamId, what);
  const byMember = db.prepare(DELETE_MEMBERS_USAGE).run({ ...ids, most }).changes;
  const left = most === NO_LIMIT ? NO_LIMIT : most - byMember;
  const byMachine = db.prepare(DELETE_MACHINES_USAGE).run({ ...ids, most: left }).changes;
  countRemovedRows(db, teamId, byMember + byMachine);
  return byMember + byMachine;
}

/** `most` when it is a positive whole number; otherwise a RangeError, since SQLite reads a negative limit as none. */
function sliceSize(most: number): number {
  if (!Number.isSafeInteger(most) || most < 1) throw new RangeError("a slice takes a positive whole number of rows");
  return most;
}

/** Removes up to `most` usage rows of the named members and machines in one transaction; returns how many. */
export function removeUsageSlice(db: Db, teamId: number, what: Removal, most: number): number {
  const size = sliceSize(most);
  return db.transaction(() => deleteUsageOf(db, teamId, what, size))();
}

/** Removes up to `most` of the team's usage rows in one transaction; returns how many. */
export function removeAnyUsageSlice(db: Db, teamId: number, most: number): number {
  const size = sliceSize(most);
  return db.transaction(() => {
    const removed = db.prepare(DELETE_ANY_USAGE).run({ teamId, most: size }).changes;
    countRemovedRows(db, teamId, removed);
    return removed;
  })();
}

/**
 * Removes the named members with their machines, the named machines, and the usage they still hold, in one transaction.
 * The usage is deleted and counted here, before the machines and members: the cascade that would take it counts nothing.
 */
export function remove(db: Db, teamId: number, what: Removal): { members: number; machines: number } {
  return db.transaction(() => {
    deleteUsageOf(db, teamId, what, NO_LIMIT);
    const ids = boundIds(teamId, what);
    const machines = db.prepare(DELETE_MACHINES).run(ids).changes;
    const members = db.prepare(DELETE_MEMBERS).run(ids).changes;
    return { members, machines };
  })();
}

/** Removes the member of `email` (any case, any surrounding space) with everything they hold; false when there is none. */
export function removeMember(db: Db, teamId: number, email: string): boolean {
  return db.transaction(() => {
    const row = db
      .prepare("select id from members where team_id = ? and email = ?")
      .get(teamId, email.trim().toLowerCase()) as { id: number } | undefined;
    if (!row) return false;
    remove(db, teamId, { members: [row.id], machines: [] });
    return true;
  })();
}

/** Removes the machine with its usage; false when the team has no such machine. */
export function removeMachine(db: Db, teamId: number, machineId: string): boolean {
  return remove(db, teamId, { members: [], machines: [machineId] }).machines > 0;
}
