import { beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import { goodReg, MID, MID2, record } from "./app.fixture.js";
import type { Db } from "./db.js";
import { hostedApp, hostedTeam, postFromPage, signIn, testLimits } from "./hosted.fixture.js";
import { rowsOf, SAME_EMAIL } from "./hosted.two-teams.fixture.js";
import { STATS_BOUNDS } from "./stats-bounds.js";
import { forTeam } from "./team-data.js";
import type { TeamLimits } from "./team-limits.js";

// Two hosted teams on one server under small limits: team A is brought to its caps, team B is not, and each has a
// member with the same email and the same laptop.

const NOW = Date.parse("2026-11-25T10:30:00.000Z");
const TODAY = "2026-11-25";
const MID3 = "c".repeat(32);
const B_MEMBER = "Zebulon Vexworth";

const caps = (): TeamLimits => ({
  membersPerTeam: 2, machinesPerMember: 2, rowsPerMachine: 4, rowsPerTeam: 100, rowsAddedPerDay: 6, storageLow: () => false,
});

let db: Db;
let app: Hono;
let A: ReturnType<typeof hostedTeam>;
let B: ReturnType<typeof hostedTeam>;

beforeEach(() => {
  ({ db, app } = hostedApp({ limits: testLimits(caps()), now: () => NOW }));
  A = hostedTeam(db, { githubId: 1, login: "ann" }, "code", "Aurora Quillfeather Collective");
  B = hostedTeam(db, { githubId: 2, login: "bob" }, "admins", "Borealis Zephyrine Guild");
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => postFromPage(app, path, body, headers);
const register = (code: string, over: Record<string, unknown>) => post("/api/register", goodReg({ inviteCode: code, ...over }));
const upload = (token: string, body: unknown) => post("/api/usage", body, { Authorization: `Bearer ${token}` });
/** `n` records of different models, named after `tag`. */
const newRecords = (n: number, tag: string) => Array.from({ length: n }, (_, i) => record({ model: `${tag}${i}` }));
/** Team `teamId`'s row of usage counts, read beside `rowsOf`, which does not read it. */
const countsOf = (teamId: number) => db.prepare("select * from usage_counts where team_id = ?").get(teamId);
const stateOf = (teamId: number) => ({ rows: rowsOf(db, teamId), counts: countsOf(teamId) });

/** Registers a machine of team `code` and returns its token. */
async function join(code: string, over: Record<string, unknown>): Promise<string> {
  const res = await register(code, over);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** An upload that must be accepted. */
async function accepted(token: string, records: unknown[]): Promise<void> {
  expect((await upload(token, { records })).status).toBe(200);
}

/** B's member, with the laptop A's member also has and a desktop that stored one row; returns the laptop's token. */
async function setUpB(): Promise<string> {
  const laptop = await join(B.code, { name: B_MEMBER, email: SAME_EMAIL, machineId: MID });
  const desktop = await join(B.code, { name: B_MEMBER, email: SAME_EMAIL, machineId: MID2 });
  await accepted(desktop, newRecords(1, "desktop"));
  return laptop;
}

/**
 * Brings A to its member cap, its laptop to its row cap and its day's allowance to its end, then sends A's requests
 * that these refuse, the last one after the laptop's three uploads of the minute; returns the refusals.
 */
async function refuseA(): Promise<Response[]> {
  const laptop = await join(A.code, { name: "Ottoline Quaxley", email: SAME_EMAIL, machineId: MID });
  const other = await join(A.code, { name: "Second", email: "second@example.com", machineId: MID2 });
  await accepted(laptop, newRecords(4, "a"));
  await accepted(other, newRecords(2, "b"));
  return [
    await register(A.code, { email: "third@example.com", machineId: MID3 }),
    await upload(laptop, { records: newRecords(1, "c") }),
    await upload(other, { records: newRecords(1, "d") }),
    await upload(laptop, { records: newRecords(1, "e") }),
    await upload(laptop, { records: newRecords(1, "f") }),
  ];
}

describe("one team at its limits", () => {
  test("is refused by each limit, with answers that name nothing of the other team, and the other team does not change", async () => {
    await setUpB();
    const before = stateOf(B.team.id);
    const refusals = await refuseA();
    const answers = await Promise.all(refusals.map(async (r) => [r.status, ((await r.clone().json()) as { limit: string }).limit]));
    expect(answers).toEqual([[409, "members"], [409, "machine-rows"], [429, "team-rows-per-day"], [409, "machine-rows"], [429, "uploads"]]);
    for (const res of refusals) {
      const text = await res.text();
      for (const marker of [B.team.publicId, B.team.name, B_MEMBER, B.code]) expect(text).not.toContain(marker);
    }
    expect(stateOf(B.team.id)).toEqual(before);
  });

  test("leaves the other team its own: a new member, new rows on the same laptop and three uploads in the same minute", async () => {
    const laptop = await setUpB();
    await refuseA();
    await join(B.code, { email: "third@example.com", machineId: MID3 });
    for (let i = 0; i < 3; i++) await accepted(laptop, newRecords(1, `laptop${i}-`));
    const { rows, counts } = stateOf(B.team.id);
    expect(rows.members.map((m) => m.email)).toEqual([SAME_EMAIL, "third@example.com"]);
    expect(rows.machines.map((m) => m.id)).toEqual([MID, MID2, MID3]);
    expect(rows.usage.map((u) => [u.machine_id, u.model])).toEqual([
      [MID2, "desktop0"], [MID, "laptop0-0"], [MID, "laptop1-0"], [MID, "laptop2-0"],
    ]);
    expect(counts).toEqual({ team_id: B.team.id, rows: 4, day: TODAY, added: 4 });
  });

  test("a refused upload with its token whose body names the other team changes nothing in the other team", async () => {
    await setUpB();
    const laptop = await join(A.code, { email: SAME_EMAIL, machineId: MID });
    await accepted(laptop, newRecords(4, "a"));
    const before = stateOf(B.team.id);
    const res = await upload(laptop, { teamId: B.team.id, team: B.team.publicId, records: newRecords(1, "g") });
    expect([res.status, await res.json()]).toEqual([409, { error: "this machine has reached its limit of 4 usage rows", limit: "machine-rows" }]);
    expect(stateOf(B.team.id)).toEqual(before);
  });
});

describe("GET /api/stats on a hosted server", () => {
  const TOO_LARGE = { error: "this team's usage has too many different agents, models or accounts to show", limit: "stats" };
  const statsOf = (team: ReturnType<typeof hostedTeam>, cookie: string) =>
    app.request(`/api/stats?from=2026-11-01&to=2026-11-01&team=${team.team.publicId}`, { headers: { Cookie: cookie } });

  /** Stores in A one more agent than an answer may hold, through its data layer, which sets no limits. */
  function overfillA(): void {
    const data = forTeam(db, A.team.id);
    const { memberId } = data.registerMachine({ name: "Ann", email: SAME_EMAIL, machineId: MID, machineLabel: "mbp" });
    const records = Array.from({ length: STATS_BOUNDS.agents + 1 }, (_, i) => record({ agent: `agent${i}` }));
    data.upsertUsage({ memberId, machineId: MID }, records);
  }

  test("a session on a team whose usage is too large is answered 409", async () => {
    overfillA();
    const res = await statsOf(A, await signIn(app, "code-ann"));
    expect([res.status, await res.json()]).toEqual([409, TOO_LARGE]);
  });

  test("a caller with no role in that team gets what it gets for a team with small usage, never the 409", async () => {
    overfillA();
    const eve = await signIn(app, "code-eve");
    const large = await statsOf(A, eve);
    const small = await statsOf(B, eve);
    expect([large.status, await large.json()]).toEqual([404, { error: "team not found" }]);
    expect([small.status, await small.json()]).toEqual([404, { error: "team not found" }]);
  });
});
