import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Hono } from "hono";
import { goodReg, INVITE } from "./app.fixture.js";
import { createApp } from "./app.js";
import type { AppOptions } from "./app-context.js";
import { openDb, type Db } from "./db.js";
import { codeLogin, cookieOf, hostedApp, hostedTeam, machineClient, mid, signIn, testLimits } from "./hosted.fixture.js";
import { storeTooManyModels } from "./stats.fixture.js";
import type { TeamLimits } from "./team-limits.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

// A team's statistics may use 100 ms of the thread a minute; the stopwatch moves `cost.ms` at each reading, so each
// getStats takes `cost.ms`.

type Headers = Record<string, string>;
type Owner = { githubId: number; login: string };

const RANGE = "from=2026-11-01&to=2026-11-10";
const BUSY = { error: "this team's statistics are busy; try again in a minute", limit: "team-stats" };
const clock = { t: 0 };
const cost = { ms: 60 };
let t = 0;
const stopwatch = () => {
  const v = t;
  t += cost.ms;
  return v;
};

let db: Db;
let app: Hono;
let a: { id: number; publicId: string; memberId: number };
let sessionA: Headers;
let tokenA: Headers;
let sessionB: Headers;

const caps = (): TeamLimits => ({
  membersPerTeam: 5, machinesPerMember: 6, rowsPerMachine: 1000, rowsPerTeam: 1001, rowsAddedPerDay: 1002, storageLow: () => false,
});
const stats = (headers: Headers, query = RANGE) => app.request(`/api/stats?${query}`, { headers });
const answer = async (res: Response) => [res.status, await res.json()];

/** Creates a team of `owner` whose dashboard opens with its code, registers one machine and signs in with the code. */
async function setUpTeam(owner: Owner, machine: number) {
  const { team, code } = hostedTeam(db, owner, "code");
  const joined = await machineClient(() => app, () => code).register({ machineId: mid(machine), email: `${owner.login}@example.com` });
  const { token, memberId } = (await joined.json()) as { token: string; memberId: number };
  const session = cookieOf(await codeLogin(app, code), "tu_session");
  return { team: { ...team, memberId }, token: { Authorization: `Bearer ${token}` }, session: { Cookie: session } };
}

async function server(o: Pick<AppOptions, "stopwatch"> = { stopwatch }): Promise<void> {
  ({ db, app } = hostedApp({ limits: testLimits(caps(), { teamStatsMsPerMinute: 100 }), now: () => clock.t, stopwatch: o.stopwatch }));
  const teamA = await setUpTeam({ githubId: 1, login: "ann" }, 1);
  const teamB = await setUpTeam({ githubId: 2, login: "bob" }, 2);
  ({ team: a, token: tokenA, session: sessionA } = teamA);
  sessionB = teamB.session;
}

/** Uses up A's minute: two requests of 60 ms against its 100. */
async function useUpA(): Promise<void> {
  cost.ms = 60;
  for (let i = 0; i < 2; i++) expect((await stats(sessionA)).status).toBe(200);
  expect(await (await stats(sessionA)).json()).toEqual(BUSY);
}

beforeEach(async () => {
  clock.t = Date.parse("2026-11-25T10:30:00.000Z");
  await server();
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("a team's statistics answer until its minute's time is used up, for every kind of caller", async () => {
  cost.ms = 60;
  expect((await stats(sessionA)).status).toBe(200);
  expect((await stats(tokenA, `${RANGE}&member=me`)).status).toBe(200);    // 120 of 100: answered
  for (const caller of [sessionA, tokenA]) {
    const res = await stats(caller);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(BUSY);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(res.headers.get("cache-control")).toBe("no-store");
  }
  expect((await stats(sessionB)).status).toBe(200);
  clock.t += 60_000;
  expect((await stats(sessionA)).status).toBe(200);
});

test("another team's time is spent against that team only", async () => {
  expect((await stats(sessionA)).status).toBe(200);                       // 60 of A's 100
  for (let i = 0; i < 2; i++) expect((await stats(sessionB)).status).toBe(200);   // 120 of B's own 100
  expect((await stats(sessionA)).status).toBe(200);                       // A still had 40 left
  expect(await answer(await stats(sessionB))).toEqual([429, BUSY]);
});

describe("while A is busy, a request it would refuse anyway gets today's answer", () => {
  test("without a credential: 401", async () => {
    await useUpA();
    expect(await answer(await stats({}))).toEqual([401, { error: "unauthorized" }]);
  });
  test("B's owner asking for A: what it gets when A is not busy", async () => {
    const bob = { Cookie: await signIn(app, "code-bob") };
    const asksForA = async () => answer(await stats(bob, `${RANGE}&team=${a.publicId}`));
    const notBusy = await asksForA();
    expect(notBusy).toEqual([404, { error: "team not found" }]);
    await useUpA();
    expect(await asksForA()).toEqual(notBusy);
  });
  test("a code session of A after A's dashboard is limited to its admins: 401", async () => {
    await useUpA();
    db.prepare("update teams set dashboard_access = 'admins' where id = ?").run(a.id);
    expect(await answer(await stats(sessionA))).toEqual([401, { error: "unauthorized" }]);
  });
  test("a bad range: 400", async () => {
    await useUpA();
    expect(await answer(await stats(sessionA, "from=2026-11-10&to=2026-11-01"))).toEqual([400, { error: "invalid date range" }]);
  });
  test("a member that does not exist: 404", async () => {
    await useUpA();
    expect(await answer(await stats(sessionA, `${RANGE}&member=999`))).toEqual([404, { error: "member not found" }]);
  });
});

test("refused requests spend nothing: the minute ends when the first refusal said, and a bad range or a missing member costs nothing", async () => {
  await useUpA();
  const named = clock.t + Number((await stats(sessionA)).headers.get("retry-after")) * 1000;
  for (let i = 0; i < 9; i++) expect((await stats(tokenA)).status).toBe(429);
  clock.t = named - 1;
  expect((await stats(sessionA)).status).toBe(429);
  clock.t = named;
  expect((await stats(sessionA)).status).toBe(200);                       // 60 of 100
  for (let i = 0; i < 5; i++) expect((await stats(sessionA, "from=bad&to=bad")).status).toBe(400);
  for (let i = 0; i < 5; i++) expect((await stats(sessionA, `${RANGE}&member=999`)).status).toBe(404);
  expect((await stats(sessionA)).status).toBe(200);                       // still 60 of 100 before it
  expect(await (await stats(sessionA)).json()).toEqual(BUSY);
});

test("a request too large to answer is 409, and the time it took is spent", async () => {
  storeTooManyModels(db, a.id, { memberId: a.memberId, machineId: mid(1) });
  cost.ms = 60;
  for (let i = 0; i < 2; i++) expect((await stats(sessionA)).status).toBe(409);   // 120 of 100
  expect(await answer(await stats(sessionA))).toEqual([429, BUSY]);
});

test("without a stopwatch of its own, the app measures with the real one", async () => {
  await server({});
  let reading = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (reading += 60));
  for (let i = 0; i < 2; i++) expect((await stats(sessionA)).status).toBe(200);   // 120 of 100
  expect(await answer(await stats(sessionA))).toEqual([429, BUSY]);
});

describe("an app without limits", () => {
  test("answers two hundred statistics requests in one minute, however long each takes", async () => {
    const selfDb = openDb(":memory:");
    const selfApp = createApp(selfDb, { teamForCode: singleTeamCodes(ensureSingleTeam(selfDb), () => INVITE), now: () => clock.t, stopwatch });
    const registered = await selfApp.request("/api/register", { method: "POST", body: JSON.stringify(goodReg()), headers: { "Content-Type": "application/json" } });
    const { token } = (await registered.json()) as { token: string };
    cost.ms = 60; // two hundred of them take 12,000 ms: twice a hosted team's minute
    for (let i = 0; i < 200; i++) {
      expect((await selfApp.request(`/api/stats?${RANGE}`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    }
  });
});
