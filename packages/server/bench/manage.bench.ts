import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { createHostedTeam, deleteTeam, teamById } from "../src/hosted-teams.js";
import { HOSTED_CAPS } from "../src/team-limits.js";
import { forTeam } from "../src/team-data.js";
import { REMOVAL_SLICE_ROWS } from "../src/team-removal.js";
import { seedLargeTeam } from "./seed.js";
import { line, removalLine, timeRuns } from "./timing.js";

const TODAY = "2026-11-24";
const KEY = Buffer.alloc(32, 5);
const REMOVED_MEMBERS = 100;

/** A new hosted team owned by a GitHub user of its own. */
const newTeam = (db: Db, name: string, ownerGithubId: number): number =>
  createHostedTeam(db, { name, dashboardAccess: "members", owner: { githubId: ownerGithubId, login: name }, codeKey: KEY, maxTeams: 10 }).team.id;

const usageRows = (db: Db, teamId: number): number => db.prepare("select count(*) from usage where team_id = ?").pluck().get(teamId) as number;

/** A team at the hosted caps: 2,000 members with 10 machines each and no usage. */
function seedAtCaps(db: Db): number {
  const team = newTeam(db, "Caps", 3101);
  const data = forTeam(db, team, { clock: () => `${TODAY}T00:00:00.000Z` });
  db.transaction(() => {
    for (let i = 0; i < HOSTED_CAPS.membersPerTeam; i++) {
      for (let p = 0; p < HOSTED_CAPS.machinesPerMember; p++) {
        const machineId = `${i.toString(16).padStart(16, "0")}${p.toString(16).padStart(16, "0")}`;
        data.registerMachine({ name: `Member ${i}`, email: `member${i}@example.com`, machineId, machineLabel: `machine-${p}` });
      }
    }
  })();
  return team;
}

/** The 500-member team with 180 days of two rows a machine: 600 machines, 216,000 rows. */
function seedLarge(db: Db, name: string, ownerGithubId: number): number {
  const team = newTeam(db, name, ownerGithubId);
  expect(seedLargeTeam(db, team, { members: 500, days: 180, today: TODAY })).toEqual({ machines: 600, rows: 216_000 });
  return team;
}

/** Runs `slice` until it removes fewer than a full slice; returns how long each took, in ms, and how many rows they removed. */
function timeSlices(slice: () => number): { slices: number[]; rows: number } {
  const slices: number[] = [];
  let rows = 0;
  for (;;) {
    const start = performance.now();
    const removed = slice();
    slices.push(performance.now() - start);
    rows += removed;
    if (removed < REMOVAL_SLICE_ROWS) return { slices, rows };
  }
}

/** Times `run` once, in ms. */
function timeOnce(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function timeMemberList(db: Db, team: number): string {
  let listed = 0;
  const timing = timeRuns(() => (listed = forTeam(db, team).listMembers().length));
  expect(listed).toBe(HOSTED_CAPS.membersPerTeam);
  return line("member list at the caps (2,000 members, 20,000 machines)", timing);
}

/** Removes the large team's first 100 members, whose 120 machines hold 43,200 rows, as the removal route does. */
function timeRemoval(db: Db, team: number): string {
  const data = forTeam(db, team);
  const what = { members: data.listMembers().slice(0, REMOVED_MEMBERS).map((m) => m.id), machines: [] };
  const { slices, rows } = timeSlices(() => data.removeUsageSlice(what, REMOVAL_SLICE_ROWS));
  const last = timeOnce(() => expect(data.remove(what)).toEqual({ members: REMOVED_MEMBERS, machines: 120 }));
  expect(rows).toBe(43_200);
  expect(data.listMembers()).toHaveLength(500 - REMOVED_MEMBERS);
  return removalLine("removing 100 members (43,200 rows) in slices of 5,000", slices, last);
}

/** Deletes the large team as the deletion route does: its usage in slices, then the team in one step. */
function timeDeletion(db: Db, team: number): string {
  const { slices, rows } = timeSlices(() => forTeam(db, team).removeAnyUsageSlice(REMOVAL_SLICE_ROWS));
  const last = timeOnce(() => expect(deleteTeam(db, team)).toBe(true));
  expect(rows).toBe(216_000);
  expect([teamById(db, team), usageRows(db, team)]).toEqual([null, 0]);
  return removalLine("deleting the 500-member, 216,000-row team in slices of 5,000", slices, last);
}

/** Times the last step of deleting the team at the caps, once: the team, its members and machines go in one step. */
function timeLastStep(db: Db, team: number): string {
  const ms = timeOnce(() => expect(deleteTeam(db, team)).toBe(true));
  expect(teamById(db, team)).toBeNull();
  expect(forTeam(db, team).listMembers()).toEqual([]);
  return `the last step of deleting a team of 2,000 members and 20,000 machines: ${ms.toFixed(1)} ms`;
}

test("timing: the member list at the caps, removing 100 members, and deleting a team", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamusage-bench-"));
  try {
    const db = openDb(join(dir, "bench.db"));
    const caps = seedAtCaps(db);
    const [removing, deleting] = [seedLarge(db, "Removing", 3102), seedLarge(db, "Deleting", 3103)];
    for (const printed of [timeMemberList(db, caps), timeRemoval(db, removing), timeDeletion(db, deleting), timeLastStep(db, caps)]) console.log(printed);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
