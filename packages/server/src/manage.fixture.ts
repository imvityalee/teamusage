import type { Hono } from "hono";
import { expect } from "vitest";
import type { Invite, InviteRole } from "./admin-invites.js";
import { goodReg } from "./app.fixture.js";
import type { Db } from "./db.js";
import { teamsOf } from "./hosted-teams.js";
import { rowsOf } from "./hosted.two-teams.fixture.js";
import {
  grantRole,
  hostedApp,
  hostedTeam,
  machineIdOf,
  memberSignIn,
  postFromPage,
  PUBLIC,
  recordsOf,
  signIn,
  type HostedAppOptions,
} from "./hosted.fixture.js";
import { removeRole } from "./team-roles.js";

/** The moment the world's clock stands at until a test moves it; the default `record()` date is the day before. */
export const T0 = "2026-11-02T09:30:00.000Z";
/** A day in milliseconds, for moving the world's clock. */
export const DAY_MS = 24 * 60 * 60 * 1000;
/** The date range of a stats request that holds every upload of the world. */
export const RANGE = "from=2026-11-01&to=2026-11-02";

export type Who = "ann" | "bob" | "cyd" | "dee" | "eve" | "zoe";
/** The world's GitHub users; no GitHub id equals a row id of the world's database. */
export const PEOPLE: Record<Who, { githubId: number; login: Who }> = {
  ann: { githubId: 1101, login: "ann" },
  bob: { githubId: 2202, login: "bob" },
  cyd: { githubId: 3303, login: "cyd" },
  dee: { githubId: 4404, login: "dee" },
  eve: { githubId: 5505, login: "eve" },
  zoe: { githubId: 6606, login: "zoe" },
};
/** A GitHub user the world has no role or session for; a test gives her a role with `grantRole`. */
export const FAY = { githubId: 7707, login: "fay" };

export type Machine = { id: string; label: string; token: string };
export type ManagedTeam = { id: number; publicId: string; name: string; code: string };
export type ManageWorld = {
  db: Db;
  app: Hono;
  /** The app's clock; a test moves it. */
  clock: { t: number };
  /** The `tu_session` cookie of each GitHub user. */
  cookies: Record<Who, string>;
  A: ManagedTeam & { members: { memberId: number; name: string; email: string; one: Machine }[]; memberSession: string };
  B: ManagedTeam & {
    sam: { memberId: number; name: string; email: string; one: Machine; two: Machine; session: string };
    tia: { memberId: number; name: string; email: string; one: Machine; session: string };
  };
};

/** The id of Sam's machine `one`, which `A`'s first member's machine also has. */
const SAM_ONE_ID = machineIdOf(0xb1);
/** `A`'s five members; the first has Sam's email and the id of Sam's machine `one`. */
const A_MEMBERS = [
  { name: "Ada Quill", email: "sam@example.com", machineId: SAM_ONE_ID, label: "ada-laptop" },
  { name: "Ben Ortiz", email: "ben@example.com", machineId: machineIdOf(0xa2), label: "ben-laptop" },
  { name: "Cleo Park", email: "cleo@example.com", machineId: machineIdOf(0xa3), label: "cleo-laptop" },
  { name: "Dan Wu", email: "dan@example.com", machineId: machineIdOf(0xa4), label: "dan-laptop" },
  { name: "Eli Moss", email: "eli@example.com", machineId: machineIdOf(0xa5), label: "eli-laptop" },
];
const SAM = { name: "Sam", email: "sam@example.com" };
const TIA = { name: "Tia", email: "tia@example.com" };

const githubUsers = () => Object.fromEntries(Object.values(PEOPLE).map((p) => [`code-${p.login}`, { id: p.githubId, login: p.login }]));

type Joiner = { name: string; email: string; machineId: string; label: string };

/** Joins the machine to the team with its code through `/api/register`; returns its member's id and the machine. */
async function join(app: Hono, code: string, j: Joiner): Promise<{ memberId: number; machine: Machine }> {
  const res = await postFromPage(app, "/api/register", goodReg({ inviteCode: code, name: j.name, email: j.email, machineId: j.machineId, machineLabel: j.label }));
  if (res.status !== 200) throw new Error(`joining ${j.label} answered ${res.status}`);
  const { token, memberId } = (await res.json()) as { token: string; memberId: number };
  return { memberId, machine: { id: j.machineId, label: j.label, token } };
}

/** Uploads `rows` records of different models from the machine through `/api/usage`. */
async function upload(app: Hono, machine: Machine, rows: number): Promise<void> {
  const res = await postFromPage(app, "/api/usage", { records: recordsOf(rows) }, { Authorization: `Bearer ${machine.token}` });
  if (res.status !== 200) throw new Error(`uploading from ${machine.label} answered ${res.status}`);
}

/** Team `A`: owner ann, viewer zoe, five members with one machine each; its first member signed in. */
async function teamA(db: Db, app: Hono): Promise<ManageWorld["A"]> {
  const { team, code } = hostedTeam(db, PEOPLE.ann, "members", "Aurora Quillfeather Collective");
  grantRole(db, team.id, PEOPLE.zoe, "viewer");
  const members: ManageWorld["A"]["members"] = [];
  for (const m of A_MEMBERS) {
    const { memberId, machine } = await join(app, code, m);
    members.push({ memberId, name: m.name, email: m.email, one: machine });
  }
  const memberSession = await memberSignIn(app, members[0]!.one.token);
  return { id: team.id, publicId: team.publicId, name: team.name, code, members, memberSession };
}

/** Team `B`: owner bob, admin cyd, viewer dee; Sam with two machines and Tia with one, each with usage, both signed in. */
async function teamB(db: Db, app: Hono): Promise<ManageWorld["B"]> {
  const { team, code } = hostedTeam(db, PEOPLE.bob, "members", "Borealis Zephyrine Guild");
  grantRole(db, team.id, PEOPLE.cyd, "admin");
  grantRole(db, team.id, PEOPLE.dee, "viewer");
  // Tia joins before Sam's second machine: registering a known member's machine uses up a member id.
  const samOne = await join(app, code, { ...SAM, machineId: SAM_ONE_ID, label: "sam-laptop" });
  const tiaOne = await join(app, code, { ...TIA, machineId: machineIdOf(0xb3), label: "tia-laptop" });
  const samTwo = await join(app, code, { ...SAM, machineId: machineIdOf(0xb2), label: "sam-desktop" });
  await upload(app, samOne.machine, 4);
  await upload(app, samTwo.machine, 3);
  await upload(app, tiaOne.machine, 2);
  return {
    id: team.id,
    publicId: team.publicId,
    name: team.name,
    code,
    sam: { memberId: samOne.memberId, ...SAM, one: samOne.machine, two: samTwo.machine, session: await memberSignIn(app, samOne.machine.token) },
    tia: { memberId: tiaOne.memberId, ...TIA, one: tiaOne.machine, session: await memberSignIn(app, tiaOne.machine.token) },
  };
}

/** Signs each of the world's GitHub users in on `app`; returns their `tu_session` cookies. */
async function signInAll(app: Hono): Promise<Record<Who, string>> {
  const cookies = {} as Record<Who, string>;
  for (const who of Object.keys(PEOPLE) as Who[]) cookies[who] = await signIn(app, `code-${who}`);
  return cookies;
}

/**
 * The world of the management tests: a hosted app whose clock stands at `T0` until the test moves it; the six GitHub
 * users of `PEOPLE`, each signed in; team `A` (owner ann, viewer zoe, five members) and then team `B` (owner bob, admin
 * cyd, viewer dee, members Sam and Tia with usage), both on `members`. eve has no role.
 */
export async function manageWorld(o: Omit<HostedAppOptions, "now" | "users"> = {}): Promise<ManageWorld> {
  const clock = { t: Date.parse(T0) };
  const { db, app } = hostedApp({ ...o, now: () => clock.t, users: githubUsers() });
  const cookies = await signInAll(app);
  const A = await teamA(db, app);
  const B = await teamB(db, app);
  return { db, app, clock, cookies, A, B };
}

/** A request as the GitHub user `who` from the server's own pages; a string body is sent as it is, any other as JSON. */
export const asUser = async (w: Pick<ManageWorld, "app" | "cookies">, who: Who, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> =>
  w.app.request(path, {
    method: init.method ?? "GET",
    body: init.body === undefined || typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    headers: { "Content-Type": "application/json", Origin: PUBLIC, Cookie: w.cookies[who] },
  });

/** Checks a refusal: its status, `Cache-Control: no-store` and the body `{ error }`. */
export async function expectAnswer(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error });
}

/** Creates an invite of `role` to `team` as the GitHub user `who` through the route; returns the invite and its token. */
export async function newInvite(w: Pick<ManageWorld, "app" | "cookies">, who: Who, team: { publicId: string }, role: InviteRole): Promise<{ invite: Invite; token: string }> {
  const res = await asUser(w, who, `/api/teams/${team.publicId}/invites`, { method: "POST", body: { role } });
  if (res.status !== 201) throw new Error(`inviting answered ${res.status}`);
  return (await res.json()) as { invite: Invite; token: string };
}

/**
 * A second hosted app on the world's database with another code key, as a server whose operator replaced the key; its
 * GitHub users sign in again; its errors go to `logError`. `as` and `post` send requests to it as a GitHub user.
 */
export async function appOnSameDatabase(db: Db, codeKey: Buffer, logError?: (line: string) => void) {
  const { app } = hostedApp({ db, codeKey, logError, users: githubUsers() });
  const second = { app, cookies: await signInAll(app) };
  return {
    as: (who: Who, path: string) => asUser(second, who, path),
    post: (who: Who, path: string) => asUser(second, who, path, { method: "POST" }),
  };
}

/** How many usage rows team `teamId` holds; only its member `memberId`'s when that is given. */
export const usageRowsOf = (db: Db, teamId: number, memberId?: number): number =>
  rowsOf(db, teamId).usage.filter((u) => memberId === undefined || u.member_id === memberId).length;

/** A team's row of `teams`. */
export const teamRow = (db: Db, teamId: number): unknown => db.prepare("select * from teams where id = ?").get(teamId);

/** A team's `code_hash` and `code_sealed`. */
export const codeRow = (db: Db, teamId: number): unknown => db.prepare("select code_hash, code_sealed from teams where id = ?").get(teamId);

/** A team's rows of `team_roles`, in the order they were inserted. */
export const roleRows = (db: Db, teamId: number): unknown[] => db.prepare("select * from team_roles where team_id = ? order by rowid").all(teamId);

/** Every row of `users`, by id. */
export const userRows = (db: Db): unknown[] => db.prepare("select * from users order by id").all();

/** Gives `n` GitHub users the world has no session for a viewer's role in team `teamId`; their GitHub ids start at 800001. */
export function addViewers(db: Db, teamId: number, n: number): void {
  for (let i = 1; i <= n; i++) grantRole(db, teamId, { githubId: 800_000 + i, login: `viewer-${i}` }, "viewer");
}

/** How many teams the GitHub user owns. */
export const ownedBy = (db: Db, githubId: number): number => teamsOf(db, githubId).filter((t) => t.role === "owner").length;

/** The tables with a `team_id` column, read from the schema so that a table a later step adds is among them. */
function tablesWithTeam(db: Db): string[] {
  const tables = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as { name: string }[];
  return tables
    .map((t) => t.name)
    .filter((name) => (db.pragma(`table_info(${name})`) as { name: string }[]).some((column) => column.name === "team_id"));
}

/** A team's row of `teams` (under `teams`) and its rows of every table that carries a team, all columns, in the order they were inserted. */
export function everythingOf(db: Db, teamId: number): Record<string, unknown[]> {
  const rows: Record<string, unknown[]> = { teams: [teamRow(db, teamId)] };
  for (const table of tablesWithTeam(db)) rows[table] = db.prepare(`select * from ${table} where team_id = ? order by rowid`).all(teamId);
  return rows;
}

/** Removes the role of `who`, an admin or a viewer, in each team of the world, as the product does: with the last role their `users` row goes. */
export function removeRoleRow(w: ManageWorld, who: Who): void {
  for (const team of [w.A, w.B]) removeRole(w.db, team.id, PEOPLE[who].githubId);
}
