import { beforeEach, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import { heldRequest, machineIdOf, postFromPage, PUBLIC, settle } from "./hosted.fixture.js";
import { rowsOf } from "./hosted.two-teams.fixture.js";
import {
  asUser,
  codeRow,
  everythingOf,
  manageWorld,
  RANGE,
  removeRoleRow,
  T0,
  usageRowsOf,
  type ManagedTeam,
  type ManageWorld,
  type Who,
} from "./manage.fixture.js";
import { usageCounts } from "./usage-counts.js";

const TODAY = T0.slice(0, 10);

let w: ManageWorld;
/** What the next pause of a removal runs; a test sets it. */
let atPause: (() => Promise<void>) | undefined;
let pauses: number;
let logged: string[];
const pause = async () => {
  pauses++;
  await atPause?.();
};
beforeEach(async () => {
  atPause = undefined;
  pauses = 0;
  logged = [];
  w = await manageWorld({ removal: { sliceRows: 3, pause }, logError: (line) => logged.push(line) });
});

type Joiner = { name: string; email: string; one: { id: string; label: string } };
/** Someone who never joined `B`. */
const newcomer: Joiner = { name: "Uma", email: "uma@example.com", one: { id: machineIdOf(0xc1), label: "uma-laptop" } };

const removalsPath = (team: ManagedTeam) => `/api/teams/${team.publicId}/removals`;
const removals = (who: Who, team: ManagedTeam, body: unknown) => asUser(w, who, removalsPath(team), { method: "POST", body });
const stats = (session: string) => w.app.request(`/api/stats?${RANGE}`, { headers: { Cookie: session } });
const upload = (token: string, records: unknown[]) => postFromPage(w.app, "/api/usage", { records }, { Authorization: `Bearer ${token}` });
const link = (token: string) => w.app.request("/api/dashboard-link", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
/** Registers `who`'s machine `one` with `code`, as their installed client does when it joins. */
const registerAs = (who: Joiner, code: string) =>
  postFromPage(w.app, "/api/register", goodReg({ inviteCode: code, name: who.name, email: who.email, machineId: who.one.id, machineLabel: who.one.label }));
const usageRows = (teamId: number) => usageRowsOf(w.db, teamId);
const usageRowsOfMember = (teamId: number, memberId: number) => usageRowsOf(w.db, teamId, memberId);
const memberIds = (teamId: number) => rowsOf(w.db, teamId).members.map((m) => m.id);
const countIsRight = () => expect(usageCounts(w.db, w.B.id, TODAY).rows).toBe(usageRows(w.B.id));

test("the colleague who was laid off: removed with a new code, he is out everywhere and nobody else notices", async () => {
  const rowsA = rowsOf(w.db, w.A.id);
  const res = await removals("cyd", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: true });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { removed: unknown; code: string };
  expect(body.removed).toEqual({ members: 1, machines: 2 });
  expect(body.code).toMatch(/^[a-f0-9]{24}$/);
  expect((await stats(w.B.sam.session)).status).toBe(401);            // his browser
  expect((await upload(w.B.sam.one.token, [record()])).status).toBe(401);   // his machine
  expect((await link(w.B.sam.one.token)).status).toBe(401);
  expect((await registerAs(w.B.sam, w.B.code)).status).toBe(403);     // his client joining again with the code it holds
  expect((await stats(w.B.tia.session)).status).toBe(200);            // a colleague's browser
  expect((await upload(w.B.tia.one.token, [record()])).status).toBe(200);
  expect((await registerAs(newcomer, body.code)).status).toBe(200);
  expect(usageCounts(w.db, w.B.id, TODAY).rows).toBe(usageRows(w.B.id));
  expect(rowsOf(w.db, w.A.id)).toEqual(rowsA);
});
test("without a new code the answer carries none and the code still joins", async () => {
  const res = await removals("bob", w.B, { members: [], machines: [w.B.sam.two.id], rotateCode: false });
  expect(await res.json()).toEqual({ removed: { members: 0, machines: 1 } });
  expect((await registerAs(newcomer, w.B.code)).status).toBe(200);
  expect((await stats(w.B.sam.session)).status).toBe(200);            // opened from machine one, which stays
});
test("a new code is given whatever was removed, also when nothing the request names is the team's", async () => {
  const before = codeRow(w.db, w.B.id);
  const res = await removals("bob", w.B, { members: [], machines: [machineIdOf(0xfff)], rotateCode: true });
  const body = (await res.json()) as { removed: unknown; code: string };
  expect(body.removed).toEqual({ members: 0, machines: 0 });
  expect(codeRow(w.db, w.B.id)).not.toEqual(before);
  expect((await registerAs(newcomer, body.code)).status).toBe(200);
});
test("a removal of more rows than a slice pauses between slices, with the count right and other teams answered at each pause", async () => {
  const seen: number[] = [];                                           // sam holds 7 rows: slices of 3, 3, 1
  atPause = async () => {
    expect(usageCounts(w.db, w.B.id, TODAY).rows).toBe(usageRows(w.B.id));
    seen.push((await upload(w.A.members[0]!.one.token, [record({ model: `during-${seen.length}` })])).status);
  };
  expect((await removals("bob", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: false })).status).toBe(200);
  expect(seen).toEqual([200, 200]);
});
test("what a machine being removed uploads at a pause goes with it", async () => {
  atPause = async () => {
    atPause = undefined;
    expect((await upload(w.B.sam.two.token, [record({ model: "at-a-pause" })])).status).toBe(200);
  };
  expect((await removals("bob", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: false })).status).toBe(200);
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(0);
  countIsRight();
});
test("an admin whose role goes while their removal pauses removes nothing more", async () => {
  const codeBefore = codeRow(w.db, w.B.id);
  atPause = async () => { atPause = undefined; removeRoleRow(w, "cyd"); };
  const res = await removals("cyd", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: true });
  expect(res.status).toBe(404);
  expect(memberIds(w.B.id)).toContain(w.B.sam.memberId);
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(4);        // one slice of 3 ran
  expect(usageCounts(w.db, w.B.id, TODAY).rows).toBe(usageRows(w.B.id));
  expect(codeRow(w.db, w.B.id)).toEqual(codeBefore);                  // not rotated; read before the request
});

test("every refused body is 400 and removes nothing; 500 ids of each are accepted", async () => {
  const before = everythingOf(w.db, w.B.id);
  const many = (n: number) => Array.from({ length: n }, (_, i) => machineIdOf(0x1000 + i));
  const memberRun = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i);
  const refused: [unknown, string][] = [
    [{ members: memberRun(501), machines: [], rotateCode: false }, "invalid members"],
    [{ members: [...memberRun(500), 1000], machines: [], rotateCode: false }, "invalid members"], // 501 as sent, one a repeat
    [{ members: [], machines: many(501), rotateCode: false }, "invalid machines"],
    [{ members: [], machines: [...many(500), machineIdOf(0x1000)], rotateCode: false }, "invalid machines"],
    ...[0, -1, 1.5, "6", null, 2 ** 53].map((id): [unknown, string] => [{ members: [id], machines: [], rotateCode: false }, "invalid members"]),
    [{ members: 6, machines: [], rotateCode: false }, "invalid members"],
    [{ machines: [w.B.sam.two.id], rotateCode: false }, "invalid members"],
    ...["B".repeat(32), "b".repeat(31), "b".repeat(33), 7, null].map((id): [unknown, string] => [{ members: [], machines: [id], rotateCode: false }, "invalid machines"]),
    [{ members: [w.B.sam.memberId], rotateCode: false }, "invalid machines"],
    [{ members: [w.B.sam.memberId], machines: [] }, "invalid rotateCode"],
    [{ members: [w.B.sam.memberId], machines: [], rotateCode: "true" }, "invalid rotateCode"],
    [{ members: [], machines: [], rotateCode: true }, "nothing to remove"],
    ["{not json", "invalid JSON body"],
    ["[]", "body must be an object"],
  ];
  for (const [body, error] of refused) {
    const res = await removals("bob", w.B, body);
    expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect(await res.json()).toEqual({ error });
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
  const res = await removals("bob", w.B, { members: [w.B.sam.memberId, ...memberRun(499)], machines: [w.B.tia.one.id, ...many(499)], rotateCode: false });
  expect(await res.json()).toEqual({ removed: { members: 1, machines: 3 } });
});
test("an id named twice is removed and counted once", async () => {
  const twice = { members: [w.B.sam.memberId, w.B.sam.memberId], machines: [w.B.tia.one.id, w.B.tia.one.id], rotateCode: false };
  expect(await (await removals("bob", w.B, twice)).json()).toEqual({ removed: { members: 1, machines: 3 } });
  expect(memberIds(w.B.id)).toEqual([w.B.tia.memberId]);
});
test("ids of team A in B's request: B's machine goes, A's rows are as they were, and the answer counts only B's", async () => {
  const a = everythingOf(w.db, w.A.id);
  const first = w.A.members[0]!;                                       // Sam's email, and the id of Sam's machine `one`
  const res = await removals("cyd", w.B, { members: [first.memberId], machines: [first.one.id], rotateCode: false });
  expect(await res.json()).toEqual({ removed: { members: 0, machines: 1 } });
  expect(rowsOf(w.db, w.B.id).machines.map((m) => m.id)).toEqual([w.B.tia.one.id, w.B.sam.two.id]);
  expect(memberIds(w.B.id)).toEqual([w.B.sam.memberId, w.B.tia.memberId]);
  expect(everythingOf(w.db, w.A.id)).toEqual(a);
});
test("two removals of sam open together: one reports him, the other nothing, and the count is right", async () => {
  const what = { members: [w.B.sam.memberId], machines: [], rotateCode: false };
  const answers = await Promise.all([removals("bob", w.B, what), removals("cyd", w.B, what)]);
  const removed = await Promise.all(answers.map(async (res) => ((await res.json()) as { removed: { members: number } }).removed));
  expect(removed.sort((x, y) => y.members - x.members)).toEqual([{ members: 1, machines: 2 }, { members: 0, machines: 0 }]);
  expect(pauses).toBeGreaterThanOrEqual(2);                            // each ran at least one full slice
  countIsRight();
});

test("a viewer gets 403, and a user with no role in the team the 404 of a team that does not exist; nothing is removed", async () => {
  const before = [everythingOf(w.db, w.B.id), everythingOf(w.db, w.A.id)];
  const what = { members: [w.B.sam.memberId], machines: [w.B.tia.one.id], rotateCode: true };
  const viewer = await removals("dee", w.B, what);
  expect(viewer.status).toBe(403);
  expect(await viewer.json()).toEqual({ error: "your role does not allow this" });
  for (const who of ["ann", "zoe", "eve"] as const) {
    const res = await removals(who, w.B, what);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "team not found" });
  }
  expect([everythingOf(w.db, w.B.id), everythingOf(w.db, w.A.id)]).toEqual(before);
  expect(pauses).toBe(0);
});
test("no credential, a machine token and a member's session get 401; without the server's Origin 403; nothing is removed", async () => {
  const before = everythingOf(w.db, w.B.id);
  const send = (headers: Record<string, string>) =>
    w.app.request(removalsPath(w.B), {
      method: "POST",
      body: JSON.stringify({ members: [w.B.sam.memberId], machines: [], rotateCode: true }),
      headers: { "Content-Type": "application/json", ...headers },
    });
  const credentials: Record<string, string>[] = [{}, { Authorization: `Bearer ${w.B.sam.one.token}` }, { Cookie: w.B.sam.session }];
  for (const headers of credentials) {
    const res = await send({ ...headers, Origin: PUBLIC });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }
  for (const origin of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
    const res = await send({ ...origin, Cookie: w.cookies.bob });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "cross-site request refused" });
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
});

test("an upload held while its machine's member is removed is refused when its body arrives, and the count is right", async () => {
  const held = heldRequest(w.app, "/api/usage", {
    method: "POST",
    text: JSON.stringify({ records: [record({ model: "late" })] }),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${w.B.sam.one.token}` },
  });
  await settle();                                                     // the upload now waits for its body
  expect((await removals("bob", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: false })).status).toBe(200);
  held.finish();
  const res = await held.answer;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(0);
  countIsRight();
  expect(logged).toEqual([]);
});

test("at the default pace a member is removed in one slice", async () => {
  const v = await manageWorld();
  const res = await asUser(v, "bob", removalsPath(v.B), { method: "POST", body: { members: [v.B.sam.memberId], machines: [], rotateCode: false } });
  expect(await res.json()).toEqual({ removed: { members: 1, machines: 2 } });
  expect(usageRowsOf(v.db, v.B.id)).toBe(2);
});
test("the default pause lets other requests in: one sent while a removal runs is answered before it", async () => {
  const v = await manageWorld({ removal: { sliceRows: 1 } });         // sam's 7 rows take 7 slices
  const answered: string[] = [];
  const removal = asUser(v, "bob", removalsPath(v.B), { method: "POST", body: { members: [v.B.sam.memberId], machines: [], rotateCode: false } });
  void removal.then(() => answered.push("removal"));
  while (usageRowsOf(v.db, v.B.id, v.B.sam.memberId) === 7 && answered.length === 0) await settle(); // until its first slice has run
  const other = await asUser(v, "dee", `/api/teams/${v.B.publicId}`);
  answered.push("other");
  expect(other.status).toBe(200);
  expect(await (await removal).json()).toEqual({ removed: { members: 1, machines: 2 } });
  expect(answered).toEqual(["other", "removal"]);
});
