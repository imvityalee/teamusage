import { expect } from "vitest";
import { KEY, PUBLIC, dashboardLinkToken } from "./hosted.fixture.js";
import { everythingOf, manageWorld, newInvite, PEOPLE, send as sendRaw, teamRow, userRows, type ManageWorld } from "./manage.fixture.js";
import { ROLE_NOT_ALLOWED, TEAM_NOT_FOUND } from "./team-access.js";
import { teamCode } from "./team-settings.js";

/** The callers of the management table, in the order of its columns. */
export const CALLERS = ["nobody", "machineA", "machineB", "memberA", "memberB", "ann", "zoe", "eve", "dee", "cyd", "bob", "bobElsewhere"] as const;
export type CallerName = (typeof CALLERS)[number];
type TeamKey = "A" | "B";

/** The GitHub users with no role in `B`: ann owns `A`, zoe is its viewer, eve has no role. */
export const OUTSIDERS: readonly CallerName[] = ["ann", "zoe", "eve"];
/** A well-formed public id that no team has. */
export const NO_SUCH_TEAM = "0123456789abcdef";
/** The name `B` is renamed to; it holds `B`'s first name, so a check for that name finds this one too. */
const RENAMED = "Borealis Zephyrine Guild Renamed";
/** An origin that is not the server's: bob's browser on another site. */
const ELSEWHERE = "https://elsewhere.example";

/** The world of the table, with what its cells need besides: two pending invites of `B` that bob made through the route, and the newest sign-in link. */
export type Scene = { w: ManageWorld; acceptToken: string; cancelId: string; link: string };

/** The world of the management tests, with two invites of `B` as viewers: one to accept, one to cancel. */
export async function manageScene(): Promise<Scene> {
  const w = await manageWorld();
  const accept = await newInvite(w, "bob", w.B, "viewer");
  const cancel = await newInvite(w, "bob", w.B, "viewer");
  return { w, acceptToken: accept.token, cancelId: cancel.invite.id, link: "" };
}

/** The credential of each caller as headers; bobElsewhere is bob's session sent from another site. */
function credentialOf(w: ManageWorld, caller: CallerName): Record<string, string> {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  switch (caller) {
    case "nobody":
      return {};
    case "machineA":
      return bearer(w.A.members[0]!.one.token);
    case "machineB":
      return bearer(w.B.sam.one.token);
    case "memberA":
      return { Cookie: w.A.memberSession };
    case "memberB":
      return { Cookie: w.B.sam.session };
    case "bobElsewhere":
      return { Cookie: w.cookies.bob, Origin: ELSEWHERE };
    default:
      return { Cookie: w.cookies[caller] };
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** How a row's request is made, and what its cells need besides. */
type RowRequest = {
  /** The path; a route that names a team names `team`. Without it, the route's own path. */
  path?: (team: string, s: Scene) => string;
  /** A body that would succeed for `B`'s owner. */
  body?: (s: Scene) => unknown;
  /** Runs before each cell: makes what a cell uses up. */
  prepare?: (s: Scene) => Promise<void>;
  /** Runs after the cell that succeeds: puts back the roles the next cells are written for. */
  restore?: (s: Scene) => Promise<void>;
  /** True when the one cell that succeeds uses the thing up; the callers answered 404 ask after it. */
  oneUse?: boolean;
  /** The team whose rows a successful cell changes; `B` unless given. */
  actsOn?: (caller: CallerName) => TeamKey;
};

export type Route = RowRequest & {
  /** The method and the route, and what tells two rows of one route apart. */
  name: string;
  method: Method;
  path: (team: string, s: Scene) => string;
  namesTeam: boolean;
  /** Each caller's status, in the order of CALLERS. */
  statuses: number[];
};

/** A row of the table: the method and path are read from `name`, "METHOD /path (what)". */
function row(name: string, statuses: number[], request: RowRequest = {}): Route {
  const [method, routePath] = name.split(" ") as [Method, string];
  return { ...request, name, method, statuses, namesTeam: routePath.startsWith("/api/teams/"), path: request.path ?? (() => routePath) };
}

const team = (suffix = "") => (publicId: string) => `/api/teams/${publicId}${suffix}`;

/** Makes the next sign-in link of Tia's machine. */
const newLink = async (s: Scene): Promise<void> => {
  s.link = await dashboardLinkToken(s.w.app, s.w.B.tia.one.token);
};

/** cyd, owner once bob has handed `B` over, hands it back. */
const handBack = async (s: Scene): Promise<void> => {
  const res = await sendRaw(s.w, "POST", team("/owner")(s.w.B.publicId), { user: PEOPLE.bob.githubId }, { Origin: PUBLIC, Cookie: s.w.cookies.cyd });
  expect(res.status, "cyd hands B back to bob").toBe(204);
};

/**
 * One row per route of the plan, on team `B`, in the order their successful cells run: signing in, reads, renaming,
 * the code, invites, roles, removals, deletion. PATCH has two rows: a rename, and a change of dashboard access.
 */
export const ROUTES: Route[] = [
  //                                             nobody mA   mB   memA memB ann  zoe  eve  dee  cyd  bob  bobElsewhere
  row("POST /api/dashboard-link",                 [401, 200, 200, 401, 401, 401, 401, 401, 401, 401, 401, 401],
    { actsOn: (caller) => (caller === "machineA" ? "A" : "B") }),
  row("POST /api/dashboard-link/open",            [204, 204, 204, 204, 204, 204, 204, 204, 204, 204, 204, 403],
    { body: (s) => ({ token: s.link }), prepare: newLink }),
  row("GET /api/teams/:team",                     [401, 401, 401, 401, 401, 404, 404, 404, 200, 200, 200, 200], { path: team() }),
  row("GET /api/teams/:team/code",                [401, 401, 401, 401, 401, 404, 404, 404, 403, 200, 200, 200], { path: team("/code") }),
  row("GET /api/teams/:team/members",             [401, 401, 401, 401, 401, 404, 404, 404, 403, 200, 200, 200], { path: team("/members") }),
  row("GET /api/teams/:team/roles",               [401, 401, 401, 401, 401, 404, 404, 404, 403, 200, 200, 200], { path: team("/roles") }),
  row("GET /api/teams/:team/invites",             [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 200, 200], { path: team("/invites") }),
  row("PATCH /api/teams/:team (name)",            [401, 401, 401, 401, 401, 404, 404, 404, 403, 200, 200, 403],
    { path: team(), body: () => ({ name: RENAMED }) }),
  row("PATCH /api/teams/:team (dashboardAccess)", [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 200, 403],
    { path: team(), body: () => ({ dashboardAccess: "members" }) }),
  row("POST /api/teams/:team/code/rotate",        [401, 401, 401, 401, 401, 404, 404, 404, 403, 200, 200, 403], { path: team("/code/rotate") }),
  row("POST /api/teams/:team/invites",            [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 201, 403],
    { path: team("/invites"), body: () => ({ role: "viewer" }) }),
  row("POST /api/invites/accept",                 [401, 401, 401, 401, 401, 404, 404, 200, 409, 409, 409, 403],
    { body: (s) => ({ token: s.acceptToken }), oneUse: true }),
  row("DELETE /api/teams/:team/invites/:id",      [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 204, 403],
    { path: (t, s) => team(`/invites/${s.cancelId}`)(t) }),
  // eve's role: she is a viewer of B once she has accepted its invite.
  row("DELETE /api/teams/:team/roles/:user",      [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 204, 403],
    { path: team(`/roles/${PEOPLE.eve.githubId}`) }),
  row("POST /api/teams/:team/owner",              [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 204, 403],
    { path: team("/owner"), body: () => ({ user: PEOPLE.cyd.githubId }), restore: handBack }),
  row("POST /api/teams/:team/removals",           [401, 401, 401, 401, 401, 404, 404, 404, 403, 200, 200, 403],
    { path: team("/removals"), body: (s) => ({ members: [s.w.B.tia.memberId], machines: [s.w.B.sam.two.id], rotateCode: true }) }),
  row("POST /api/teams/:team/delete",             [401, 401, 401, 401, 401, 404, 404, 404, 403, 403, 204, 403],
    { path: team("/delete"), body: (s) => ({ name: currentName(s) }) }),
];

/** `B`'s name as it stands. */
const currentName = (s: Scene): string => (teamRow(s.w.db, s.w.B.id) as { name: string }).name;

export const routeNamed = (name: string): Route => ROUTES.find((r) => r.name === name)!;
export const statusOf = (route: Route, caller: CallerName): number => route.statuses[CALLERS.indexOf(caller)]!;
const succeeds = (route: Route, caller: CallerName): boolean => statusOf(route, caller) < 300;

/**
 * The cells that succeed, row by row in the order of ROUTES and caller by caller in the order of CALLERS; after the one
 * cell of a row that uses its thing up come the callers that row answers 404.
 */
export const SUCCESS_ORDER: [string, CallerName][] = ROUTES.flatMap((r) => {
  const after = r.oneUse ? CALLERS.filter((c) => statusOf(r, c) === 404) : [];
  return [...CALLERS.filter((c) => succeeds(r, c)), ...after].map((c): [string, CallerName] => [r.name, c]);
});

/** The text of a refusal: 409 is accepting an invite of `B` with a role in `B`. */
function errorOf(route: Route, caller: CallerName, status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return caller === "bobElsewhere" ? "cross-site request refused" : ROLE_NOT_ALLOWED;
  if (status === 404) return route.namesTeam ? TEAM_NOT_FOUND : "this invite is no longer valid";
  return "you already have a role in this team";
}

/** The cell's request as `caller`, on team `publicId` (`B` unless given). */
export async function send(s: Scene, route: Route, caller: CallerName, publicId = s.w.B.publicId): Promise<Response> {
  const body = route.body?.(s);
  return s.w.app.request(route.path(publicId, s), {
    method: route.method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: PUBLIC, ...credentialOf(s.w, caller) },
  });
}

/** Both teams' rows in every table that carries a team, and every row of `users`. */
export const rowsOfBoth = (w: ManageWorld) => ({ A: everythingOf(w.db, w.A.id), B: everythingOf(w.db, w.B.id), users: userRows(w.db) });

/** What marks `B` in an answer: its public id, name, code, its members' names and emails, its machines' labels and its people's logins. */
export function markersOfB(s: Scene): string[] {
  const { B } = s.w;
  const code = teamCode(s.w.db, B.id, KEY);
  const machines = [B.sam.one, B.sam.two, B.tia.one].map((m) => m.label);
  return [B.publicId, B.name, B.code, ...(code ? [code] : []), B.sam.name, B.sam.email, B.tia.name, B.tia.email, ...machines, "bob", "cyd", "dee"];
}

/** What marks `A`: its public id, name and code, and its members' names and machines' labels. */
export function markersOfA(w: ManageWorld): string[] {
  return [w.A.publicId, w.A.name, w.A.code, ...w.A.members.flatMap((m) => [m.name, m.one.label])];
}

/** Checks that `text`, the answer `what`, holds none of `markers`. */
export function expectNothingOf(text: string, markers: string[], what: string): void {
  for (const marker of markers) expect(text, `${what} holds ${marker}`).not.toContain(marker);
}

/** Checks a refused cell: its status, `no-store`, its text, and that both teams' rows and the users are as `before`; returns the answer's text. */
export async function expectRefused(s: Scene, route: Route, caller: CallerName, res: Response, before: ReturnType<typeof rowsOfBoth>): Promise<string> {
  const status = statusOf(route, caller);
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: errorOf(route, caller, status) });
  expect(rowsOfBoth(s.w)).toEqual(before);
  return text;
}
