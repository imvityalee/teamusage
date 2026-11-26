import { openDb, type Db } from "./db.js";
import { forTeam, type TeamData } from "./team-data.js";
import { createTeam } from "./teams.js";

export const M1 = "1".repeat(32);
export const M2 = "2".repeat(32);
export const M3 = "3".repeat(32);
export const M4 = "4".repeat(32);

/** The range most stats tests read. */
export const Q = { from: "2026-11-01", to: "2026-11-10" };

/** A usage record of `total` tokens: input is total - 3, one each of output, cache create and cache read. */
export const rec = (date: string, agent: string, model: string, total: number, over: Record<string, unknown> = {}) => ({
  date,
  agent,
  model,
  input: total - 3,
  output: 1,
  cacheCreate: 1,
  cacheRead: 1,
  total,
  costUsd: total / 100,
  unpriced: false,
  ...over,
});

/** Stores 2,001 different models on one day in `Q` for machine `who` of team `teamId`: more than one stats answer may hold. */
export function storeTooManyModels(db: Db, teamId: number, who: { memberId: number; machineId: string }): void {
  const records = Array.from({ length: 2001 }, (_, i) => rec("2026-11-02", "claude", `m${i}`, 10));
  const data = forTeam(db, teamId);
  const batch = 500;
  for (let i = 0; i < records.length; i += batch) data.upsertUsage(who, records.slice(i, i + batch));
}

/** A fresh database with one empty team. */
export function newTeam(): { db: Db; team: number; data: TeamData } {
  const db = openDb(":memory:");
  const team = createTeam(db, "Team");
  return { db, team, data: forTeam(db, team) };
}

export function seed(): { db: Db; team: number; ann: number; bob: number } {
  const { db, team, data } = newTeam();
  const a1 = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  const a2 = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M2, machineLabel: "desk" });
  const b = data.registerMachine({ name: "Bob", email: "bob@x.com", machineId: M3, machineLabel: "box" });
  // Ann: machine 1 and 2 share (11-02, claude, m1), so they sum to 30.
  data.upsertUsage({ memberId: a1.memberId, machineId: M1 }, [
    rec("2026-11-02", "claude", "m1", 10),
    rec("2026-11-03", "codex", "m2", 20, { unpriced: true }),
    rec("2026-10-01", "claude", "m1", 1000), // outside range
  ]);
  data.upsertUsage({ memberId: a2.memberId, machineId: M2 }, [rec("2026-11-02", "claude", "m1", 20)]);
  data.upsertUsage({ memberId: b.memberId, machineId: M3 }, [
    rec("2026-11-02", "claude", "m1", 100),
    rec("2026-11-10", "claude", "m1", 5),
    rec("2026-11-11", "claude", "m1", 7), // outside range
  ]);
  return { db, team, ann: a1.memberId, bob: b.memberId };
}

/** Ann (two machines) and Bob; three agents. In range: claude/opus 110, codex/gpt 41, claude/sonnet 20, gemini/g 5, codex/other 2. */
export function seedFilters(): { db: Db; team: number; ann: number; bob: number } {
  const { db, team, data } = newTeam();
  const a1 = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M4, machineLabel: "desk" });
  const b = data.registerMachine({ name: "Bob", email: "bob@x.com", machineId: M3, machineLabel: "box" });
  data.upsertUsage({ memberId: a1.memberId, machineId: M1 }, [
    rec("2026-11-02", "claude", "opus", 10),
    rec("2026-11-02", "claude", "sonnet", 20),
    rec("2026-11-03", "codex", "gpt", 40),
  ]);
  data.upsertUsage({ memberId: b.memberId, machineId: M3 }, [
    rec("2026-11-02", "claude", "opus", 100),
    rec("2026-11-03", "gemini", "g", 5),
    rec("2026-11-04", "codex", "gpt", 1),
    rec("2026-11-04", "codex", "other", 2),
    rec("2026-10-01", "claude", "opus", 1000), // outside range
  ]);
  db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-05T00:00:00.000Z", M1);
  db.prepare("update machines set last_sync_at = ? where id = ?").run("2026-11-06T00:00:00.000Z", M4);
  return { db, team, ann: a1.memberId, bob: b.memberId };
}

/** The same data as the filter tests: Ann claude/opus 10, claude/sonnet 20, codex/gpt 40; Bob claude/opus 100, gemini/g 5, codex/gpt 1, codex/other 2. */
export function seedMix(): { db: Db; team: number; ann: number; bob: number; cy: number } {
  const { db, team, data } = newTeam();
  const a = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M1, machineLabel: "mbp" });
  const a2 = data.registerMachine({ name: "Ann", email: "ann@x.com", machineId: M4, machineLabel: "desk" });
  const b = data.registerMachine({ name: "Bob", email: "bob@x.com", machineId: M3, machineLabel: "box" });
  const c = data.registerMachine({ name: "Cy", email: "cy@x.com", machineId: M2, machineLabel: "idle" });
  data.upsertUsage({ memberId: a.memberId, machineId: M1 }, [
    rec("2026-11-02", "claude", "opus", 6),
    rec("2026-11-02", "claude", "sonnet", 20),
    rec("2026-11-03", "codex", "gpt", 40),
  ]);
  // A second machine of Ann's: summed with the first.
  data.upsertUsage({ memberId: a2.memberId, machineId: M4 }, [rec("2026-11-05", "claude", "opus", 4)]);
  data.upsertUsage({ memberId: b.memberId, machineId: M3 }, [
    rec("2026-11-02", "claude", "opus", 100),
    rec("2026-11-03", "gemini", "g", 5),
    rec("2026-11-04", "codex", "gpt", 1),
    rec("2026-11-04", "codex", "other", 2),
    rec("2026-10-01", "claude", "opus", 1000), // outside range
  ]);
  return { db, team, ann: a.memberId, bob: b.memberId, cy: c.memberId };
}

const MB = "b".repeat(32);

/** One day. Member A: claude/team:D 100, claude/personal 40, codex (no label) 10. Member B: claude (no label) 5. */
export function seedAccounts(): { db: Db; team: number; a: number; b: number } {
  const { db, team, data } = newTeam();
  const a = data.registerMachine({ name: "A", email: "a@x.com", machineId: M1, machineLabel: "l" });
  const b = data.registerMachine({ name: "B", email: "b@x.com", machineId: MB, machineLabel: "l" });
  data.upsertUsage({ memberId: a.memberId, machineId: M1 }, [
    rec("2026-11-02", "claude", "opus", 100, { account: { kind: "team", org: "D" } }),
    rec("2026-11-02", "claude", "sonnet", 40, { account: { kind: "personal" } }),
    rec("2026-11-02", "codex", "gpt", 10),
  ]);
  data.upsertUsage({ memberId: b.memberId, machineId: MB }, [rec("2026-11-02", "claude", "opus", 5)]);
  return { db, team, a: a.memberId, b: b.memberId };
}

const MC = "c".repeat(32);

/** One member: claude unlabelled 100, codex unlabelled 20, codex personal/plus 7, claude team:A/team_premium 50. */
export function seedPlans(): { db: Db; team: number } {
  const { db, team, data } = newTeam();
  const m = data.registerMachine({ name: "P", email: "p@x.com", machineId: MC, machineLabel: "l" });
  data.upsertUsage({ memberId: m.memberId, machineId: MC }, [
    rec("2026-11-02", "claude", "opus", 100),
    rec("2026-11-02", "codex", "gpt", 20),
    rec("2026-11-02", "codex", "gpt5", 7, { account: { kind: "personal", plan: "plus" } }),
    rec("2026-11-02", "claude", "sonnet", 50, { account: { kind: "team", org: "A", plan: "team_premium" } }),
  ]);
  return { db, team };
}
