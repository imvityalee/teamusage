import type { Hono } from "hono";
import { goodReg, record } from "./app.fixture.js";
import { createApp } from "./app.js";
import type { AppOptions } from "./app-context.js";
import { now, openDb, type Db } from "./db.js";
import type { GithubClient, GithubUser } from "./github.js";
import { createHostedTeam, hostedTeamCodes, type DashboardAccess, type Role } from "./hosted-teams.js";
import type { TeamLimits } from "./team-limits.js";
import { ensureUser } from "./users.js";

/** The hosted test server's own origin. */
export const PUBLIC = "https://teamusage.example";
/** The hosted test server's code key. */
export const KEY = Buffer.alloc(32, 7);
/** The GitHub users the fixture's fake GitHub knows, by the callback code that signs each in. */
const USERS: Record<string, GithubUser> = {
  "code-ann": { id: 1, login: "ann" },
  "code-bob": { id: 2, login: "bob" },
  "code-eve": { id: 3, login: "eve" },
};

export type FakeGithub = GithubClient & { calls: { code: string; verifier: string }[] };

/**
 * A GitHub that knows `users` by callback code and records every `fetchUser` call. Like GitHub, it takes a code
 * once: GitHub issues a fresh code for each sign-in, so here a code is taken once per sign-in's verifier.
 */
export function fakeGithub(users: Record<string, GithubUser>): FakeGithub {
  const calls: FakeGithub["calls"] = [];
  const exchanged = new Set<string>();
  return {
    calls,
    authorizeUrl: ({ state, challenge }) => `https://github.test/authorize?state=${state}&challenge=${challenge}`,
    fetchUser: async (a) => {
      calls.push(a);
      const key = `${a.code} ${a.verifier}`;
      const user = users[a.code];
      if (user === undefined || exchanged.has(key)) return null;
      exchanged.add(key);
      return user;
    },
  };
}

/** A GitHub user as the team helpers name one. */
type Person = { githubId: number; login: string };

/** Creates a team owned by `owner`, sealed with the fixture's key; it is named after the owner unless `name` is given. */
export const hostedTeam = (db: Db, owner: Person, dashboardAccess: DashboardAccess, name = owner.login) =>
  createHostedTeam(db, { name, dashboardAccess, owner, codeKey: KEY, maxTeams: 200 });

/** Gives `user` the `role` in team `teamId`, creating the user's row when it has none. */
export function grantRole(db: Db, teamId: number, user: Person, role: Role): void {
  db.prepare("insert into team_roles (team_id, user_id, role, created_at) values (?, ?, ?, ?)").run(teamId, ensureUser(db, user).id, role, now());
}

/** What a test may give a hosted app; `limits` may be made from the database the app opens. */
export type HostedAppOptions = Pick<AppOptions, "clientKey" | "logError" | "now" | "stopwatch"> & {
  limits?: AppOptions["limits"] | ((db: Db) => AppOptions["limits"]);
  maxTeams?: number;
};

/** A hosted app on a fresh in-memory database, with the fake GitHub it signs users in with. */
export function hostedApp(o: HostedAppOptions = {}) {
  const db = openDb(":memory:");
  const github = fakeGithub(USERS);
  const app = createApp(db, {
    teamForCode: hostedTeamCodes(db),
    clientKey: o.clientKey,
    logError: o.logError,
    limits: typeof o.limits === "function" ? o.limits(db) : o.limits,
    now: o.now,
    stopwatch: o.stopwatch,
    hosted: { github, publicUrl: PUBLIC, codeKey: KEY, maxTeams: o.maxTeams ?? 200 },
  });
  return { db, app, github };
}

/** A JSON POST from the server's own pages, which send its origin; a string body is sent as it is. */
export const postFromPage = async (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  app.request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: PUBLIC, ...headers },
  });

/** Signs in with a team's code from the server's own pages, as the dashboard does. */
export const codeLogin = (app: Hono, code: string): Promise<Response> => postFromPage(app, "/api/login", { inviteCode: code });

/** The `name=value` pair of the cookie `name` that the response sets; "" when it sets none. */
export const cookieOf = (res: Response, name: string): string =>
  new RegExp(`${name}=[^;]*`).exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";

/** Signs in through start and callback with the GitHub callback `code`; returns the `tu_session` cookie. */
export async function signIn(app: Hono, code: string): Promise<string> {
  const start = await app.request("/auth/github/start");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const res = await app.request(`/auth/github/callback?code=${encodeURIComponent(code)}&state=${state}`, {
    headers: { Cookie: cookieOf(start, "tu_oauth") },
  });
  const session = cookieOf(res, "tu_session");
  if (!session) throw new Error(`signing in with ${code} failed`);
  return session;
}

/** Signs a browser in as the machine `token`'s member: asks for a link and opens it; returns the `tu_session` cookie. */
export async function memberSignIn(app: Hono, token: string): Promise<string> {
  const linked = await app.request("/api/dashboard-link", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const { path } = (await linked.json()) as { path?: string };
  const opened = await postFromPage(app, "/api/dashboard-link/open", { token: path?.slice("/open#".length) });
  const session = cookieOf(opened, "tu_session");
  if (!session) throw new Error(`signing in as a member answered ${linked.status}, then ${opened.status}`);
  return session;
}

/** Caps for a test's team, each a value of its own, with room on the volume unless `over` says otherwise. */
export const testCaps = (over: Partial<TeamLimits> = {}): TeamLimits => ({
  membersPerTeam: 5, machinesPerMember: 6, rowsPerMachine: 1000, rowsPerTeam: 1001, rowsAddedPerDay: 1002, storageLow: () => false, ...over,
});

/**
 * A hosted app's limits for a test: `team` as given, three uploads a minute per machine, and each team budget and the
 * days a team keeps out of the way unless `over` sets them.
 */
export const testLimits = (team: TeamLimits, over: Partial<NonNullable<AppOptions["limits"]>> = {}): NonNullable<AppOptions["limits"]> => ({
  team,
  uploadsPerMinute: 3,
  teamUploadRecordsPerMinute: 1_000_000,
  teamStatsMsPerMinute: 2_000_000,
  usageDaysKept: 100_000,
  ...over,
});

/** A valid machine id for machine `n`: its hex digits padded with zeros to 32. */
export const machineIdOf = (n: number): string => n.toString(16).padStart(32, "0");

/** `n` records of different models, numbered from `from`. */
export const recordsOf = (n: number, from = 0): ReturnType<typeof record>[] => Array.from({ length: n }, (_, i) => record({ model: `m${from + i}` }));

/** What a machine does against a hosted app and a team's invite code, both read when a call is made, so a test may replace them. */
export function machineClient(app: () => Hono, code: () => string) {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => postFromPage(app(), path, body, headers);
  const register = (over: Record<string, unknown> = {}) => post("/api/register", goodReg({ inviteCode: code(), ...over }));
  const join = async (over: Record<string, unknown> = {}) => ((await (await register(over)).json()) as { token: string }).token;
  const uploadRaw = (token: string, text: string) => post("/api/usage", text, { Authorization: `Bearer ${token}` });
  const upload = (token: string, records: unknown[]) => uploadRaw(token, JSON.stringify({ records }));
  return { post, register, join, uploadRaw, upload };
}
