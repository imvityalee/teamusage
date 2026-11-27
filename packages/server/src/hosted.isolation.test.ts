import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Stats } from "@teamusage/shared";
import { MID, record } from "./app.fixture.js";
import { sha256 } from "./db.js";
import { CALLERS, requestAs, rowsOf, SAME_EMAIL, STATS_RANGE, twoTeams } from "./hosted.two-teams.fixture.js";
import type { CallerName, Team, TeamKey, TeamRows, World } from "./hosted.two-teams.fixture.js";
import { CODE_OPENS_NO_DASHBOARD, DASHBOARD_LIMITED } from "./stats-access.js";

// Every route called as every kind of caller against one pair of teams. The tests run in order and share the
// teams: reads first, then the requests that add rows, then signing out, then the check of every team's rows.

/** The clock stands still, so every row written is known to the second. */
const T0 = new Date("2026-11-20T09:00:00.000Z");
const NO_SUCH_TEAM = "0123456789abcdef";
const WRONG_CODE = "0".repeat(24);

let w: World;
/** Each team's rows as they must be: what twoTeams() created, plus what each request since added to that team. */
let expected: Record<TeamKey, TeamRows>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  w = await twoTeams();
  expected = { A: rowsOf(w.db, w.teams.A.id), B: rowsOf(w.db, w.teams.B.id) };
});
afterAll(() => {
  vi.useRealTimers();
});

const other = (k: TeamKey): TeamKey => (k === "A" ? "B" : "A");
const as = (caller: CallerName, path: string, init?: { method?: string; body?: unknown }) => requestAs(w.app, w.callers[caller], path, init);
const post = (caller: CallerName, path: string, body?: unknown) => as(caller, path, { method: "POST", body });
const count = (table: string) => (w.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

/** Both teams' rows in members, machines and usage are exactly what they must be. */
function expectRowsAsExpected(): void {
  for (const k of ["A", "B"] as const) expect(rowsOf(w.db, w.teams[k].id), `team ${k}'s rows`).toEqual(expected[k]);
}

/** The text holds nothing that marks team `k`: its public id, code, name, member's name or machine label. */
function expectNothingOf(text: string, k: TeamKey): void {
  const t = w.teams[k];
  for (const marker of [t.publicId, t.code, t.name, t.memberName, t.machineLabel]) expect(text, `team ${k}'s marker`).not.toContain(marker);
}

async function expectError(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

/** A 200 holding team `k`'s numbers, of its member alone when `member`, and nothing of the other team. */
async function expectStatsOf(res: Response, k: TeamKey, member: boolean): Promise<void> {
  expect(res.status).toBe(200);
  const text = await res.text();
  expectNothingOf(text, other(k));
  const body = JSON.parse(text) as Stats;
  const own = w.teams[k];
  expect(body.totals.tokens).toBe(own.total);
  expect(body.totals.costUsd).toBe(own.costUsd);
  expect(body.daily.flatMap((d) => Object.values(d.byAgent)).reduce((s, n) => s + n, 0)).toBe(own.total);
  expect(body.models.map((m) => m.total)).toEqual([own.total]);
  expect(body.available.models.map((m) => m.tokens)).toEqual([own.total]);
  const counted = body.members.filter((m) => m.tokens > 0).map(({ id, name, email, tokens }) => ({ id, name, email, tokens }));
  expect(counted).toEqual([{ id: own.memberId, name: own.memberName, email: SAME_EMAIL, tokens: own.total }]);
  if (member) {
    expect(body.members).toHaveLength(1);
    expect(body.machines?.map((m) => m.label)).toEqual([own.machineLabel]);
  } else {
    expect(body.machines).toBeUndefined();
  }
}

describe("GET /api/stats", () => {
  /** What follows the date range in each form of the request. */
  const FORMS: [string, (t: Record<TeamKey, Team>) => string][] = [
    ["team view", () => ""],
    ["member=me", () => "&member=me"],
    ["member=<A's member>", (t) => `&member=${t.A.memberId}`],
    ["member=<B's member>", (t) => `&member=${t.B.memberId}`],
    ["team=<A>", (t) => `&team=${t.A.publicId}`],
    ["team=<B>", (t) => `&team=${t.B.publicId}`],
    ["team=<A>&member=me", (t) => `&team=${t.A.publicId}&member=me`],
    ["team=<B>&member=me", (t) => `&team=${t.B.publicId}&member=me`],
    ["team=<A>&member=<A's member>", (t) => `&team=${t.A.publicId}&member=${t.A.memberId}`],
    ["team=<A>&member=<B's member>", (t) => `&team=${t.A.publicId}&member=${t.B.memberId}`],
    ["team=<B>&member=<A's member>", (t) => `&team=${t.B.publicId}&member=${t.A.memberId}`],
    ["team=<B>&member=<B's member>", (t) => `&team=${t.B.publicId}&member=${t.B.memberId}`],
    ["team=<no such team>", () => `&team=${NO_SUCH_TEAM}`],
  ];
  type Outcome = "A" | "A member" | "B member" | "B" | "401" | "400 query" | "400 member" | "403 limited" | "404 member" | "404 team";
  const ERRORS: Record<string, [number, string]> = {
    "401": [401, "unauthorized"],
    "400 query": [400, "invalid query"],
    "400 member": [400, "invalid member"],
    "403 limited": [403, DASHBOARD_LIMITED],
    "404 member": [404, "member not found"],
    "404 team": [404, "team not found"],
  };
  const [Q, M, L, NM, NT] = ["400 query", "400 member", "403 limited", "404 member", "404 team"] as const;
  /** Each caller's outcome for each form, in the order of FORMS. */
  const OUTCOMES: Record<CallerName, Outcome[]> = {
    nobody: Array(13).fill("401"),
    machineA: ["A", "A member", "A member", NM, "A", "A", "A member", "A member", "A member", NM, "A member", NM, "A"],
    machineB: [L, "B member", L, L, L, L, "B member", "B member", L, L, L, L, L],
    memberA: ["A", "A member", "A member", NM, "A", "A", "A member", "A member", "A member", NM, "A member", NM, "A"],
    ann: [Q, Q, Q, Q, "A", NT, M, NT, "A member", NM, NT, NT, NT],
    bob: [Q, Q, Q, Q, NT, "B", NT, M, NT, NT, NM, "B member", NT],
    eve: [Q, Q, Q, Q, NT, NT, NT, NT, NT, NT, NT, NT, NT],
  };
  const rows = CALLERS.flatMap((caller) => FORMS.map(([form, query], i) => ({ caller, form, query, outcome: OUTCOMES[caller][i] as Outcome })));

  test("the table has an outcome for every caller and every form", () => {
    for (const caller of CALLERS) expect(OUTCOMES[caller], caller).toHaveLength(FORMS.length);
  });

  test.each(rows)("as $caller, $form: $outcome", async ({ caller, query, outcome }) => {
    const res = await as(caller, `/api/stats?${STATS_RANGE}${query(w.teams)}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const error = ERRORS[outcome];
    if (error) return expectError(res, error[0], error[1]);
    const [k, scope] = outcome.split(" ") as [TeamKey, string?];
    return expectStatsOf(res, k, scope === "member");
  });

  test.each([
    ["ann", "B"],
    ["bob", "A"],
    ["eve", "A"],
    ["eve", "B"],
  ] as const)("%s asking for team %s by public id gets exactly the answer for a team that does not exist", async (caller, k) => {
    const ask = (publicId: string) => as(caller, `/api/stats?${STATS_RANGE}&team=${publicId}`);
    const [real, none] = [await ask(w.teams[k].publicId), await ask(NO_SUCH_TEAM)];
    expect(real.status).toBe(404);
    expect([...real.headers]).toEqual([...none.headers]);
    expect(await real.text()).toBe(await none.text());
  });
});

describe("POST /api/usage", () => {
  const TEAM_OF: Partial<Record<CallerName, TeamKey>> = { machineA: "A", machineB: "B" };

  test.each(CALLERS)("as %s: lands only in the caller's own team", async (caller) => {
    const at = new Date(T0.getTime() + 60_000 * (CALLERS.indexOf(caller) + 1));
    vi.setSystemTime(at);
    const own = TEAM_OF[caller];
    const target = w.teams[other(own ?? "A")];
    const probe = record({ date: "2026-10-15", model: `probe-${caller}`, input: 33, total: 42, costUsd: 0.125 });
    // The body names the other team as well; only the token decides where the record goes.
    const res = await post(caller, "/api/usage", { records: [probe], team: target.publicId, teamId: target.id });
    if (own === undefined) {
      await expectError(res, 401, "unauthorized");
      return expectRowsAsExpected();
    }
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 1, kept: 0 });
    const team = w.teams[own];
    expected[own].usage.push({
      team_id: team.id, member_id: team.memberId, machine_id: MID, date: "2026-10-15", agent: "claude",
      model: `probe-${caller}`, input: 33, output: 2, cache_create: 3, cache_read: 4, total: 42, cost_usd: 0.125, unpriced: 0,
      account_kind: null, account_org: null, account_plan: null,
    });
    expected[own].machines = expected[own].machines.map((m) => (m.id === MID ? { ...m, last_sync_at: at.toISOString() } : m));
    expectRowsAsExpected();
  });
});

describe("codes", () => {
  const CODES = ["A", "B", "wrong"] as const;
  type Code = (typeof CODES)[number];
  const codeOf = (code: Code) => (code === "wrong" ? WRONG_CODE : w.teams[code].code);
  const rows = CALLERS.flatMap((caller) => CODES.map((code) => ({ caller, code })));

  test.each(rows)("POST /api/register as $caller with $code's code", async ({ caller, code }) => {
    const machineId = createHash("md5").update(`${caller} ${code}`).digest("hex");
    const email = `joiner.${caller}.${code}@example.com`.toLowerCase();
    const res = await post(caller, "/api/register", { inviteCode: codeOf(code), name: "New Joiner", email, machineId, machineLabel: "joiner-laptop" });
    if (code === "wrong") {
      await expectError(res, 403, "invalid invite code");
      return expectRowsAsExpected();
    }
    expect(res.status).toBe(200);
    const text = await res.text();
    expectNothingOf(text, other(code));
    const { token, memberId } = JSON.parse(text) as { token: string; memberId: number };
    const [teamId, at] = [w.teams[code].id, new Date().toISOString()];
    expected[code].members.push({ id: memberId, team_id: teamId, email, name: "New Joiner", created_at: at });
    expected[code].machines.push({
      team_id: teamId, id: machineId, member_id: memberId, label: "joiner-laptop", token_hash: sha256(token), created_at: at, last_sync_at: null,
    });
    expectRowsAsExpected();
  });

  test.each(rows)("POST /api/login as $caller with $code's code", async ({ caller, code }) => {
    const sessions = count("sessions");
    const res = await post(caller, "/api/login", { inviteCode: codeOf(code) });
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expectError(res, 403, CODE_OPENS_NO_DASHBOARD);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("tu_session=");
    expect(count("sessions")).toBe(sessions);
    expectRowsAsExpected();
  });
});

describe("GET /api/me", () => {
  const ME: Record<CallerName, ((t: Record<TeamKey, Team>) => unknown) | null> = {
    nobody: null,
    machineA: null,
    machineB: null,
    memberA: (t) => ({ kind: "member", team: { id: t.A.publicId, name: t.A.name }, memberId: t.A.memberId }),
    ann: (t) => ({ kind: "user", githubId: 1, login: "ann", teams: [{ id: t.A.publicId, name: t.A.name, role: "owner", dashboardAccess: "members" }] }),
    bob: (t) => ({ kind: "user", githubId: 2, login: "bob", teams: [{ id: t.B.publicId, name: t.B.name, role: "owner", dashboardAccess: "admins" }] }),
    eve: () => ({ kind: "user", githubId: 3, login: "eve", teams: [] }),
  };

  test.each(CALLERS)("as %s", async (caller) => {
    const res = await as(caller, "/api/me");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const me = ME[caller];
    if (me === null) return expectError(res, 401, "unauthorized");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(me(w.teams));
  });
});

describe("POST /api/teams", () => {
  const CREATES: CallerName[] = ["ann", "bob", "eve"];

  test.each(CALLERS)("as %s", async (caller) => {
    const teams = count("teams");
    const res = await post(caller, "/api/teams", { name: `Fresh team of ${caller}`, dashboardAccess: "members" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    if (!CREATES.includes(caller)) {
      await expectError(res, 401, "unauthorized");
      expect(count("teams")).toBe(teams);
      return expectRowsAsExpected();
    }
    expect(res.status).toBe(201);
    const text = await res.text();
    expectNothingOf(text, "A");
    expectNothingOf(text, "B");
    expect((JSON.parse(text) as { team: { name: string } }).team.name).toBe(`Fresh team of ${caller}`);
    expect(count("teams")).toBe(teams + 1);
    expectRowsAsExpected();
  });
});

describe("POST /api/logout", () => {
  /** Ann signs out before memberA and bob, so her logout is seen to leave them signed in. */
  const ORDER: CallerName[] = ["nobody", "machineA", "machineB", "ann", "memberA", "bob", "eve"];
  const signedIn = new Set<CallerName>(["memberA", "ann", "bob", "eve"]);

  test.each(ORDER)("as %s ends that caller's session alone", async (caller) => {
    const sessions = count("sessions");
    const res = await post(caller, "/api/logout");
    expect(res.status).toBe(204);
    expect(count("sessions")).toBe(signedIn.has(caller) ? sessions - 1 : sessions);
    signedIn.delete(caller);
    for (const c of CALLERS) expect((await as(c, "/api/me")).status, `${c} after ${caller}'s logout`).toBe(signedIn.has(c) ? 200 : 401);
  });
});

test("afterwards each team's rows are what twoTeams() created plus what its own callers added", () => {
  expect(expected.A.usage).toHaveLength(2);
  expect(expected.B.usage).toHaveLength(2);
  expect(expected.A.members).toHaveLength(1 + CALLERS.length);
  expect(expected.B.members).toHaveLength(1 + CALLERS.length);
  expectRowsAsExpected();
});
