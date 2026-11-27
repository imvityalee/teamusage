import { beforeEach, describe, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import type { Db } from "./db.js";
import type { TeamInfo } from "./hosted-teams.js";
import { hostedApp, hostedTeam, memberSignIn, postFromPage, PUBLIC, signIn } from "./hosted.fixture.js";
import { createTeamSession } from "./sessions.js";
import { CODE_OPENS_NO_DASHBOARD, DASHBOARD_LIMITED } from "./stats-access.js";
import { authenticate, forTeam } from "./team-data.js";

let db: Db;
let app: ReturnType<typeof hostedApp>["app"];
/** Team A's members see its numbers (owner ann); team B's numbers are for its admins only (owner bob). Each code only joins. */
let a: { team: TeamInfo; code: string }, b: { team: TeamInfo; code: string };

beforeEach(() => {
  ({ db, app } = hostedApp());
  a = hostedTeam(db, { githubId: 1, login: "ann" }, "members");
  b = hostedTeam(db, { githubId: 2, login: "bob" }, "admins");
});

const WRONG = "0".repeat(24);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => postFromPage(app, path, body, headers);
const register = (over: Record<string, unknown>) => post("/api/register", goodReg(over));
/** Registers a machine of `email` with `code`; returns its token. */
const join = async (code: string, email: string) => ((await (await register({ inviteCode: code, email })).json()) as { token: string }).token;
const stats = (headers: Record<string, string>, extra = "") => app.request(`/api/stats?from=2026-11-01&to=2026-11-10${extra}`, { headers });
/** Uploads one record of `tokens` tokens with the machine `token`. */
const upload = async (token: string, tokens: number) =>
  expect((await post("/api/usage", { records: [record({ input: tokens - 9, total: tokens })] }, { Authorization: `Bearer ${token}` })).status).toBe(200);
const sessionCount = () => (db.prepare("select count(*) as n from sessions").get() as { n: number }).n;
type Numbers = { totals: { tokens: number }; members: { email: string }[] };
const numbers = async (res: Response) => {
  expect(res.status).toBe(200);
  const body = (await res.json()) as Numbers;
  return { tokens: body.totals.tokens, emails: body.members.map((m) => m.email) };
};
const failUntilLimited = async () => {
  for (let i = 0; i < 10; i++) expect((await register({ inviteCode: WRONG })).status).toBe(403);
};

describe("codes", () => {
  test("each code joins its own team, and the same laptop joins both", async () => {
    const ta = await join(a.code, "ann@example.com");
    const tb = await join(b.code, "ann@example.com");
    expect(authenticate(db, ta)!.teamId).toBe(a.team.id);
    expect(authenticate(db, tb)!.teamId).toBe(b.team.id);
  });
  test("no code opens a dashboard: the answer is the same for a right code, a wrong one and none, and nothing is counted", async () => {
    const before = sessionCount();
    /** A sign-in from the server's own pages, from another site, and with no Origin at all. */
    const ORIGINS = [PUBLIC, "https://evil.example", undefined];
    const signInFrom = (origin: string | undefined, body: unknown) =>
      app.request("/api/login", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }) },
      });
    for (const body of [{ inviteCode: a.code }, { inviteCode: b.code }, { inviteCode: WRONG }, {}, "{nope"]) {
      for (let i = 0; i < 12; i++) {
        for (const origin of ORIGINS) {
          const res = await signInFrom(origin, body);
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual({ error: CODE_OPENS_NO_DASHBOARD });
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(res.headers.get("set-cookie") ?? "").not.toContain("tu_session=");
        }
      }
    }
    expect(sessionCount()).toBe(before);
    expect((await register({ inviteCode: WRONG })).status).toBe(403);   // 180 refused sign-ins counted no attempt
  });
  test("a code session from before this server refused them reads nothing", async () => {
    const cookie = `tu_session=${createTeamSession(db, a.team.id)}`;
    expect((await stats({ Cookie: cookie })).status).toBe(401);
    expect((await app.request("/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
  test("an address over its limit still joins with a correct code, its wrong codes get 429, and a sign-in is still refused", async () => {
    for (let i = 0; i < 10; i++) expect((await register({ inviteCode: WRONG })).status).toBe(403);
    expect((await register({ inviteCode: WRONG })).status).toBe(429);
    expect((await register({ inviteCode: a.code })).status).toBe(200);
    const refused = await post("/api/login", { inviteCode: a.code });
    expect([refused.status, await refused.json()]).toEqual([403, { error: CODE_OPENS_NO_DASHBOARD }]);
  });
  test("over the limit, a wrong code is 429 with Retry-After, and so is a body that is not a JSON object", async () => {
    await failUntilLimited();
    for (const body of [{ ...goodReg(), inviteCode: WRONG }, { name: "Ann" }, "{", "[]"]) {
      const res = await post("/api/register", body);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "too many attempts" });
      expect(res.headers.get("retry-after")).toBe("600");
    }
  });
  test("under the limit, a body that is not a JSON object is 400 and is not a failed attempt", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await (await post("/api/register", "{")).json()).toEqual({ error: "invalid JSON body" });
      expect(await (await post("/api/register", "[]")).json()).toEqual({ error: "body must be an object" });
    }
    await failUntilLimited();
    expect((await register({ inviteCode: WRONG })).status).toBe(429);
  });
  test("over the limit, a correct code with a bad registration gets that registration's 400", async () => {
    await failUntilLimited();
    const res = await register({ inviteCode: a.code, email: "not an email" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid email" });
  });
});

describe("stats", () => {
  test("a member of an admins-only team reads only their own numbers", async () => {
    const tb = await join(b.code, "bob@example.com");
    const auth = { Authorization: `Bearer ${tb}` };
    expect((await stats(auth, "&member=me")).status).toBe(200);
    for (const extra of ["", "&member=1", "&member=999999"]) {
      const res = await stats(auth, extra);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: DASHBOARD_LIMITED });
    }
  });
  test("an owner reads their team with a GitHub session; a stranger gets the answer of a team that does not exist", async () => {
    const owner = await signIn(app, "code-bob");          // owner of b
    const stranger = await signIn(app, "code-eve");       // owns nothing
    expect((await stats({ Cookie: owner }, `&team=${b.team.publicId}`)).status).toBe(200);
    const hidden = await stats({ Cookie: stranger }, `&team=${b.team.publicId}`);
    const missing = await stats({ Cookie: stranger }, `&team=${"0".repeat(16)}`);
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(await hidden.json()).toEqual(await missing.json());
    expect((await stats({ Cookie: owner })).status).toBe(400);
    expect((await stats({ Cookie: owner }, `&team=${b.team.publicId}&member=me`)).status).toBe(400);
  });
  test("a stranger's answer and a missing team's carry the same headers", async () => {
    const stranger = { Cookie: await signIn(app, "code-eve") };
    const hidden = await stats(stranger, `&team=${a.team.publicId}`);
    const missing = await stats(stranger, `&team=${"0".repeat(16)}`);
    expect(await hidden.json()).toEqual({ error: "team not found" });
    expect([...hidden.headers]).toEqual([...missing.headers]);
    expect(hidden.headers.get("cache-control")).toBe("no-store");
  });
  test("a machine token and its member's session read their own team whatever team the query names", async () => {
    const ta = await join(a.code, "ann@example.com");
    await upload(ta, 10);
    await upload(await join(b.code, "bob@example.com"), 700);
    const own = { tokens: 10, emails: ["ann@example.com"] };
    expect(await numbers(await stats({ Authorization: `Bearer ${ta}` }, `&team=${b.team.publicId}`))).toEqual(own);
    expect(await numbers(await stats({ Cookie: await memberSignIn(app, ta) }, `&team=${b.team.publicId}`))).toEqual(own);
    expect(await numbers(await stats({ Cookie: await signIn(app, "code-bob") }, `&team=${b.team.publicId}`))).toEqual({ tokens: 700, emails: ["bob@example.com"] });
  });
  test("an owner reads any member of their team; a member of another team is not found; `me` is no one", async () => {
    await join(a.code, "ann@example.com");
    await join(b.code, "bob@example.com");
    const annId = forTeam(db, a.team.id).listMembers()[0]!.id;
    const bobId = forTeam(db, b.team.id).listMembers()[0]!.id;
    const owner = { Cookie: await signIn(app, "code-ann") };
    const team = `&team=${a.team.publicId}`;
    expect((await numbers(await stats(owner, `${team}&member=${annId}`))).emails).toEqual(["ann@example.com"]);
    const other = await stats(owner, `${team}&member=${bobId}`);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "member not found" });
    expect(await (await stats(owner, `${team}&member=me`)).json()).toEqual({ error: "invalid member" });
  });
  test("a member's session whose team is gone is 401", async () => {
    const cookie = await memberSignIn(app, await join(a.code, "ann@example.com"));
    // Without the cascade the session row outlives its team, as it would if a deletion missed it.
    db.pragma("foreign_keys = OFF");
    db.prepare("delete from teams where id = ?").run(a.team.id);
    const res = await stats({ Cookie: cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
  test("a repeated team is 400 for every caller", async () => {
    const twice = `&team=${a.team.publicId}&team=${a.team.publicId}`;
    const callers: Record<string, string>[] = [
      { Cookie: await signIn(app, "code-ann") },
      { Cookie: await signIn(app, "code-eve") },
      { Authorization: `Bearer ${await join(a.code, "ann@example.com")}` },
    ];
    for (const headers of callers) expect(await (await stats(headers, twice)).json()).toEqual({ error: "invalid query" });
  });
});
