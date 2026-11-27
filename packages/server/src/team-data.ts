import { randomBytes } from "node:crypto";
import type { UsageRecord } from "@teamusage/shared";
import { now, sha256, type Db } from "./db.js";
import { refuseBeyondLimits, type TeamLimits } from "./team-limits.js";
import { dropExpiredUsage, oldestDateKept } from "./team-retention.js";
import { remove, removeAnyUsageSlice, removeMachine, removeMember, removeUsageSlice, type Removal } from "./team-removal.js";
import { upsertUsage, type WriteOptions } from "./team-usage.js";

/** The machine id is already registered to a different member. */
export class MachineOwnedError extends Error {
  constructor() {
    super("machine id already registered to another member");
    this.name = "MachineOwnedError";
  }
}

export type MachineIdentity = { teamId: number; memberId: number; machineId: string };

/** A machine's id as a client makes it: 32 lowercase hex digits. */
export const isMachineId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{32}$/.test(v);

/** Members, machines and usage of one team; nothing here reads or writes another team's rows. */
export interface TeamData {
  registerMachine(a: { name: string; email: string; machineId: string; machineLabel: string }): {
    token: string;
    memberId: number;
  };
  upsertUsage(who: { memberId: number; machineId: string }, records: UsageRecord[]): { stored: number; kept: number };
  listMembers(): {
    id: number;
    name: string;
    email: string;
    /** When the member's first machine registered, an ISO time. */
    joinedAt: string;
    machines: { id: string; label: string; lastSyncAt: string | null }[];
  }[];
  /**
   * Removes up to `most` usage rows of the named members and machines, takes them off the team's count, and returns how
   * many; fewer than `most` means they hold none now. One transaction. Throws a RangeError when `most` is not a
   * positive whole number.
   */
  removeUsageSlice(what: Removal, most: number): number;
  /** The same for any of the team's usage rows, with the same RangeError. */
  removeAnyUsageSlice(most: number): number;
  /**
   * Removes the named members with their machines, the named machines, and the usage they still hold, in one transaction;
   * an id the team does not have is skipped. Returns how many members and machines it removed.
   */
  remove(what: Removal): { members: number; machines: number };
  removeMember(email: string): boolean;
  removeMachine(machineId: string): boolean;
  memberExists(memberId: number): boolean;
}

/** The machine a token belongs to, in whichever team it is registered. */
export function authenticate(db: Db, token: string): MachineIdentity | null {
  const row = db.prepare("select team_id, member_id, id from machines where token_hash = ?").get(sha256(token)) as
    | { team_id: number; member_id: number; id: string }
    | undefined;
  return row ? { teamId: row.team_id, memberId: row.member_id, machineId: row.id } : null;
}

/**
 * The data of team `teamId`. `clock` gives the time written to rows; `limits`, when set, bound what the team may hold;
 * `daysKept`, when set, is how many days of usage the team keeps.
 */
export function forTeam(
  db: Db,
  teamId: number,
  o?: { clock?: () => string; limits?: TeamLimits; daysKept?: number },
): TeamData {
  const writes: WriteOptions = { clock: o?.clock ?? now, limits: o?.limits };
  return {
    registerMachine: (a) => registerMachine(db, teamId, writes, a),
    upsertUsage: uploadUnderRetention(db, teamId, writes, o?.daysKept),
    listMembers: () => listMembers(db, teamId),
    removeUsageSlice: (what, most) => removeUsageSlice(db, teamId, what, most),
    removeAnyUsageSlice: (most) => removeAnyUsageSlice(db, teamId, most),
    remove: (what) => remove(db, teamId, what),
    removeMember: (email) => removeMember(db, teamId, email),
    removeMachine: (machineId) => removeMachine(db, teamId, machineId),
    memberExists: (memberId) => memberExists(db, teamId, memberId),
  };
}

function registerMachine(
  db: Db,
  teamId: number,
  o: WriteOptions,
  a: Parameters<TeamData["registerMachine"]>[0],
): ReturnType<TeamData["registerMachine"]> {
  const email = a.email.trim().toLowerCase();
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  return db.transaction(() => {
    const at = o.clock();
    const knownMember = db.prepare("select 1 from members where team_id = ? and email = ?").get(teamId, email);
    if (!knownMember) refuseNewMember(db, teamId, o.limits);
    db.prepare(
      "insert into members (team_id, email, name, created_at) values (?, ?, ?, ?) on conflict (team_id, email) do update set name = excluded.name",
    ).run(teamId, email, a.name, at);
    const { id: memberId } = db.prepare("select id from members where team_id = ? and email = ?").get(teamId, email) as {
      id: number;
    };
    const existing = db.prepare("select member_id from machines where team_id = ? and id = ?").get(teamId, a.machineId) as
      | { member_id: number }
      | undefined;
    if (existing && existing.member_id !== memberId) {
      throw new MachineOwnedError();
    }
    if (existing) {
      db.prepare("update machines set label = ?, token_hash = ? where team_id = ? and id = ?").run(
        a.machineLabel,
        tokenHash,
        teamId,
        a.machineId,
      );
    } else {
      refuseNewMachine(db, teamId, memberId, o.limits);
      db.prepare(
        "insert into machines (team_id, id, member_id, label, token_hash, created_at) values (?, ?, ?, ?, ?, ?)",
      ).run(teamId, a.machineId, memberId, a.machineLabel, tokenHash, at);
    }
    return { token, memberId };
  })();
}

/**
 * The team's upload. With `daysKept`, it first drops the team's expired rows in a transaction of their own, so that an
 * upload a cap refuses has still dropped them, and sets aside the records dated before the oldest date kept: they are
 * not written and count as kept.
 */
function uploadUnderRetention(db: Db, teamId: number, o: WriteOptions, daysKept: number | undefined): TeamData["upsertUsage"] {
  return (who, records) => {
    if (daysKept === undefined) return upsertUsage(db, teamId, o, who, records);
    const oldest = oldestDateKept(o.clock(), daysKept);
    dropExpiredUsage(db, teamId, oldest);
    const current = records.filter((r) => r.date >= oldest);
    const { stored, kept } = upsertUsage(db, teamId, o, who, current);
    return { stored, kept: kept + records.length - current.length };
  };
}

/** Throws `LimitError` when `limits` leave team `teamId` no room for one more member. */
function refuseNewMember(db: Db, teamId: number, limits: TeamLimits | undefined): void {
  refuseBeyondLimits(limits, (l) => {
    const held = db.prepare("select count(*) as n from members where team_id = ?").get(teamId) as { n: number };
    return [{ limit: "members", wouldHold: held.n + 1, cap: l.membersPerTeam }];
  });
}

/** Throws `LimitError` when `limits` leave member `memberId` of team `teamId` no room for one more machine. */
function refuseNewMachine(db: Db, teamId: number, memberId: number, limits: TeamLimits | undefined): void {
  refuseBeyondLimits(limits, (l) => {
    const held = db
      .prepare("select count(*) as n from machines where team_id = ? and member_id = ?")
      .get(teamId, memberId) as { n: number };
    return [{ limit: "machines", wouldHold: held.n + 1, cap: l.machinesPerMember }];
  });
}

type Listed = ReturnType<TeamData["listMembers"]>[number];

/** The team's members by id, each with its machines by creation, then id; the machines are read once and grouped by member. */
function listMembers(db: Db, teamId: number): Listed[] {
  const rows = db.prepare("select id, name, email, created_at from members where team_id = ? order by id").all(teamId) as {
    id: number;
    name: string;
    email: string;
    created_at: string;
  }[];
  const members = rows.map((m): Listed => ({ id: m.id, name: m.name, email: m.email, joinedAt: m.created_at, machines: [] }));
  const byId = new Map(members.map((m) => [m.id, m.machines]));
  const machines = db
    .prepare("select id, member_id, label, last_sync_at from machines where team_id = ? order by created_at, id")
    .all(teamId) as { id: string; member_id: number; label: string; last_sync_at: string | null }[];
  for (const x of machines) byId.get(x.member_id)?.push({ id: x.id, label: x.label, lastSyncAt: x.last_sync_at });
  return members;
}

function memberExists(db: Db, teamId: number, memberId: number): boolean {
  return db.prepare("select 1 from members where team_id = ? and id = ?").get(teamId, memberId) !== undefined;
}
