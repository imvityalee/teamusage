import { describe, expect, test } from "vitest";
import { goodReg, record } from "./app.fixture.js";
import { cookieOf, finishSignIn, machineIdOf } from "./hosted.fixture.js";
import { conn, webWith } from "./main.fixture.js";
import { fromPage, getWith, hostedServer, ownerWithTeam, PEOPLE, teamRowIds, TODAY } from "./main.web.fixture.js";
import type { BuiltServer } from "./main.js";

// The people of the plan's Review Focus as whole journeys over HTTP, through buildServer with the fake GitHub. On each
// server a first team exists before the team the journey acts on, so the acting team is the second one.

const RANGE = `from=2026-11-01&to=${TODAY}`;

/** Registers a machine with the team's `code`; returns the answer. */
const register = (s: BuiltServer, code: string, over: Record<string, unknown> = {}) =>
  s.app.request("/api/register", { method: "POST", body: JSON.stringify(goodReg({ inviteCode: code, ...over })) }, conn);

/** Registers a machine with the team's `code`; returns its token. */
async function join(s: BuiltServer, code: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await register(s, code, over);
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** A first team, owned by bob, with two members, so that the acting team's rows and its members' rows have other ids. */
async function firstTeam(s: BuiltServer): Promise<void> {
  const { code } = await ownerWithTeam(s, "code-bob", "First", "members");
  await join(s, code, { email: "one@first.example", machineId: machineIdOf(0xa1) });
  await join(s, code, { email: "two@first.example", machineId: machineIdOf(0xa2) });
}

describe("the person with two GitHub accounts who opens an invite", () => {
  test("the preview names the team; sign-in from the invite lands on /invite; after the accept /api/me lists the team with eve's role", async () => {
    const s = hostedServer();
    await firstTeam(s);
    const owner = await ownerWithTeam(s, "code-ann", "Acme", "members");
    const made = await fromPage(s, `/api/teams/${owner.team}/invites`, { role: "viewer" }, owner.cookie);
    expect(made.status).toBe(201);
    const { token } = (await made.json()) as { token: string };

    const preview = await fromPage(s, "/api/invites/preview", { token });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ team: { name: "Acme" }, role: "viewer" });

    const landed = await finishSignIn(s.app, "/auth/github/start?to=invite", "code-eve");
    expect(landed.status).toBe(302);
    expect(landed.headers.get("location")).toBe("/invite");
    const eve = cookieOf(landed, "tu_session");

    const accepted = await fromPage(s, "/api/invites/accept", { token }, eve);
    expect(accepted.status).toBe(200);
    const me = await getWith(s, "/api/me", eve);
    expect(await me.json()).toEqual({
      kind: "user",
      githubId: PEOPLE["code-eve"].id,
      login: "eve",
      teams: [{ id: owner.team, name: "Acme", role: "viewer", dashboardAccess: "members" }],
    });
  });
});

describe("the admin who is also a member and opens their agent's link where they manage the team", () => {
  test("the link ends the GitHub session and the member's session reads the team; registering again ends that session", async () => {
    const s = hostedServer();
    await firstTeam(s);
    const owner = await ownerWithTeam(s, "code-ann", "Acme", "members");
    const machine = { email: "ann@acme.example", machineId: machineIdOf(0xb1) };
    const token = await join(s, owner.code, machine);
    const uploaded = await s.app.request("/api/usage", {
      method: "POST",
      body: JSON.stringify({ records: [record({ date: "2026-11-18", input: 100, output: 20, cacheCreate: 3, cacheRead: 4, total: 127 })] }),
      headers: { Authorization: `Bearer ${token}` },
    }, conn);
    expect(uploaded.status).toBe(200);

    const linked = await s.app.request("/api/dashboard-link", { method: "POST", headers: { Authorization: `Bearer ${token}` } }, conn);
    expect(linked.status).toBe(200);
    const { path } = (await linked.json()) as { path: string };
    expect(path).toMatch(/^\/open#[a-f0-9]{64}$/);
    const opened = await fromPage(s, "/api/dashboard-link/open", { token: path.slice("/open#".length) }, owner.cookie);
    expect(opened.status).toBe(204);
    const member = cookieOf(opened, "tu_session");

    expect((await getWith(s, "/api/me", owner.cookie)).status).toBe(401);
    const me = (await (await getWith(s, "/api/me", member)).json()) as { kind: string; team: { id: string }; memberId: number };
    expect(me).toMatchObject({ kind: "member", team: { id: owner.team, name: "Acme" } });
    expect(teamRowIds(s)).not.toContain(me.memberId);
    const stats = await getWith(s, `/api/stats?${RANGE}`, member);
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as { totals: { tokens: number } }).totals.tokens).toBe(127);

    expect((await register(s, owner.code, machine)).status).toBe(200);
    expect((await getWith(s, `/api/stats?${RANGE}`, member)).status).toBe(401);
    expect((await getWith(s, "/api/me", member)).status).toBe(401);
  });
});

describe("anyone, before signing in", () => {
  test("/api/demo/stats answers without a cookie, and /demo and /dashboard both serve index.html", async () => {
    const s = hostedServer({ webRoot: webWith(["index.html", "landing.html"]) });
    const demo = await getWith(s, `/api/demo/stats?${RANGE}`);
    expect(demo.status).toBe(200);
    expect(((await demo.json()) as { totals: { memberCount: number } }).totals.memberCount).toBeGreaterThan(0);
    for (const page of ["/demo", "/dashboard"]) {
      const res = await getWith(s, page);
      expect(res.status, page).toBe(200);
      expect(await res.text(), page).toBe("index.html");
    }
  });
});
