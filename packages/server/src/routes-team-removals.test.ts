import { beforeEach, expect, test } from "vitest";
import { record } from "./app.fixture.js";
import { askForLink, heldUpload, machineIdOf, PUBLIC, settle } from "./hosted.fixture.js";
import { rowsOf } from "./hosted.two-teams.fixture.js";
import {
  asUser,
  codeRow,
  everythingOf,
  manageWorld,
  notGithubSessions,
  removeRoleRow,
  send,
  usageRowsOf,
  type ManagedTeam,
  type Who,
} from "./manage.fixture.js";
import { NEWCOMER, pacedWorld, registerAs, statsAs, uploadAs, type PacedWorld } from "./manage.requests.fixture.js";

let w: PacedWorld;
beforeEach(async () => {
  w = await pacedWorld();
});

const removalsPath = (team: ManagedTeam) => `/api/teams/${team.publicId}/removals`;
const removals = (who: Who, team: ManagedTeam, body: unknown) => asUser(w, who, removalsPath(team), { method: "POST", body });
const usageRowsOfMember = (teamId: number, memberId: number) => usageRowsOf(w.db, teamId, memberId);
const memberIds = (teamId: number) => rowsOf(w.db, teamId).members.map((m) => m.id);

test("the colleague who was laid off: removed with a new code, he is out everywhere and nobody else notices", async () => {
  const rowsA = rowsOf(w.db, w.A.id);
  const res = await removals("cyd", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: true });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as { removed: unknown; code: string };
  expect(body.removed).toEqual({ members: 1, machines: 2 });
  expect(body.code).toMatch(/^[a-f0-9]{24}$/);
  expect((await statsAs(w, w.B.sam.session)).status).toBe(401);                 // his browser
  expect((await uploadAs(w, w.B.sam.one.token, [record()])).status).toBe(401);  // his machine
  expect((await askForLink(w.app, w.B.sam.one.token)).status).toBe(401);
  expect((await registerAs(w, w.B.sam, w.B.code)).status).toBe(403);            // his client joining again with the code it holds
  expect((await statsAs(w, w.B.tia.session)).status).toBe(200);                 // a colleague's browser
  expect((await uploadAs(w, w.B.tia.one.token, [record()])).status).toBe(200);
  expect((await registerAs(w, NEWCOMER, body.code)).status).toBe(200);
  w.countIsRight();
  expect(rowsOf(w.db, w.A.id)).toEqual(rowsA);
});
test("without a new code the answer carries none and the code still joins", async () => {
  const res = await removals("bob", w.B, { members: [], machines: [w.B.sam.two.id], rotateCode: false });
  expect(await res.json()).toEqual({ removed: { members: 0, machines: 1 } });
  expect((await registerAs(w, NEWCOMER, w.B.code)).status).toBe(200);
  expect((await statsAs(w, w.B.sam.session)).status).toBe(200);         // opened from machine one, which stays
});
test("a new code is given whatever was removed, also when nothing the request names is the team's", async () => {
  const before = codeRow(w.db, w.B.id);
  const res = await removals("bob", w.B, { members: [], machines: [machineIdOf(0xfff)], rotateCode: true });
  const body = (await res.json()) as { removed: unknown; code: string };
  expect(body.removed).toEqual({ members: 0, machines: 0 });
  expect(codeRow(w.db, w.B.id)).not.toEqual(before);
  expect((await registerAs(w, NEWCOMER, body.code)).status).toBe(200);
});
test("a removal of more rows than a slice pauses between slices, with the count right and other teams answered at each pause", async () => {
  const seen: number[] = [];                                           // sam holds 7 rows: slices of 3, 3, 1
  w.pace.atPause = async () => {
    w.countIsRight();
    seen.push((await uploadAs(w, w.A.members[0]!.one.token, [record({ model: `during-${seen.length}` })])).status);
  };
  expect((await removals("bob", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: false })).status).toBe(200);
  expect(seen).toEqual([200, 200]);
});
test("what a machine being removed uploads at a pause goes with it", async () => {
  w.pace.atPause = async () => {
    w.pace.atPause = undefined;
    expect((await uploadAs(w, w.B.sam.two.token, [record({ model: "at-a-pause" })])).status).toBe(200);
  };
  expect((await removals("bob", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: false })).status).toBe(200);
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(0);
  w.countIsRight();
});
test("an admin whose role goes while their removal pauses removes nothing more", async () => {
  const codeBefore = codeRow(w.db, w.B.id);
  w.pace.atPause = async () => { w.pace.atPause = undefined; removeRoleRow(w, "cyd"); };
  const res = await removals("cyd", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: true });
  expect(res.status).toBe(404);
  expect(memberIds(w.B.id)).toContain(w.B.sam.memberId);
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(4);        // one slice of 3 ran
  w.countIsRight();
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
  expect(w.pace.pauses).toBeGreaterThanOrEqual(2);                      // each ran at least one full slice
  w.countIsRight();
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
  expect(w.pace.pauses).toBe(0);
});
test("no credential, a machine token and a member's session get 401; without the server's Origin 403; nothing is removed", async () => {
  const before = everythingOf(w.db, w.B.id);
  const removeSam = (headers: Record<string, string>) =>
    send(w, "POST", removalsPath(w.B), { members: [w.B.sam.memberId], machines: [], rotateCode: true }, headers);
  for (const headers of notGithubSessions(w)) {
    const res = await removeSam({ ...headers, Origin: PUBLIC });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }
  for (const origin of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
    const res = await removeSam({ ...origin, Cookie: w.cookies.bob });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "cross-site request refused" });
  }
  expect(everythingOf(w.db, w.B.id)).toEqual(before);
});

test("an upload held while its machine's member is removed is refused when its body arrives, and the count is right", async () => {
  const held = await heldUpload(w.app, w.B.sam.one.token, [record({ model: "late" })]);
  expect((await removals("bob", w.B, { members: [w.B.sam.memberId], machines: [], rotateCode: false })).status).toBe(200);
  held.finish();
  const res = await held.answer;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(usageRowsOfMember(w.B.id, w.B.sam.memberId)).toBe(0);
  w.countIsRight();
  expect(w.logged).toEqual([]);
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
