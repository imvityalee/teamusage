import { beforeEach, expect, test } from "vitest";
import type { Stats } from "@teamusage/shared";
import { goodReg, record } from "./app.fixture.js";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { DEMO_NAMES as NAMES_IN_ORDER, seedDemo } from "./demo.js";
import { createDemoStats } from "./demo-stats.js";
import { hostedApp, hostedTeam, machineClient, signIn } from "./hosted.fixture.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

const DAY_MS = 86_400_000;
const TODAY = "2026-11-27";
const TOMORROW = "2026-11-28";
const DEMO_NAMES = [...NAMES_IN_ORDER].sort();
const clock = { t: Date.parse(`${TODAY}T12:00:00Z`), advance(ms: number) { this.t += ms; } };
const daysBefore = (n: number, day = TODAY): string => new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
const demoRange = (day: string): string => `/api/demo/stats?from=${daysBefore(29, day)}&to=${day}`;
const DEMO = demoRange(TODAY);

let world: ReturnType<typeof hostedApp>;
let team: { id: number; publicId: string };
let ownerSession: string;
let machineToken: string;
beforeEach(async () => {
  clock.t = Date.parse(`${TODAY}T12:00:00Z`);
  world = hostedApp({ now: () => clock.t });
  const created = hostedTeam(world.db, { githubId: 41, login: "ann" }, "members", "Real Team");
  team = created.team;
  const machine = machineClient(() => world.app, () => created.code);
  machineToken = await machine.join({ name: "Real Person", email: "real@corp.test" });
  await machine.upload(machineToken, [record({ date: TODAY, model: "real-model" })]);
  ownerSession = await signIn(world.app, "code-ann");
});

const getDemo = (path: string, headers: Record<string, string> = {}) => world.app.request(path, { headers });
const statsOf = async (path: string): Promise<Stats> => (await getDemo(path)).json() as Promise<Stats>;
const errorOf = async (res: Response) => ({ status: res.status, body: await res.json() });
const rowsOfRealTeam = () =>
  ["teams", "members", "machines", "usage"].map((table) => world.db.prepare(`select * from ${table}`).all());

test("anyone reads the demo, and it holds the demo's six people and nobody real", async () => {
  const res = await getDemo(`/api/demo/stats?from=${daysBefore(29)}&to=${TODAY}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const stats = (await res.json()) as Stats;
  expect(stats.members.map((m) => m.name).sort()).toEqual(DEMO_NAMES);
  expect(JSON.stringify(stats)).not.toContain("Real Person");
});

test.each([() => ({ Cookie: ownerSession }), () => ({ Authorization: `Bearer ${machineToken}` }), () => ({})])(
  "the answer is the same whoever asks",
  async (headers) => {
    expect(await (await getDemo(`${DEMO}&team=${team.publicId}`, headers())).json()).toEqual(await (await getDemo(DEMO)).json());
  },
);

test("the demo ends today: a day later its last day has moved", async () => {
  const first = await statsOf(demoRange(TODAY));
  clock.advance(DAY_MS);
  const next = await statsOf(demoRange(TOMORROW));
  expect(first.daily.at(-1)?.date).toBe(TODAY);
  expect(next.daily.at(-1)?.date).toBe(TOMORROW);
});

test("one millisecond before UTC midnight the last day is still today, at midnight it is tomorrow", async () => {
  clock.t = Date.parse(`${TOMORROW}T00:00:00Z`) - 1;
  expect((await statsOf(demoRange(TODAY))).daily.at(-1)?.date).toBe(TODAY);
  const wide = `/api/demo/stats?from=${daysBefore(1)}&to=${TOMORROW}`;
  const before = await statsOf(wide);
  expect(before.daily.at(-1)).toEqual({ date: TOMORROW, byAgent: {} });
  clock.advance(1);
  const after = await statsOf(wide);
  expect(Object.keys(after.daily.at(-1)?.byAgent ?? {}).length).toBeGreaterThan(0);
});

test("a member of the demo answers with machines, and never the real team's member", async () => {
  const [first] = (await statsOf(DEMO)).members;
  const res = await getDemo(`${DEMO}&member=${first!.id}`);
  expect(res.status).toBe(200);
  const stats = (await res.json()) as Stats;
  expect(stats.members.map((m) => m.name)).toEqual([first!.name]);
  expect(stats.machines?.length).toBeGreaterThan(0);
  expect(JSON.stringify(stats)).not.toContain("Real Person");
});

test("member=me is 400, a malformed member is 400, an id nobody has is 404", async () => {
  expect(await errorOf(await getDemo(`${DEMO}&member=me`))).toEqual({ status: 400, body: { error: "invalid member" } });
  expect(await errorOf(await getDemo(`${DEMO}&member=0`))).toEqual({ status: 400, body: { error: "invalid query" } });
  expect(await errorOf(await getDemo(`${DEMO}&member=999999`))).toEqual({ status: 404, body: { error: "member not found" } });
});

test("a bad range and a repeated parameter are the 400s of /api/stats", async () => {
  expect(await errorOf(await getDemo(`/api/demo/stats?from=${TODAY}&to=${daysBefore(1)}`))).toEqual({ status: 400, body: { error: "invalid date range" } });
  expect(await errorOf(await getDemo("/api/demo/stats"))).toEqual({ status: 400, body: { error: "invalid date range" } });
  expect(await errorOf(await getDemo(`${DEMO}&from=${TODAY}`))).toEqual({ status: 400, body: { error: "invalid query" } });
  expect(await errorOf(await getDemo(`${DEMO}&account=nonsense`))).toEqual({ status: 400, body: { error: "invalid query" } });
});

test("the real team's rows are unchanged after ten demo requests", async () => {
  const before = rowsOfRealTeam();
  for (let i = 0; i < 10; i++) await getDemo(DEMO);
  expect(rowsOfRealTeam()).toEqual(before);
});

test("a self-hosted server has no demo route, and its --demo start still opens /api/stats to everyone", async () => {
  const db = openDb(":memory:");
  const teamId = ensureSingleTeam(db);
  seedDemo(db, teamId, TODAY);
  const app = createApp(db, { teamForCode: singleTeamCodes(teamId, () => goodReg().inviteCode), demoTeamId: teamId, now: () => clock.t });
  expect(await errorOf(await app.request(DEMO))).toEqual({ status: 404, body: { error: "not found" } });
  const open = await app.request(`/api/stats?from=${daysBefore(29)}&to=${TODAY}`);
  expect(open.status).toBe(200);
  expect(((await open.json()) as Stats).members).toHaveLength(NAMES_IN_ORDER.length);
});

test("seeding again on a new day closes the database it replaces, and a request on the same day opens none", () => {
  const opened: ReturnType<typeof openDb>[] = [];
  const demo = createDemoStats(() => clock.t, () => {
    const db = openDb(":memory:");
    opened.push(db);
    return db;
  });
  const range = { from: daysBefore(1), to: TODAY };
  demo.stats(range);
  demo.memberExists(1);
  expect(opened.map((db) => db.open)).toEqual([true]);
  clock.advance(DAY_MS);
  demo.stats(range);
  expect(opened.map((db) => db.open)).toEqual([false, true]);
});
