import { beforeEach, expect, test } from "vitest";
import { goodReg } from "./app.fixture.js";
import { postFromPage } from "./hosted.fixture.js";
import { CALLERS, routeNamed, statusOf } from "./hosted.isolation.manage.fixture.js";
import { asUser, DAY_MS, everythingOf, expectAnswer, manageWorld, newInvite, roleRows, send, type ManageWorld } from "./manage.fixture.js";

const PREVIEW = "/api/invites/preview";
const ACCEPT = "/api/invites/accept";
const NO_LONGER_VALID = "this invite is no longer valid";
/** More unknown tokens than the failed-attempt limit (10 a minute) allows. */
const MORE_THAN_THE_LIMIT = 25;

let w: ManageWorld;
let logged: string[];
beforeEach(async () => {
  logged = [];
  w = await manageWorld({ logError: (line) => logged.push(line) });
});

const preview = (token: string) => postFromPage(w.app, PREVIEW, { token });
const accept = (token: string) => asUser(w, "eve", ACCEPT, { method: "POST", body: { token } });
const bothTeams = () => ({ A: everythingOf(w.db, w.A.id), B: everythingOf(w.db, w.B.id) });
/** An answer as what must be equal between two refusals: status, every header and the body. */
const shapeOf = async (res: Response) => [res.status, [...res.headers], await res.text()] as const;

test("whoever holds the link sees the team's name, the role and the day it ends, and nothing else", async () => {
  const { invite, token } = await newInvite(w, "bob", w.B, "viewer");
  const res = await preview(token);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ team: { name: w.B.name }, role: "viewer", expiresAt: invite.expiresAt });
});

test("a preview changes nothing: the invite is then accepted", async () => {
  const { token } = await newInvite(w, "bob", w.B, "admin");
  const before = bothTeams();
  for (let i = 0; i < 3; i++) await preview(token);
  expect(bothTeams()).toEqual(before);
  expect((await accept(token)).status).toBe(200);
});

test("an unknown token counts no attempt: after more of them than the limit allows, a wrong team code is 403 and not 429", async () => {
  for (let i = 0; i < MORE_THAN_THE_LIMIT; i++) await expectAnswer(await preview(String(i).padStart(64, "0")), 404, NO_LONGER_VALID);
  const wrongCode = await postFromPage(w.app, "/api/register", goodReg({ inviteCode: "wrong-code" }));
  expect(wrongCode.status).toBe(403);
  expect(await wrongCode.json()).toEqual({ error: "invalid invite code" });
});

test("an accepted invite, a cancelled one, one seven days old and a token nobody made are the same 404 in status, headers and body", async () => {
  const accepted = await newInvite(w, "bob", w.B, "viewer");
  const cancelled = await newInvite(w, "bob", w.B, "viewer");
  const old = await newInvite(w, "bob", w.B, "viewer");
  expect((await accept(accepted.token)).status).toBe(200);
  expect((await asUser(w, "bob", `/api/teams/${w.B.publicId}/invites/${cancelled.invite.id}`, { method: "DELETE" })).status).toBe(204);
  const gone = await Promise.all([accepted.token, cancelled.token, "ab".repeat(32)].map(async (t) => shapeOf(await preview(t))));
  w.clock.t += 7 * DAY_MS;                                            // only now is the third invite past its seven days
  const answers = [gone[0]!, gone[1]!, await shapeOf(await preview(old.token)), gone[2]!];
  expect(answers[0]).toEqual([404, expect.anything(), JSON.stringify({ error: NO_LONGER_VALID })]);
  for (const answer of answers) expect(answer).toEqual(answers[0]);
  expect(answers[0]![1]).toContainEqual(["cache-control", "no-store"]);
});

test("one millisecond before the invite ends a preview is 200, and at the moment it ends it is 404, as an accept is", async () => {
  const before = await newInvite(w, "bob", w.B, "viewer");
  const at = await newInvite(w, "bob", w.B, "viewer");
  const ends = Date.parse(before.invite.expiresAt);
  w.clock.t = ends - 1;
  expect((await preview(before.token)).status).toBe(200);
  expect((await accept(before.token)).status).toBe(200);
  w.clock.t = ends;
  await expectAnswer(await preview(at.token), 404, NO_LONGER_VALID);
  await expectAnswer(await accept(at.token), 404, NO_LONGER_VALID);
});

test("a token that is not 64 hex digits is 400, whatever else the body holds", async () => {
  for (const body of [{}, { token: 5 }, { token: "abc" }, { token: "F".repeat(64) }, { token: "f".repeat(65) }]) {
    await expectAnswer(await postFromPage(w.app, PREVIEW, body), 400, "invalid token");
  }
});

test("without the server's Origin, or from another site, a preview is 403 and names nothing", async () => {
  const { token } = await newInvite(w, "bob", w.B, "viewer");
  for (const headers of [{}, { Origin: "https://elsewhere.example" }] as Record<string, string>[]) {
    const res = await send(w, "POST", PREVIEW, { token }, headers);
    await expectAnswer(res, 403, "cross-site request refused");
  }
});

test("the table of every caller answers 200 to all but bobElsewhere, who is 403, and a preview leaves both teams' rows as they were", async () => {
  const route = routeNamed("POST /api/invites/preview");
  expect(CALLERS.map((c) => [c, statusOf(route, c)]).filter(([, s]) => s !== 200)).toEqual([["bobElsewhere", 403]]);
  const { token } = await newInvite(w, "bob", w.B, "viewer");
  const before = bothTeams();
  await preview(token);
  expect(bothTeams()).toEqual(before);
});

test("a preview and an accept open together: the accept succeeds once, the preview is 200 or 404, and the rows are those of one accept", async () => {
  const { token } = await newInvite(w, "bob", w.B, "viewer");
  const rolesBefore = roleRows(w.db, w.B.id).length;
  const [seen, accepted, second] = await Promise.all([preview(token), accept(token), accept(token)]);
  expect([200, 404]).toContain(seen.status);
  expect([accepted.status, second.status].sort()).toEqual([200, 404]);
  expect(roleRows(w.db, w.B.id)).toHaveLength(rolesBefore + 1);
  expect(everythingOf(w.db, w.B.id).admin_invites).toEqual([]);
});

test("no log line holds a token, for a preview of any kind", async () => {
  const live = await newInvite(w, "bob", w.B, "viewer");
  const unknown = "cd".repeat(32);
  await Promise.all([preview(live.token), preview(unknown), postFromPage(w.app, PREVIEW, { token: "short" })]);
  expect(logged).toEqual([]);
});
