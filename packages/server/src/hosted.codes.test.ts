import { beforeEach, describe, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import type { Db } from "./db.js";
import type { TeamInfo } from "./hosted-teams.js";
import { codeLogin, cookieOf, hostedApp, hostedTeam, postFromPage, PUBLIC, signIn } from "./hosted.fixture.js";
import { DASHBOARD_LIMITED } from "./stats-access.js";
import { authenticate, forTeam } from "./team-data.js";

let db: Db;
let app: ReturnType<typeof hostedApp>["app"];
/** Team A opens its dashboard with its code (owner ann); team B only to its admins (owner bob). */
let a: { team: TeamInfo; code: string }, b: { team: TeamInfo; code: string };

beforeEach(() => {
  ({ db, app } = hostedApp());
  a = hostedTeam(db, { githubId: 1, login: "ann" }, "members");
  b = hostedTeam(db, { githubId: 2, login: "bob" }, "admins");
});

const WRONG = "0".repeat(24);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => postFromPage(app, path, body, headers);
const register = (over: Record<string, unknown>) => post("/api/register", goodReg(over));
const login = (code: string) => codeLogin(app, code);
/** Registers a machine of `email` with `code`; returns its token. */
const join = async (code: string, email: string) => ((await (await register({ inviteCode: code, email })).json()) as { token: string }).token;
const stats = (headers: Record<string, string>, extra = "") => app.request(`/api/stats?from=2026-11-01&to=2026-11-10${extra}`, { headers });
/** Uploads one record of `tokens` tokens with the machine `token`. */
const upload = async (token: string, tokens: number) =>
  expect((await post("/api/usage", { records: [record({ input: tokens - 9, total: tokens })] }, { Authorization: `Bearer ${token}` })).status).toBe(200);
const teamSessionOf = async (code: string) => cookieOf(await login(code), "tu_session");
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
  test("an address over its limit still gets in with a correct code, and its wrong codes get 429", async () => {
    for (let i = 0; i < 10; i++) expect((await register({ inviteCode: "0".repeat(24) })).status).toBe(403);
    expect((await register({ inviteCode: "0".repeat(24) })).status).toBe(429);
    expect((await register({ inviteCode: a.code })).status).toBe(200);
    expect((await login(a.code)).status).toBe(204);
    expect((await login("0".repeat(24))).status).toBe(429);
  });
  test("the code of an admins-only team opens no dashboard and is not a failed attempt", async () => {
    for (let i = 0; i < 12; i++) {
      const res = await login(b.code);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: DASHBOARD_LIMITED });
      expect(res.headers.get("set-cookie") ?? "").not.toContain("tu_session=");
    }
    expect((await login("0".repeat(24))).status).toBe(403);     // still counted from zero
  });
  test("over the limit, the code of an admins-only team is still told the dashboard is limited, and opens no session", async () => {
    await failUntilLimited();
    const res = await login(b.code);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: DASHBOARD_LIMITED });
    expect(db.prepare("select count(*) as n from sessions").get()).toEqual({ n: 0 });
  });
  test("over the limit, a wrong code is 429 with Retry-After on both routes, and so is a body that is not a JSON object", async () => {
    await failUntilLimited();
    for (const path of ["/api/register", "/api/login"]) {
      for (const body of [{ ...goodReg(), inviteCode: WRONG }, { name: "Ann" }, "{", "[]"]) {
        const res = await post(path, body);
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "too many attempts" });
        expect(res.headers.get("retry-after")).toBe("600");
      }
    }
  });
  test("under the limit, a body that is not a JSON object is 400 and is not a failed attempt", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await (await post("/api/register", "{")).json()).toEqual({ error: "invalid JSON body" });
      expect(await (await post("/api/login", "[]")).json()).toEqual({ error: "body must be an object" });
    }
    await failUntilLimited();
    expect((await login(WRONG)).status).toBe(429);
  });
  test("a sign-in that is not from the server's own origin is refused before its code is read, and is not a failed attempt", async () => {
    const send = (code: string, origin?: string) =>
      app.request("/api/login", { method: "POST", body: JSON.stringify({ inviteCode: code }), headers: origin === undefined ? {} : { Origin: origin } });
    for (const origin of [undefined, "https://evil.example", "null", `${PUBLIC}/`]) {
      for (const code of [a.code, WRONG, WRONG, WRONG]) {
        const res = await send(code, origin);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "cross-site request refused" });
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("set-cookie")).toBeNull();
      }
    }
    expect(db.prepare("select count(*) as n from sessions").get()).toEqual({ n: 0 });
    expect((await login(WRONG)).status).toBe(403);     // twelve wrong codes were sent, none was counted
    expect((await send(a.code, PUBLIC)).status).toBe(204);
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
  test("a machine token and a team session read their own team whatever team the query names", async () => {
    const ta = await join(a.code, "ann@example.com");
    await upload(ta, 10);
    await upload(await join(b.code, "bob@example.com"), 700);
    const own = { tokens: 10, emails: ["ann@example.com"] };
    expect(await numbers(await stats({ Authorization: `Bearer ${ta}` }, `&team=${b.team.publicId}`))).toEqual(own);
    expect(await numbers(await stats({ Cookie: await teamSessionOf(a.code) }, `&team=${b.team.publicId}`))).toEqual(own);
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
  test("a team session opened before its team became admins-only is 401", async () => {
    const cookie = await teamSessionOf(a.code);
    db.prepare("update teams set dashboard_access = 'admins' where id = ?").run(a.team.id);
    const res = await stats({ Cookie: cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
  test("a team session whose team is gone is 401", async () => {
    const cookie = await teamSessionOf(a.code);
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
