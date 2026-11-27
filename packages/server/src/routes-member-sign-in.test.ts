import type { Hono } from "hono";
import { beforeEach, expect, test } from "vitest";
import type { Stats } from "@teamusage/shared";
import { goodReg, record } from "./app.fixture.js";
import { DASHBOARD_LINK_SECONDS } from "./dashboard-links.js";
import { sha256, type Db } from "./db.js";
import type { TeamInfo } from "./hosted-teams.js";
import { cookieOf, hostedApp, hostedTeam, machineIdOf, memberSignIn, postFromPage, PUBLIC, signIn, testCaps, testLimits } from "./hosted.fixture.js";
import { MAX_MEMBER_SESSIONS } from "./sessions.js";
import { forTeam } from "./team-data.js";

const RANGE = "from=2026-11-01&to=2026-11-10";
const A_TOTAL = 10;
const B_TOTAL = 700;
const ADMINS_ONLY = { error: "this team's dashboard is limited to its admins" };
const LINK_NOT_VALID = { error: "this link is no longer valid; ask your agent for a new one" };
const OPEN = "/api/dashboard-link/open";

const clock = { t: 0 };
let db: Db;
let app: Hono;
let a: { team: TeamInfo; code: string }, b: { team: TeamInfo; code: string };
/** B's member sam with the tokens of machines `one` and `two`, and B's member tia with her machine's token. */
let sam: { memberId: number; one: string; two: string }, tia: { memberId: number; token: string };

/** Registers machine `n` of the member with `email` through the team's code; returns its token and member id. */
async function register(code: string, email: string, n: number): Promise<{ token: string; memberId: number }> {
  const res = await postFromPage(app, "/api/register", goodReg({ inviteCode: code, email, machineId: machineIdOf(n), machineLabel: `box-${n}` }));
  if (res.status !== 200) throw new Error(`registering machine ${n} answered ${res.status}`);
  return (await res.json()) as { token: string; memberId: number };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
async function upload(token: string, total: number): Promise<void> {
  const res = await postFromPage(app, "/api/usage", { records: [record({ date: "2026-11-03", input: total - 9, total })] }, bearer(token));
  if (res.status !== 200) throw new Error(`uploading answered ${res.status}`);
}

beforeEach(async () => {
  clock.t = Date.parse("2026-11-10T12:00:00.000Z");
  ({ db, app } = hostedApp({ now: () => clock.t, limits: testLimits(testCaps()) }));
  a = hostedTeam(db, { githubId: 1101, login: "ann" }, "members");
  b = hostedTeam(db, { githubId: 2202, login: "bob" }, "members");
  const inA = [];
  for (let n = 1; n <= 5; n++) inA.push(await register(a.code, `a${n}@example.com`, n));
  await upload(inA[0]!.token, A_TOTAL);
  // tia joins before sam's second machine: registering a known member's machine uses up a member id.
  const [one, t, two] = [await register(b.code, "sam@example.com", 11), await register(b.code, "tia@example.com", 13), await register(b.code, "sam@example.com", 12)];
  sam = { memberId: one.memberId, one: one.token, two: two.token };
  tia = { memberId: t.memberId, token: t.token };
  await upload(sam.one, B_TOTAL);
  expect([b.team.id, sam.memberId, tia.memberId]).toEqual([2, 6, 7]);
});

const link = (token: string) => app.request("/api/dashboard-link", { method: "POST", headers: bearer(token) });
const linkToken = async (token: string) => ((await (await link(token)).json()) as { path: string }).path.slice("/open#".length);
const open = (token: unknown) => postFromPage(app, OPEN, { token });
const stats = (cookie: string, more = "") => app.request(`/api/stats?${RANGE}${more}`, { headers: { Cookie: cookie } });
const me = (cookie: string) => app.request("/api/me", { headers: { Cookie: cookie } });
const tokensOf = async (res: Response) => ((await res.json()) as Stats).totals.tokens;
const membersOf = async (res: Response) => ((await res.json()) as Stats).members.map(({ id, email }) => ({ id, email }));
const memberSessions = () => (db.prepare("select count(*) as n from sessions where kind = 'member'").get() as { n: number }).n;
const sessionsOf = (memberId: number) => (db.prepare("select count(*) as n from sessions where member_id = ?").get(memberId) as { n: number }).n;
/** Sets team B's dashboard access with SQL, as Task 4's route will. */
const limitBToAdmins = () => db.prepare("update teams set dashboard_access = 'admins' where id = ?").run(b.team.id);

async function expectError(res: Response, status: number, body: { error: string }): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual(body);
}

test("a machine asks for a link, the link opens the dashboard once, as that machine's member", async () => {
  const res = await link(sam.one);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const { path, expiresIn } = (await res.json()) as { path: string; expiresIn: number };
  expect(path).toMatch(/^\/open#[a-f0-9]{64}$/);
  expect(expiresIn).toBe(300);
  const opened = await open(path.slice(6));
  expect(opened.status).toBe(204);
  const cookie = cookieOf(opened, "tu_session");
  expect(await tokensOf(await stats(cookie))).toBe(B_TOTAL);
  expect(await membersOf(await stats(cookie, "&member=me"))).toEqual([{ id: sam.memberId, email: "sam@example.com" }]);
  expect(await (await me(cookie)).json()).toEqual({ kind: "member", team: { id: b.team.publicId, name: b.team.name }, memberId: sam.memberId });
  const again = await open(path.slice(6));
  expect(again.status).toBe(403);
  expect(await again.json()).toEqual({ error: "this link is no longer valid; ask your agent for a new one" });
});
test("twenty browsers open one link together and one is signed in", async () => {
  const token = await linkToken(sam.one);
  const answers = await Promise.all(Array.from({ length: 20 }, () => open(token)));
  expect(answers.map((r) => r.status).sort()).toEqual([204, ...Array(19).fill(403)]);
  expect(memberSessions()).toBe(1);
});
test("a link works for 300 seconds", async () => {
  const [early, late] = [await linkToken(sam.one), await linkToken(sam.two)];
  clock.t += 299_999;
  expect((await open(early)).status).toBe(204);
  clock.t += 1;
  expect((await open(late)).status).toBe(403);
});
test("the agreed values", () => expect([DASHBOARD_LINK_SECONDS, MAX_MEMBER_SESSIONS]).toEqual([300, 5]));

test("a machine's new link replaces its older one and leaves another machine's", async () => {
  const older = await linkToken(sam.one);
  const other = await linkToken(sam.two);
  const newer = await linkToken(sam.one);
  await expectError(await open(older), 403, LINK_NOT_VALID);
  expect((await open(newer)).status).toBe(204);
  expect((await open(other)).status).toBe(204);
});
test("removing a machine ends the session opened from it, keeps the one from the member's other machine, and voids its link", async () => {
  const [fromOne, fromTwo] = [await memberSignIn(app, sam.one), await memberSignIn(app, sam.two)];
  const pending = await linkToken(sam.one);
  forTeam(db, b.team.id).removeMachine(machineIdOf(11));
  await expectError(await stats(fromOne), 401, { error: "unauthorized" });
  expect((await me(fromOne)).status).toBe(401);
  expect((await stats(fromTwo)).status).toBe(200);
  await expectError(await open(pending), 403, LINK_NOT_VALID);
});
test("removing the member ends the sessions from both machines and keeps another member's", async () => {
  const [fromOne, fromTwo, ofTia] = [await memberSignIn(app, sam.one), await memberSignIn(app, sam.two), await memberSignIn(app, tia.token)];
  forTeam(db, b.team.id).removeMember("sam@example.com");
  expect([(await stats(fromOne)).status, (await stats(fromTwo)).status, (await stats(ofTia)).status]).toEqual([401, 401, 200]);
});
test("six links of one member opened together leave that member five sessions and another member's alone", async () => {
  const ofTia = await memberSignIn(app, tia.token);
  const more = [];
  for (let n = 14; n <= 17; n++) more.push((await register(b.code, "sam@example.com", n)).token);
  const tokens = await Promise.all([sam.one, sam.two, ...more].map(linkToken));
  const answers = await Promise.all(tokens.map(open));
  expect(answers.map((r) => r.status)).toEqual(Array(6).fill(204));
  expect(sessionsOf(sam.memberId)).toBe(MAX_MEMBER_SESSIONS);
  expect(sessionsOf(tia.memberId)).toBe(1);
  expect((await stats(ofTia)).status).toBe(200);
});

test("a machine of a team on admins gets no link", async () => {
  const c = hostedTeam(db, { githubId: 3303, login: "cat" }, "admins");
  const { token } = await register(c.code, "cy@example.com", 21);
  await expectError(await link(token), 403, ADMINS_ONLY);
});
test("a link made before the team changed to admins answers 403 on opening and opens no session", async () => {
  const token = await linkToken(sam.one);
  // The product's own route will also drop the team's links (Task 4); this guards the second lock, in the opening.
  limitBToAdmins();
  await expectError(await open(token), 403, ADMINS_ONLY);
  expect(memberSessions()).toBe(0);
});
test("a member's session of a team that changed to admins is 401 on stats and on me", async () => {
  const cookie = await memberSignIn(app, sam.one);
  // The product's own route will set this (Task 4); a session opened before must not read the team after.
  limitBToAdmins();
  await expectError(await stats(cookie), 401, { error: "unauthorized" });
  await expectError(await me(cookie), 401, { error: "unauthorized" });
});
test("a member's session reads its own team, whatever team the query names", async () => {
  const cookie = await memberSignIn(app, sam.one);
  expect(await tokensOf(await stats(cookie, `&team=${a.team.publicId}`))).toBe(B_TOTAL);
});

test("the link request needs a machine's token: none, an unknown one, or a cookie instead is 401", async () => {
  const github = await signIn(app, "code-eve");
  const member = await memberSignIn(app, sam.one);
  const request = (headers: Record<string, string>) => app.request("/api/dashboard-link", { method: "POST", headers });
  for (const res of [await request({}), await link("f".repeat(64)), await request({ Cookie: github }), await request({ Cookie: member })]) {
    await expectError(res, 401, { error: "unauthorized" });
  }
});
test.each<[string, string, string]>([
  ["not JSON", "{", "invalid JSON body"],
  ["not an object", "[]", "body must be an object"],
  ["without a token", "{}", "invalid token"],
  ["with a short token", JSON.stringify({ token: "a".repeat(63) }), "invalid token"],
  ["with a long token", JSON.stringify({ token: "a".repeat(65) }), "invalid token"],
  ["with an uppercase token", JSON.stringify({ token: "A".repeat(64) }), "invalid token"],
  ["with a token that is not hex", JSON.stringify({ token: "g".repeat(64) }), "invalid token"],
  ["with a number for a token", JSON.stringify({ token: 7 }), "invalid token"],
])("opening with a body %s is 400", async (_, body, error) => {
  await expectError(await postFromPage(app, OPEN, body), 400, { error });
});
test("an unknown token of the right form gets the answer of a used one", async () => {
  const token = await linkToken(sam.one);
  await open(token);
  const [used, unknown] = [await open(token), await open("0".repeat(64))];
  expect(unknown.status).toBe(used.status);
  expect([...unknown.headers]).toEqual([...used.headers]);
  expect(await unknown.json()).toEqual(await used.json());
  await expectError(await open("1".repeat(64)), 403, LINK_NOT_VALID);
});
test("opening without the server's origin is refused and uses up nothing", async () => {
  const token = await linkToken(sam.one);
  const origins: Record<string, string>[] = [{}, { Origin: "https://evil.example" }, { Origin: "null" }, { Origin: `${PUBLIC}.evil.example` }];
  for (const origin of origins) {
    const res = await app.request(OPEN, { method: "POST", body: JSON.stringify({ token }), headers: { "Content-Type": "application/json", ...origin } });
    expect(res.headers.get("set-cookie")).toBeNull();
    await expectError(res, 403, { error: "cross-site request refused" });
  }
  expect(memberSessions()).toBe(0);
  expect((await open(token)).status).toBe(204);
});
test("the database holds no link token and no session id in clear", async () => {
  const [pending, used] = [await linkToken(sam.two), await linkToken(sam.one)];
  const session = cookieOf(await open(used), "tu_session").slice("tu_session=".length);
  const stored = JSON.stringify([db.prepare("select * from dashboard_links").all(), db.prepare("select * from sessions").all()]);
  for (const secret of [pending, used, session]) expect(stored).not.toContain(secret);
  expect(db.prepare("select token_hash from dashboard_links").all()).toEqual([{ token_hash: sha256(pending) }]);
  expect(db.prepare("select id from sessions where kind = 'member'").all()).toEqual([{ id: sha256(session) }]);
});
