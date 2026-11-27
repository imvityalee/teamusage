import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import { openServerDb, runAdmin } from "./admin.js";
import { cookieOf, fakeGithub, heldRequest, machineIdOf, settle, signIn } from "./hosted.fixture.js";
import { conn, hosted, PUBLIC_URL, roomy, serverConfig, tempDataDir } from "./main.fixture.js";
import { buildServer, type BuiltServer } from "./main.js";
import { SCHEMA_VERSION } from "./migrate.js";
import { selfHostedInUseAt5 } from "./migrations/earlier-version.fixture.js";

// The management routes through a real start in both modes, and a self-hosted database from before them.

/** The clock of these servers unless a test moves it. */
const START = Date.parse("2026-11-27T10:00:00.000Z");
/** The range of a stats request that holds every upload here: `record()` is dated 2026-11-01. */
const STATS = "/api/stats?from=2026-11-01&to=2026-11-02";
/** bob's GitHub id equals no row id of these databases. */
const BOB = { githubId: 2202, login: "bob" };

/** A request from the server's own pages: JSON, the hosted server's origin, from 1.2.3.4. */
const request = (s: BuiltServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  s.app.request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: PUBLIC_URL, ...headers },
  }, conn);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const upload = (s: BuiltServer, token: string) => request(s, "POST", "/api/usage", { records: [record()] }, bearer(token));
const statsWith = (s: BuiltServer, cookie: string) => s.app.request(STATS, { headers: { Cookie: cookie } }, conn);

/** Asks for a sign-in link as the machine `token`; returns the link's token. */
async function linkOf(s: BuiltServer, token: string): Promise<string> {
  const res = await request(s, "POST", "/api/dashboard-link", undefined, bearer(token));
  const { path, expiresIn } = (await res.json()) as { path: string; expiresIn: number };
  expect(expiresIn).toBe(300);
  return path.slice("/open#".length);
}
const openLink = (s: BuiltServer, token: string) => request(s, "POST", "/api/dashboard-link/open", { token });
const memberSession = async (s: BuiltServer, token: string) => cookieOf(await openLink(s, await linkOf(s, token)), "tu_session");

type Joined = { token: string; memberId: number };
/** Registers machine `n` of the person `name`, whose email and label follow from the name, with `inviteCode`. */
const register = async (s: BuiltServer, inviteCode: string, name: string, n: number): Promise<Response> => {
  const lower = name.toLowerCase();
  return request(s, "POST", "/api/register", goodReg({ inviteCode, name, email: `${lower}@example.com`, machineId: machineIdOf(n), machineLabel: `${lower}-laptop` }));
};

/**
 * A hosted start whose clock is `clock.t`, with a fake GitHub that knows bob: bob creates a team on `members`, and Sam
 * and Tia join with its code and upload one record each.
 */
async function hostedTeamInUse() {
  const clock = { t: START };
  const s = buildServer(hosted(tempDataDir()), { github: fakeGithub({ "code-bob": { id: BOB.githubId, login: BOB.login } }), measureDisk: roomy, now: () => clock.t });
  const bob = await signIn(s.app, "code-bob");
  const asBob = (method: string, path: string, body?: unknown) => request(s, method, path, body, { Cookie: bob });
  const created = (await (await asBob("POST", "/api/teams", { name: "Northwind", dashboardAccess: "members" })).json()) as { team: { id: string }; code: string };
  const joined = async (name: string, n: number) => (await (await register(s, created.code, name, n)).json()) as Joined;
  const [sam, tia] = [await joined("Sam", 0xb1), await joined("Tia", 0xb3)];
  for (const m of [sam, tia]) expect((await upload(s, m.token)).status).toBe(200);
  return { s, clock, asBob, team: `/api/teams/${created.team.id}`, code: created.code, sam, tia };
}

describe("a hosted start", () => {
  test("a sign-in link opens the dashboard one millisecond before 300 seconds and is refused at 300 seconds", async () => {
    const { s, clock, sam } = await hostedTeamInUse();
    try {
      const late = await linkOf(s, sam.token);
      clock.t += 300_000;
      const refused = await openLink(s, late);
      expect([refused.status, await refused.json()]).toEqual([403, { error: "this link is no longer valid; ask your agent for a new one" }]);
      const inTime = await linkOf(s, sam.token);
      clock.t += 299_999;
      const opened = await openLink(s, inTime);
      expect(opened.status).toBe(204);
      expect((await statsWith(s, cookieOf(opened, "tu_session"))).status).toBe(200);
    } finally {
      s.close();
    }
  });

  test("the owner lists the members with their machines, shows the code and rotates it", async () => {
    const { s, asBob, team, code } = await hostedTeamInUse();
    try {
      const { members } = (await (await asBob("GET", `${team}/members`)).json()) as { members: { name: string; email: string; machines: { id: string; label: string }[] }[] };
      expect(members.map((m) => [m.name, m.email, m.machines.map((x) => [x.id, x.label])])).toEqual([
        ["Sam", "sam@example.com", [[machineIdOf(0xb1), "sam-laptop"]]],
        ["Tia", "tia@example.com", [[machineIdOf(0xb3), "tia-laptop"]]],
      ]);
      expect(await (await asBob("GET", `${team}/code`)).json()).toEqual({ code });
      const { code: rotated } = (await (await asBob("POST", `${team}/code/rotate`)).json()) as { code: string };
      expect(rotated).toMatch(/^[a-f0-9]{24}$/);
      expect(rotated).not.toBe(code);
      expect(await (await asBob("GET", `${team}/code`)).json()).toEqual({ code: rotated });
      expect((await register(s, code, "Uma", 0xc1)).status).toBe(403);
      expect((await register(s, rotated, "Uma", 0xc1)).status).toBe(200);
    } finally {
      s.close();
    }
  });

  test("removing a member with a new code ends his browser, his machine and his code, while the colleague stays and a newcomer joins", async () => {
    const { s, asBob, team, code, sam, tia } = await hostedTeamInUse();
    try {
      const [samSession, tiaSession] = [await memberSession(s, sam.token), await memberSession(s, tia.token)];
      const held = heldRequest(s.app, "/api/usage", { method: "POST", text: JSON.stringify({ records: [record({ model: "held" })] }), headers: bearer(sam.token) });
      await settle();                                                 // the upload now waits for its body
      const removal = await asBob("POST", `${team}/removals`, { members: [sam.memberId], machines: [], rotateCode: true });
      const { removed, code: fresh } = (await removal.json()) as { removed: unknown; code: string };
      expect([removal.status, removed]).toEqual([200, { members: 1, machines: 1 }]);
      expect(fresh).toMatch(/^[a-f0-9]{24}$/);
      held.finish();
      expect((await held.answer).status).toBe(401);
      expect(s.db.prepare("select model from usage").pluck().all()).toEqual(["m"]);
      expect((await upload(s, sam.token)).status).toBe(401);
      expect((await statsWith(s, samSession)).status).toBe(401);
      expect((await register(s, code, "Sam", 0xb1)).status).toBe(403);
      expect((await statsWith(s, tiaSession)).status).toBe(200);
      expect((await upload(s, tia.token)).status).toBe(200);
      expect((await register(s, fresh, "Uma", 0xc1)).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe("a self-hosted start", () => {
  const TEAM = "/api/teams/0123456789abcdef";
  const MANAGEMENT: [string, string, unknown][] = [
    ["GET", TEAM, undefined],
    ["PATCH", TEAM, { name: "Renamed" }],
    ["GET", `${TEAM}/members`, undefined],
    ["GET", `${TEAM}/code`, undefined],
    ["GET", `${TEAM}/roles`, undefined],
    ["GET", `${TEAM}/invites`, undefined],
    ["POST", `${TEAM}/delete`, { name: "Team" }],
    ["POST", "/api/invites/accept", { token: "f".repeat(64) }],
  ];

  test("has no management route", async () => {
    const s = buildServer(serverConfig(), { now: () => START });
    try {
      for (const [method, path, body] of MANAGEMENT) {
        const res = await request(s, method, path, body);
        expect([res.status, await res.json()], `${method} ${path}`).toEqual([404, { error: "not found" }]);
      }
    } finally {
      s.close();
    }
  });

  test("signs a browser in with the invite code and a member with a link, and remove-member ends that member's session alone", async () => {
    const config = serverConfig();
    const s = buildServer(config, { now: () => START });
    try {
      const inviteCode = s.inviteCode!();
      const codeSession = cookieOf(await request(s, "POST", "/api/login", { inviteCode }), "tu_session");
      expect((await statsWith(s, codeSession)).status).toBe(200);
      const { token } = (await (await request(s, "POST", "/api/register", goodReg({ inviteCode }))).json()) as Joined;
      expect((await upload(s, token)).status).toBe(200);
      const opened = await openLink(s, await linkOf(s, token));
      expect(opened.status).toBe(204);
      const annSession = cookieOf(opened, "tu_session");
      expect((await statsWith(s, annSession)).status).toBe(200);
      const admin = openServerDb(join(config.dataDir, "teamusage.sqlite"), (line) => expect.fail(line))!;
      const lines: string[] = [];
      expect(runAdmin(admin, ["remove-member", "ann@example.com"], (line) => lines.push(line), {})).toBe(0);
      admin.close();
      expect(lines).toEqual(["member removed"]);
      expect((await statsWith(s, annSession)).status).toBe(401);
      expect((await statsWith(s, codeSession)).status).toBe(200);
    } finally {
      s.close();
    }
  });

  test("on a database of version 5 keeps its signed-in browser and its invite code", async () => {
    const dataDir = tempDataDir();
    mkdirSync(dataDir);
    const sessionId = "5".repeat(64);
    const { inviteCode } = selfHostedInUseAt5(join(dataDir, "teamusage.sqlite"), sessionId);
    const s = buildServer(serverConfig({ dataDir }), { now: () => START });
    try {
      expect(s.db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      const stats = await statsWith(s, `tu_session=${sessionId}`);
      expect(stats.status).toBe(200);
      expect(((await stats.json()) as { totals: { tokens: number } }).totals.tokens).toBe(10);
      const login = await request(s, "POST", "/api/login", { inviteCode });
      expect(login.status).toBe(204);
      expect(cookieOf(login, "tu_session")).not.toBe("");
      expect(s.db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      s.close();
    }
  });
});
