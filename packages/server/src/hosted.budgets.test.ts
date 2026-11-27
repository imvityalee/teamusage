import { expect, test } from "vitest";
import { MID, record } from "./app.fixture.js";
import { hostedLimits } from "./hosted-limits.js";
import { hostedApp, hostedTeam, machineClient, machineIdOf, recordsOf, testCaps, testLimits } from "./hosted.fixture.js";
import { countRowOf, requestAs, rowsOf, STATS_RANGE, twoTeams, type CallerName, type World } from "./hosted.two-teams.fixture.js";
import { roomy } from "./main.fixture.js";
import { forTeam } from "./team-data.js";
import { rec } from "./team-data.fixture.js";

// Two teams on one server, each with a member of the same email and machine id. Each team may send 10 upload records
// and use 100 ms of statistics a minute, and keeps 730 days. The clock stands still at NOW, and each statistics request
// takes 60 ms by the stopwatch.

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
let reading = 0;
const stopwatch = () => (reading += 60);

const LIMITS = testLimits(testCaps(), { uploadsPerMinute: 20, teamUploadRecordsPerMinute: 10, teamStatsMsPerMinute: 100, usageDaysKept: 730 });
const world = () => twoTeams({ limits: LIMITS, now: () => NOW, stopwatch });

const uploadAs = (w: World, caller: CallerName, records: unknown[]) =>
  requestAs(w.app, w.callers[caller], "/api/usage", { method: "POST", body: { records } });
const statsAs = (w: World, caller: CallerName, query = "") => requestAs(w.app, w.callers[caller], `/api/stats?${STATS_RANGE}${query}`);

/** A response as a test compares it: its status, its Retry-After and its body. */
const answer = async (res: Response) => ({ status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() });

/** Uses up A's upload records (1 at set-up, then 9) and its statistics time (2 requests of 60 ms); returns A's refusals. */
async function useUpA(w: World): Promise<Response[]> {
  expect((await uploadAs(w, "machineA", recordsOf(9))).status).toBe(200);
  for (let i = 0; i < 2; i++) expect((await statsAs(w, "codeA")).status).toBe(200);
  const refusals = [
    await uploadAs(w, "machineA", recordsOf(1, 9)),
    await statsAs(w, "codeA"),
    await statsAs(w, "machineA", "&member=me"),
    await statsAs(w, "ann", `&team=${w.teams.A.publicId}`),
  ];
  for (const res of refusals) expect(res.status).toBe(429);
  return refusals;
}

/** B's uploads and statistics requests up to and past its own budgets, as their answers. */
async function answersToB(w: World) {
  const asBob = `&team=${w.teams.B.publicId}`;
  return [
    await answer(await uploadAs(w, "machineB", recordsOf(9))),
    await answer(await uploadAs(w, "machineB", recordsOf(1, 9))),
    await answer(await statsAs(w, "bob", asBob)),
    await answer(await statsAs(w, "machineB", "&member=me")),
    await answer(await statsAs(w, "bob", asBob)),
  ];
}

test("with A's upload records and statistics time used up, B is answered as when A is idle", async () => {
  const whileIdle = await answersToB(await world());
  expect(whileIdle.map((a) => a.status)).toEqual([200, 429, 200, 200, 429]);
  const busy = await world();
  await useUpA(busy);
  expect(await answersToB(busy)).toEqual(whileIdle);
});

test("A's refusals name nothing of B", async () => {
  const w = await world();
  const { publicId, name, memberName, code } = w.teams.B;
  for (const res of await useUpA(w)) {
    const text = await res.text();
    for (const ofB of [publicId, name, memberName, code]) expect(text).not.toContain(ofB);
  }
});

test("an upload to A drops A's expired rows and leaves B's rows and count as they were", async () => {
  const w = await world();
  const { A, B } = w.teams;
  const earlier = () => "2025-06-01T12:00:00.000Z";
  const expired = [rec({ date: "2024-06-01" }), rec({ date: "2024-07-01" })];
  for (const t of [A, B]) forTeam(w.db, t.id, { clock: earlier }).upsertUsage({ memberId: t.memberId, machineId: MID }, expired);
  const before = { rows: rowsOf(w.db, B.id), count: countRowOf(w.db, B.id) };
  expect(before.rows.usage.map((r) => r.date)).toEqual(["2026-11-03", "2024-06-01", "2024-07-01"]);

  expect(await (await uploadAs(w, "machineA", [record({ model: "new" })])).json()).toEqual({ stored: 1, kept: 0 });
  expect(rowsOf(w.db, A.id).usage.map((r) => r.date)).toEqual(["2026-11-03", "2026-11-01"]);
  expect(countRowOf(w.db, A.id)).toMatchObject({ rows: 2 });
  expect({ rows: rowsOf(w.db, B.id), count: countRowOf(w.db, B.id) }).toEqual(before);
});

test("with the real values, each of a team's 600 machines uploads 11 records within one minute", async () => {
  const { db, app } = hostedApp({ limits: (appDb) => hostedLimits({ dataDir: "/data", db: appDb, measure: roomy }), now: () => NOW });
  const { code } = hostedTeam(db, { githubId: 1, login: "ann" }, "code");
  const { register, upload } = machineClient(() => app, () => code);
  const tokens: string[] = [];
  for (let member = 0; member < 60; member++) {
    for (let machine = 0; machine < 10; machine++) {
      const res = await register({ name: `Member ${member}`, email: `member${member}@example.com`, machineId: machineIdOf(member * 10 + machine) });
      expect(res.status).toBe(200);
      tokens.push(((await res.json()) as { token: string }).token);
    }
  }
  const statuses: number[] = [];
  for (const token of tokens) statuses.push((await upload(token, recordsOf(11))).status);
  expect(statuses).toEqual(Array(600).fill(200));
});
