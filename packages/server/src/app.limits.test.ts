import { beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import { record } from "./app.fixture.js";
import * as selfHosted from "./app.harness.js";
import type { Db } from "./db.js";
import { hostedApp, hostedTeam, machineClient, mid, rowsOf, signIn, testLimits } from "./hosted.fixture.js";
import { limitAnswer, secondsToUtcMidnight, type RefusedLimit } from "./limit-answers.js";
import { teamTables } from "./team-data.fixture.js";
import { HOSTED_CAPS, UPLOADS_PER_MINUTE, type LimitName, type TeamLimits } from "./team-limits.js";

const clock = { t: Date.parse("2026-11-25T10:30:00.000Z") };
let db: Db;
let app: Hono;
let code: string;
let low: boolean;

const caps = (over: Partial<TeamLimits> = {}): TeamLimits => ({
  membersPerTeam: 2, machinesPerMember: 2, rowsPerMachine: 5, rowsPerTeam: 100, rowsAddedPerDay: 100, storageLow: () => low, ...over,
});
function server(over: Partial<TeamLimits> = {}): void {
  ({ db, app } = hostedApp({ limits: testLimits(caps(over)), now: () => clock.t }));
  code = hostedTeam(db, { githubId: 1, login: "ann" }, "code").code;
}
beforeEach(() => {
  clock.t = Date.parse("2026-11-25T10:30:00.000Z");
  low = false;
  server();
});

const { post, register, join, uploadRaw, upload } = machineClient(() => app, () => code);
const storedRows = () => db.prepare("select count(*) as n from usage").get();

/** Brings a team to the edge of `limit` through HTTP and returns the request the limit refuses, not yet sent. */
async function approach(limit: string): Promise<() => Promise<Response>> {
  if (limit === "team-rows") server({ rowsPerTeam: 7 });
  if (limit === "team-rows-per-day") server({ rowsAddedPerDay: 6, rowsPerMachine: 100 });
  const first = await join({ machineId: mid(1) });
  switch (limit) {
    case "members":
      await join({ machineId: mid(2), email: "bob@example.com" });
      return () => register({ machineId: mid(3), email: "cy@example.com" });
    case "machines":
      await join({ machineId: mid(2) });
      return () => register({ machineId: mid(3) });
    case "machine-rows":
      await upload(first, rowsOf(5));
      return () => upload(first, rowsOf(1, 5));
    case "team-rows": {
      await upload(first, rowsOf(5));
      const second = await join({ machineId: mid(2) });
      await upload(second, rowsOf(2));
      return () => upload(second, rowsOf(1, 2));
    }
    case "team-rows-per-day":
      await upload(first, rowsOf(6));
      return () => upload(first, rowsOf(1, 6));
    default:
      low = true;
      return () => upload(first, rowsOf(1));
  }
}

/** Brings a team to `limit` through HTTP and returns the response the limit refuses. */
const reach = async (limit: string): Promise<Response> => (await approach(limit))();

test.each([
  ["members", 409, "this team has reached its limit of 2 members"],
  ["machines", 409, "this member has reached the limit of 2 machines"],
  ["machine-rows", 409, "this machine has reached its limit of 5 usage rows"],
  ["team-rows", 409, "this team has reached its limit of 7 usage rows"],
  ["team-rows-per-day", 429, "this team has added too many usage rows today; try again tomorrow"],
  ["storage", 507, "the server is not accepting new data right now; try again later"],
])("%s answers %i with its text and its name", async (limit, status, error) => {
  const res = await reach(limit);
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error, limit });
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("retry-after")).toBe(limit === "team-rows-per-day" ? "48600" : null); // 13 h 30 min to midnight
});

const limitNames: LimitName[] = ["members", "machines", "machine-rows", "team-rows", "team-rows-per-day", "storage"];
test.each(limitNames)("a request refused by %s changes no stored row", async (limit) => {
  const refused = await approach(limit);
  const before = teamTables(db);
  await refused();
  expect(teamTables(db)).toEqual(before);
});

test("a machine uploads three times a minute; the fourth is refused before its body is read, and nothing is lost", async () => {
  const token = await join();
  for (let i = 0; i < 3; i++) expect((await upload(token, [record({ model: `m${i}` })])).status).toBe(200);
  const refused = await uploadRaw(token, "{");
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({ error: "too many uploads; try again in a minute", limit: "uploads" });
  expect(refused.headers.get("retry-after")).toBe("60");
  expect(storedRows()).toEqual({ n: 3 });
  clock.t += 59_000;
  expect((await upload(token, [record({ model: "m3" })])).status).toBe(429);
  clock.t += 1_000;
  expect((await upload(token, [record({ model: "m3" })])).status).toBe(200);
});

test("a first sync of more requests than a minute allows keeps what was sent and ends with every row stored", async () => {
  server({ rowsPerMachine: 100 });
  const token = await join();
  const requests = Array.from({ length: 5 }, (_, i) => rowsOf(2, i * 2));
  const statuses: number[] = [];
  for (const records of requests) statuses.push((await upload(token, records)).status);
  expect(statuses).toEqual([200, 200, 200, 429, 429]);
  expect(storedRows()).toEqual({ n: 6 });
  const refused = await upload(token, requests[3] as unknown[]);
  expect(refused.headers.get("retry-after")).toBe("60");
  clock.t += 60_000;
  for (const records of requests.slice(3)) expect((await upload(token, records)).status).toBe(200);
  expect(storedRows()).toEqual({ n: 10 });
});

describe("the answers' texts", () => {
  const refusable: RefusedLimit[] = ["members", "machines", "machine-rows", "team-rows", "team-rows-per-day", "storage", "uploads", "team-uploads"];
  const hosted: TeamLimits = { ...HOSTED_CAPS, storageLow: () => false };
  /** The answer to `limit` with the hosted values, from a route that sets no header of its own. */
  const answerOf = async (limit: RefusedLimit): Promise<Response> => {
    const probe = hostedApp().app;
    probe.get("/probe", (c) => limitAnswer(c, limit, hosted));
    return probe.request("/probe");
  };

  test.each(refusable)("%s is at most 200 characters with the hosted values, and no cache stores it", async (limit) => {
    const res = await answerOf(limit);
    const { error } = (await res.json()) as { error: string };
    expect(error.length).toBeLessThanOrEqual(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  test.each([
    ["members", "this team has reached its limit of 2000 members"],
    ["machines", "this member has reached the limit of 10 machines"],
    ["machine-rows", "this machine has reached its limit of 20000 usage rows"],
    ["team-rows", "this team has reached its limit of 1000000 usage rows"],
  ] as const)("the hosted value of %s is named in its text", async (limit, error) => {
    expect(await (await answerOf(limit)).json()).toMatchObject({ error });
  });
  test("a machine may upload thirty times a minute", () => {
    expect(UPLOADS_PER_MINUTE).toBe(30);
  });
});

describe("the minute of uploads", () => {
  test("an upload refused for another reason still counts", async () => {
    const token = await join();
    for (let i = 0; i < 3; i++) expect((await uploadRaw(token, "{")).status).toBe(400);
    expect((await upload(token, rowsOf(1))).status).toBe(429);
  });
  test("an upload refused by a limit still counts", async () => {
    server({ rowsPerMachine: 1 });
    const token = await join();
    await upload(token, rowsOf(1));
    for (let i = 0; i < 2; i++) expect((await upload(token, rowsOf(1, 1))).status).toBe(409);
    expect((await upload(token, rowsOf(1))).status).toBe(429);
  });
  test("an unknown token is 401 however often it comes, and does not use up a machine's minute", async () => {
    const token = await join();
    for (let i = 0; i < 4; i++) expect((await uploadRaw("nope", "{")).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await upload(token, rowsOf(1, i))).status).toBe(200);
  });
  test("registering the machine again does not reset its minute; a second machine has its own", async () => {
    const token = await join();
    for (let i = 0; i < 3; i++) await upload(token, rowsOf(1, i));
    const again = await join();
    expect((await upload(again, rowsOf(1, 3))).status).toBe(429);
    const other = await join({ machineId: mid(2) });
    expect((await upload(other, rowsOf(1, 3))).status).toBe(200);
  });
  test("the same laptop in two teams has two allowances", async () => {
    const token = await join();
    for (let i = 0; i < 3; i++) await upload(token, rowsOf(1, i));
    const bob = hostedTeam(db, { githubId: 2, login: "bob" }, "code");
    const joined = await register({ inviteCode: bob.code, email: "bob@example.com" });
    const { token: bobsToken } = (await joined.json()) as { token: string };
    expect((await upload(bobsToken, rowsOf(1))).status).toBe(200);
  });
});

describe("an app without limits", () => {
  selfHosted.useFreshApp();

  test("takes forty uploads in a minute", async () => {
    const { token } = await selfHosted.register();
    for (let i = 0; i < 40; i++) {
      const res = await selfHosted.post("/api/usage", { records: rowsOf(1, i) }, selfHosted.bearer(token));
      expect(res.status).toBe(200);
    }
  });
});

describe("a refusal is not a failed attempt", () => {
  test("twelve registrations refused by the member cap, then a wrong code: 403, not 429", async () => {
    await join({ machineId: mid(1) });
    await join({ machineId: mid(2), email: "bob@example.com" });
    for (let i = 0; i < 12; i++) expect((await register({ machineId: mid(3), email: `x${i}@example.com` })).status).toBe(409);
    expect((await register({ inviteCode: "0".repeat(24) })).status).toBe(403);
  });
});

describe("sign-ups on a nearly full volume", () => {
  const createTeam = (cookie: string, body: unknown) => post("/api/teams", body, { Cookie: cookie });
  const teamCount = () => db.prepare("select count(*) as n from teams").get();

  test("are paused with the server's own answer, and no team is created", async () => {
    const cookie = await signIn(app, "code-bob");
    low = true;
    const res = await createTeam(cookie, { name: "Bobs", dashboardAccess: "code" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "sign-ups are paused" });
    expect(teamCount()).toEqual({ n: 1 });
  });
  test("a bad name is still 400", async () => {
    const cookie = await signIn(app, "code-bob");
    low = true;
    const res = await createTeam(cookie, { name: "", dashboardAccess: "code" });
    expect([res.status, await res.json()]).toEqual([400, { error: "invalid name" }]);
  });
  test("a team is created while the volume has room", async () => {
    const cookie = await signIn(app, "code-bob");
    expect((await createTeam(cookie, { name: "Bobs", dashboardAccess: "code" })).status).toBe(201);
  });
});

test("secondsToUtcMidnight counts to the next UTC midnight, at least one second", () => {
  expect(secondsToUtcMidnight(Date.parse("2026-11-25T23:59:59.500Z"))).toBe(1);
  expect(secondsToUtcMidnight(Date.parse("2026-11-26T00:00:00.000Z"))).toBe(86400);
});
