import { beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import * as selfHosted from "./app.harness.js";
import type { Db } from "./db.js";
import { hostedApp, hostedTeam, machineClient, mid, rowsOf, testLimits } from "./hosted.fixture.js";
import { TEAM_UPLOAD_RECORDS_PER_MINUTE, type TeamLimits } from "./team-limits.js";

// A team's machines share a budget of upload records a minute; here it is ten records, and each machine may upload twenty times.

const clock = { t: Date.parse("2026-11-25T10:30:00.000Z") };
let db: Db;
let app: Hono;
let code: string;
let one: string;
let two: string;

const caps = (over: Partial<TeamLimits> = {}): TeamLimits => ({
  membersPerTeam: 5, machinesPerMember: 5, rowsPerMachine: 1000, rowsPerTeam: 1000, rowsAddedPerDay: 1000, storageLow: () => false, ...over,
});
const { join, uploadRaw, upload } = machineClient(() => app, () => code);
const storedRows = () => db.prepare("select count(*) as n from usage").get();
const REFUSED = { error: "this team is sending too much at once; try again in a minute", limit: "team-uploads" };

async function server(team: Partial<TeamLimits> = {}, uploadsPerMinute = 20): Promise<void> {
  ({ db, app } = hostedApp({ limits: testLimits(caps(team), { uploadsPerMinute, teamUploadRecordsPerMinute: 10 }), now: () => clock.t }));
  code = hostedTeam(db, { githubId: 1, login: "ann" }, "code").code;
  one = await join({ machineId: mid(1) });
  two = await join({ machineId: mid(2) });
}
beforeEach(async () => {
  clock.t = Date.parse("2026-11-25T10:30:00.000Z");
  await server();
});

test("the request that takes a team past its budget is stored whole; the next is refused before its body is read", async () => {
  expect(await (await upload(one, rowsOf(6))).json()).toEqual({ stored: 6, kept: 0 });
  expect(await (await upload(two, rowsOf(6, 6))).json()).toEqual({ stored: 6, kept: 0 }); // 12 of 10: processed
  const refused = await uploadRaw(one, "{");
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual(REFUSED);
  expect(refused.headers.get("retry-after")).toBe("60");
  expect(refused.headers.get("cache-control")).toBe("no-store");
  expect(storedRows()).toEqual({ n: 12 });
  clock.t += 59_000;
  expect((await upload(two, rowsOf(1, 12))).status).toBe(429);
  clock.t += 1_000;
  expect((await upload(one, rowsOf(1, 12))).status).toBe(200);
});
test("the agreed value", () => expect(TEAM_UPLOAD_RECORDS_PER_MINUTE).toBe(60000));

describe("what counts for the team", () => {
  test("records that are kept count", async () => {
    await upload(one, rowsOf(5));
    const lower = rowsOf(5).map((r) => ({ ...r, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }));
    expect(await (await upload(one, lower)).json()).toEqual({ stored: 0, kept: 5 });
    expect(await (await upload(two, rowsOf(1, 5))).json()).toEqual(REFUSED);
  });
  test("a batch that a cap refuses counts", async () => {
    await server({ rowsPerMachine: 3 });
    expect((await upload(one, rowsOf(10))).status).toBe(409);
    expect(await (await upload(two, rowsOf(1))).json()).toEqual(REFUSED);
  });
  test("an empty batch and a body that is not valid count nothing", async () => {
    for (let i = 0; i < 3; i++) expect((await uploadRaw(one, "{")).status).toBe(400);
    for (let i = 0; i < 3; i++) await upload(one, []);
    expect((await upload(two, rowsOf(10))).status).toBe(200);
    expect(storedRows()).toEqual({ n: 10 });
  });
  test("a request with an unknown token is 401 and counts for no team", async () => {
    for (let i = 0; i < 3; i++) expect((await upload("nope", rowsOf(10))).status).toBe(401);
    expect((await upload(one, rowsOf(9))).status).toBe(200);
    expect((await upload(two, rowsOf(1, 9))).status).toBe(200);
  });
});

test("another team with the same machine id uploads while the first team is refused, and the refusal names nothing of it", async () => {
  await upload(one, rowsOf(10));
  const bob = hostedTeam(db, { githubId: 2, login: "bob" }, "code");
  const bobs = machineClient(() => app, () => bob.code);
  const bobsToken = await bobs.join({ machineId: mid(1), email: "bob@example.com" });
  const refused = await upload(two, rowsOf(1, 10));
  expect(await refused.json()).toEqual(REFUSED);
  expect((await bobs.upload(bobsToken, rowsOf(10))).status).toBe(200);
  expect(JSON.stringify(REFUSED)).not.toMatch(/bob/);
});

test("a team's refusal still uses up the machine's own minute", async () => {
  await server({}, 2);
  expect((await upload(one, rowsOf(10))).status).toBe(200);
  expect((await upload(one, rowsOf(1, 10))).status).toBe(429);
  expect(await (await upload(one, rowsOf(1, 10))).json()).toMatchObject({ limit: "uploads" });
});

describe("an app without limits", () => {
  selfHosted.useFreshApp();

  test("takes seventy batches of a thousand records in a minute", async () => {
    const { token } = await selfHosted.register();
    for (let i = 0; i < 70; i++) {
      const res = await selfHosted.post("/api/usage", { records: rowsOf(1000, i * 1000) }, selfHosted.bearer(token));
      expect(res.status).toBe(200);
    }
  }, 30_000);
});
