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
  test("300 members registered in a mixed order each come back with their own three machines in creation order", () => {
    let tick = 0;
    const clock = () => new Date(Date.parse("2026-11-02T09:00:00.000Z") + tick++ * 1000).toISOString();
    const timed = forTeam(db, B, { clock });
    // The machine ids ascend against creation order, so a list ordered by id alone differs from one ordered by creation.
    const machineId = (i: number, round: number) => (i * 3 + (2 - round)).toString(16).padStart(32, "0");
    const emailOf = (i: number) => `member${i}@x.com`;
    // Team A holds machines of the same ids, belonging to other members, registered among B's.
    const other = forTeam(db, A);
    const memberIds = new Map<string, number>();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 300; i++) {
        const email = emailOf((i * 7) % 300); // a mixed order of the members within each round
        const j = (i * 7) % 300;
        memberIds.set(email, timed.registerMachine(reg(machineId(j, round), { name: `Member ${j}`, email, machineLabel: `box-${j}-${round}` })).memberId);
        other.registerMachine(reg(machineId(j, round), { name: "Other", email: `other${j}@x.com`, machineLabel: `other-${j}-${round}` }));
      }
    }
    const listed = timed.listMembers();
    expect(listed).toHaveLength(300);
    expect(listed.map((m) => m.id)).toEqual([...listed.map((m) => m.id)].sort((x, y) => x - y));
    for (const m of listed) {
      const j = Number(m.email.slice("member".length, -"@x.com".length));
      expect(m.id).toBe(memberIds.get(m.email));
      expect(m.name).toBe(`Member ${j}`);
      expect(m.machines.map((x) => x.label)).toEqual([0, 1, 2].map((round) => `box-${j}-${round}`));
      expect(m.machines.map((x) => x.id)).toEqual([0, 1, 2].map((round) => machineId(j, round)));
    }
    expect(a.listMembers().every((m) => m.machines.every((x) => x.label.startsWith("other-")))).toBe(true);
  });
  test("a member lists the time their first machine registered, which a later registration keeps", () => {
    let at = "2026-11-02T09:00:00.000Z";
    const timed = forTeam(db, B, { clock: () => at });
    timed.registerMachine(reg(MID));
    at = "2026-11-03T09:00:00.000Z";
    timed.registerMachine(reg(MID2));
    timed.removeMachine(MID);
    timed.removeMachine(MID2);
    expect(timed.listMembers()).toEqual([expect.objectContaining({ joinedAt: "2026-11-02T09:00:00.000Z", machines: [] })]);
  });
});
