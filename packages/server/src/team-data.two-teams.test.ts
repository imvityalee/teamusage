import { beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { authenticate, forTeam, MachineOwnedError, type TeamData } from "./team-data.js";
import { rec, reg } from "./team-data.fixture.js";
import { createTeam } from "./teams.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("two teams", () => {
  const MID = "a".repeat(32);
  const MID2 = "b".repeat(32);
  const usageRows = (teamId: number) => (db.prepare("select count(*) as n from usage where team_id = ?").get(teamId) as { n: number }).n;
  let A: number, B: number, a: TeamData, b: TeamData;
  beforeEach(() => {
    A = createTeam(db, "A");
    B = createTeam(db, "B");
    a = forTeam(db, A);
    b = forTeam(db, B);
  });

  test("the same email and machine id in two teams are two members and two machines", () => {
    const ra = a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    expect(ra.memberId).not.toBe(rb.memberId);
    expect(authenticate(db, ra.token)).toEqual({ teamId: A, memberId: ra.memberId, machineId: MID });
    expect(authenticate(db, rb.token)).toEqual({ teamId: B, memberId: rb.memberId, machineId: MID });
  });
  test("usage is stored in its own team only", () => {
    const ra = a.registerMachine(reg(MID));
    b.registerMachine(reg(MID));
    a.upsertUsage({ memberId: ra.memberId, machineId: MID }, [rec()]);
    expect([usageRows(A), usageRows(B)]).toEqual([1, 0]);
  });
  test("a member of another team cannot be written through this team", () => {
    a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    expect(() => a.upsertUsage({ memberId: rb.memberId, machineId: MID }, [rec()])).toThrow();
    expect([usageRows(A), usageRows(B)]).toEqual([0, 0]);
  });
  test("a machine id taken by another member is refused inside a team, not across teams", () => {
    a.registerMachine(reg(MID));
    expect(() => a.registerMachine(reg(MID, { email: "bob@x.com" }))).toThrow(MachineOwnedError);
    expect(() => b.registerMachine(reg(MID, { email: "bob@x.com" }))).not.toThrow();
  });
  test("ids that exist only in another team look unknown", () => {
    const rb = b.registerMachine(reg(MID2, { email: "bob@x.com" }));
    expect(a.memberExists(rb.memberId)).toBe(false);
    expect(a.removeMachine(MID2)).toBe(false);
    expect(a.removeMember("bob@x.com")).toBe(false);
    expect(a.listMembers()).toEqual([]);
    expect(b.listMembers().map((m) => m.email)).toEqual(["bob@x.com"]);
  });
  test("removing a member removes only that team's member, machines and usage", () => {
    const ra = a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    a.upsertUsage({ memberId: ra.memberId, machineId: MID }, [rec()]);
    b.upsertUsage({ memberId: rb.memberId, machineId: MID }, [rec()]);
    expect(a.removeMember("a@example.com")).toBe(true);
    expect([usageRows(A), usageRows(B)]).toEqual([0, 1]);
    expect(authenticate(db, ra.token)).toBeNull();
    expect(authenticate(db, rb.token)).not.toBeNull();
  });
  test("removing a machine leaves the other team's machine of the same id and its usage", () => {
    const ra = a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID));
    a.upsertUsage({ memberId: ra.memberId, machineId: MID }, [rec()]);
    b.upsertUsage({ memberId: rb.memberId, machineId: MID }, [rec()]);
    expect(a.removeMachine(MID)).toBe(true);
    expect([usageRows(A), usageRows(B)]).toEqual([0, 1]);
    expect(b.listMembers()[0]!.machines.map((m) => m.id)).toEqual([MID]);
    expect(authenticate(db, rb.token)).toEqual({ teamId: B, memberId: rb.memberId, machineId: MID });
  });
  test("an upload stamps the last sync only on its own team's machine", () => {
    const ra = a.registerMachine(reg(MID));
    b.registerMachine(reg(MID));
    a.upsertUsage({ memberId: ra.memberId, machineId: MID }, [rec()]);
    expect(a.listMembers()[0]!.machines[0]!.lastSyncAt).not.toBeNull();
    expect(b.listMembers()[0]!.machines[0]!.lastSyncAt).toBeNull();
  });
  test("re-registering a machine keeps the other team's token and label for the same id", () => {
    a.registerMachine(reg(MID));
    const rb = b.registerMachine(reg(MID, { machineLabel: "box" }));
    a.registerMachine(reg(MID, { machineLabel: "new" }));
    expect(authenticate(db, rb.token)).toEqual({ teamId: B, memberId: rb.memberId, machineId: MID });
    expect(b.listMembers()[0]!.machines[0]!.label).toBe("box");
    expect(a.listMembers()[0]!.machines[0]!.label).toBe("new");
  });
  test("a given clock stamps new rows and the last sync", () => {
    const fixed = forTeam(db, A, { clock: () => "2026-11-24T12:00:00.000Z" });
    const r = fixed.registerMachine(reg(MID));
    fixed.upsertUsage({ memberId: r.memberId, machineId: MID }, [rec()]);
    expect(fixed.listMembers()[0]!.machines[0]!.lastSyncAt).toBe("2026-11-24T12:00:00.000Z");
    expect(db.prepare("select created_at from members where id = ?").get(r.memberId)).toEqual({ created_at: "2026-11-24T12:00:00.000Z" });
    expect(db.prepare("select created_at from machines where team_id = ? and id = ?").get(A, MID)).toEqual({
      created_at: "2026-11-24T12:00:00.000Z",
    });
  });
});
