import { randomBytes } from "node:crypto";
import type { UsageRecord } from "@teamusage/shared";
import { now, sha256, type Db } from "./db.js";
import { upsertUsage } from "./team-usage.js";
import { countRemovedRows } from "./usage-counts.js";

/** The machine id is already registered to a different member. */
export class MachineOwnedError extends Error {
  constructor() {
    super("machine id already registered to another member");
    this.name = "MachineOwnedError";
  }
}

export type MachineIdentity = { teamId: number; memberId: number; machineId: string };

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
    machines: { id: string; label: string; lastSyncAt: string | null }[];
  }[];
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

/** The data of team `teamId`; `clock` gives the time written to `created_at` and `last_sync_at`. */
export function forTeam(db: Db, teamId: number, clock: () => string = now): TeamData {
  return {
    registerMachine: (a) => registerMachine(db, teamId, clock, a),
    upsertUsage: (who, records) => upsertUsage(db, teamId, clock, who, records),
    listMembers: () => listMembers(db, teamId),
    removeMember: (email) => removeMember(db, teamId, email),
    removeMachine: (machineId) => removeMachine(db, teamId, machineId),
    memberExists: (memberId) => memberExists(db, teamId, memberId),
  };
}

function registerMachine(
  db: Db,
  teamId: number,
  clock: () => string,
  a: Parameters<TeamData["registerMachine"]>[0],
): ReturnType<TeamData["registerMachine"]> {
  const email = a.email.trim().toLowerCase();
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  return db.transaction(() => {
    const at = clock();
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
      db.prepare(
        "insert into machines (team_id, id, member_id, label, token_hash, created_at) values (?, ?, ?, ?, ?, ?)",
      ).run(teamId, a.machineId, memberId, a.machineLabel, tokenHash, at);
    }
    return { token, memberId };
  })();
}

function listMembers(db: Db, teamId: number): ReturnType<TeamData["listMembers"]> {
  const members = db.prepare("select id, name, email from members where team_id = ? order by id").all(teamId) as {
    id: number;
    name: string;
    email: string;
  }[];
  const machines = db
    .prepare("select id, member_id, label, last_sync_at from machines where team_id = ? order by created_at, id")
    .all(teamId) as { id: string; member_id: number; label: string; last_sync_at: string | null }[];
  return members.map((m) => ({
    ...m,
    machines: machines
      .filter((x) => x.member_id === m.id)
      .map((x) => ({ id: x.id, label: x.label, lastSyncAt: x.last_sync_at })),
  }));
}

function removeMember(db: Db, teamId: number, email: string): boolean {
  return db.transaction(() => {
    const row = db
      .prepare("select id from members where team_id = ? and email = ?")
      .get(teamId, email.trim().toLowerCase()) as { id: number } | undefined;
    if (!row) return false;
    const usage = db.prepare("delete from usage where team_id = ? and member_id = ?").run(teamId, row.id);
    countRemovedRows(db, teamId, usage.changes);
    db.prepare("delete from machines where team_id = ? and member_id = ?").run(teamId, row.id);
    db.prepare("delete from members where team_id = ? and id = ?").run(teamId, row.id);
    return true;
  })();
}

function removeMachine(db: Db, teamId: number, machineId: string): boolean {
  return db.transaction(() => {
    const usage = db.prepare("delete from usage where team_id = ? and machine_id = ?").run(teamId, machineId);
    countRemovedRows(db, teamId, usage.changes);
    return db.prepare("delete from machines where team_id = ? and id = ?").run(teamId, machineId).changes > 0;
  })();
}

function memberExists(db: Db, teamId: number, memberId: number): boolean {
  return db.prepare("select 1 from members where team_id = ? and id = ?").get(teamId, memberId) !== undefined;
}
