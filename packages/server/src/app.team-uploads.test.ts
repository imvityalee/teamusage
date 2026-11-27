import { beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import * as selfHosted from "./app.harness.js";
import type { Db } from "./db.js";
import { heldRequest, hostedApp, hostedTeam, machineClient, machineIdOf, recordsOf, settle, testCaps, testLimits } from "./hosted.fixture.js";
import { forTeam } from "./team-data.js";
import { TEAM_UPLOAD_RECORDS_PER_MINUTE, type TeamLimits } from "./team-limits.js";

// A team's machines share a budget of upload records a minute; here it is ten records, and each machine may upload twenty times.

const clock = { t: Date.parse("2026-11-25T10:30:00.000Z") };
let db: Db;
let app: Hono;
let code: string;
let teamId: number;
let one: string;
let two: string;
let logged: string[];
const machineIdOfTwo = machineIdOf(2);

const { join, uploadRaw, upload } = machineClient(() => app, () => code);
const storedRows = () => db.prepare("select count(*) as n from usage").get();
const REFUSED = { error: "this team is sending too much at once; try again in a minute", limit: "team-uploads" };

async function server(team: Partial<TeamLimits> = {}, uploadsPerMinute = 20): Promise<void> {
  logged = [];
  const logError = (line: string) => logged.push(line);
  ({ db, app } = hostedApp({ limits: testLimits(testCaps(team), { uploadsPerMinute, teamUploadRecordsPerMinute: 10 }), now: () => clock.t, logError }));
  ({ code, team: { id: teamId } } = hostedTeam(db, { githubId: 1, login: "ann" }, "members"));
  one = await join({ machineId: machineIdOf(1) });
  two = await join({ machineId: machineIdOfTwo });
}
beforeEach(async () => {
  clock.t = Date.parse("2026-11-25T10:30:00.000Z");
  await server();
});

test("the request that takes a team past its budget is stored whole; the next is refused before its body is read", async () => {
  expect(await (await upload(one, recordsOf(6))).json()).toEqual({ stored: 6, kept: 0 });
  expect(await (await upload(two, recordsOf(6, 6))).json()).toEqual({ stored: 6, kept: 0 }); // 12 of 10: processed
  const refused = await uploadRaw(one, "{");
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual(REFUSED);
  expect(refused.headers.get("retry-after")).toBe("60");
  expect(refused.headers.get("cache-control")).toBe("no-store");
  expect(storedRows()).toEqual({ n: 12 });
  clock.t += 59_000;
  expect((await upload(two, recordsOf(1, 12))).status).toBe(429);
  clock.t += 1_000;
  expect((await upload(one, recordsOf(1, 12))).status).toBe(200);
});
test("uploads of a team that are open together: only those up to the crossing are stored, the rest are refused whole", async () => {
  const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => upload(i % 2 === 0 ? one : two, recordsOf(6, i * 6))));
  const refusals = answers.filter((res) => res.status !== 200);
  expect(answers.length - refusals.length).toBe(2);
  expect(refusals.map((res) => [res.status, res.headers.get("retry-after")])).toEqual(Array(38).fill([429, "60"]));
  expect(await Promise.all(refusals.map((res) => res.json()))).toEqual(Array(38).fill(REFUSED));
  expect(storedRows()).toEqual({ n: 12 });
});
test("the agreed value", () => expect(TEAM_UPLOAD_RECORDS_PER_MINUTE).toBe(60000));

/** Sends an upload of `records` as the machine `token` and holds it while the handler waits for its body. */
async function heldUpload(token: string, records: unknown[]) {
  const held = heldRequest(app, "/api/usage", { method: "POST", text: JSON.stringify({ records }), headers: { Authorization: `Bearer ${token}` } });
  await settle();                                                     // the handler now waits for the body
  return held;
}

test("an upload whose machine is removed while its body is read is refused, stores nothing and logs no error", async () => {
  const held = await heldUpload(two, recordsOf(2));
  forTeam(db, teamId).removeMachine(machineIdOfTwo);
  held.finish();
  const res = await held.answer;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(storedRows()).toEqual({ n: 0 });
  expect(logged).toEqual([]);                                         // today: a 500 and "SqliteError SQLITE_CONSTRAINT_FOREIGNKEY"
});
test("an upload refused because its machine went while its body was read counts nothing against the team's budget", async () => {
  const held = await heldUpload(two, recordsOf(10));
  forTeam(db, teamId).removeMachine(machineIdOfTwo);
  held.finish();
  expect((await held.answer).status).toBe(401);
  expect(await (await upload(one, recordsOf(10))).json()).toEqual({ stored: 10, kept: 0 }); // the whole budget is still there
});
test("an upload whose machine registered again while its body was read is refused: its token is no longer the machine's", async () => {
  const held = await heldUpload(two, recordsOf(2));
  const fresh = await join({ machineId: machineIdOfTwo });
  held.finish();
  expect((await held.answer).status).toBe(401);
  expect(storedRows()).toEqual({ n: 0 });
  expect((await upload(fresh, recordsOf(2))).status).toBe(200);
});

describe("what counts for the team", () => {
  test("records that are kept count", async () => {
    await upload(one, recordsOf(5));
    const lower = recordsOf(5).map((r) => ({ ...r, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }));
    expect(await (await upload(one, lower)).json()).toEqual({ stored: 0, kept: 5 });
    expect(await (await upload(two, recordsOf(1, 5))).json()).toEqual(REFUSED);
  });
  test("a batch that a cap refuses counts", async () => {
    await server({ rowsPerMachine: 3 });
    expect((await upload(one, recordsOf(10))).status).toBe(409);
    expect(await (await upload(two, recordsOf(1))).json()).toEqual(REFUSED);
  });
  test("an empty batch, a body that is not JSON and a batch that fails validation count nothing", async () => {
    for (let i = 0; i < 3; i++) expect((await uploadRaw(one, "{")).status).toBe(400);
    for (let i = 0; i < 3; i++) await upload(one, []);
    const oneBad = recordsOf(5).map((r, i) => (i === 2 ? { ...r, total: 99 } : r));
    for (let i = 0; i < 3; i++) expect((await upload(one, oneBad)).status).toBe(400);
    expect((await upload(two, recordsOf(9))).status).toBe(200);
    expect((await upload(two, recordsOf(1, 9))).status).toBe(200); // the team is at 9 of 10 only if nothing above counted
    expect(await (await upload(two, recordsOf(1, 10))).json()).toEqual(REFUSED);
    expect(storedRows()).toEqual({ n: 10 });
  });
  test("an empty batch does not start the team's minute: it starts at the first record counted", async () => {
    await upload(one, []);
    clock.t += 30_000;
    expect((await upload(two, recordsOf(10))).status).toBe(200);
    clock.t += 30_000;
    const refused = await upload(one, recordsOf(1, 10));
    expect(await refused.json()).toEqual(REFUSED);
    expect(refused.headers.get("retry-after")).toBe("30");
  });
  test("a request with an unknown token is 401 and counts for no team", async () => {
    for (let i = 0; i < 3; i++) expect((await upload("nope", recordsOf(10))).status).toBe(401);
    expect((await upload(one, recordsOf(9))).status).toBe(200);
    expect((await upload(two, recordsOf(1, 9))).status).toBe(200);
  });
});

test("another team with the same machine id uploads while the first team is refused, and the refusal names nothing of it", async () => {
  await upload(one, recordsOf(10));
  const bob = hostedTeam(db, { githubId: 2, login: "bob" }, "members");
  const bobs = machineClient(() => app, () => bob.code);
  const bobsToken = await bobs.join({ machineId: machineIdOf(1), email: "bob@example.com", name: "Quillfeather Bobby" });
  const refused = await upload(two, recordsOf(1, 10));
  const answer = (await refused.json()) as { error: string };
  expect(answer).toEqual(REFUSED);
  expect((await bobs.upload(bobsToken, recordsOf(10))).status).toBe(200);
  for (const identifying of ["bob", "Quillfeather", "example.com"]) expect(answer.error.toLowerCase()).not.toContain(identifying.toLowerCase());
});

test("a team's refusal still uses up the machine's own minute", async () => {
  await server({}, 2);
  expect((await upload(one, recordsOf(10))).status).toBe(200);
  expect((await upload(one, recordsOf(1, 10))).status).toBe(429);
  expect(await (await upload(one, recordsOf(1, 10))).json()).toMatchObject({ limit: "uploads" });
});

describe("an app without limits", () => {
  selfHosted.useFreshApp();

  test("takes seventy batches of a thousand records in a minute", async () => {
    const { token } = await selfHosted.register();
    for (let i = 0; i < 70; i++) {
      const res = await selfHosted.post("/api/usage", { records: recordsOf(1000, i * 1000) }, selfHosted.bearer(token));
      expect(res.status).toBe(200);
    }
  }, 30_000);
});
