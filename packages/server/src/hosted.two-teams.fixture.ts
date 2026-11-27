import type { Hono } from "hono";
import { goodReg, MID, record } from "./app.fixture.js";
import type { Db } from "./db.js";
import { teamByPublicId } from "./hosted-teams.js";
import { hostedApp, memberSignIn, PUBLIC, signIn, type HostedAppOptions } from "./hosted.fixture.js";

/** Names the caller of a request; the two teams' app limits failed attempts per caller, as if each had its own address. */
const CALLER_HEADER = "x-test-caller";

export const CALLERS = ["nobody", "machineA", "machineB", "memberA", "ann", "bob", "eve"] as const;
export type CallerName = (typeof CALLERS)[number];
export type TeamKey = "A" | "B";

/** The email and machine id of both teams' member. */
export const SAME_EMAIL = "same.person@example.com";
/** The date range of every stats request; each team's one upload falls inside it. */
export const STATS_RANGE = "from=2026-11-01&to=2026-11-10";
const UPLOAD_DAY = "2026-11-03";

/** Team A's members see its numbers (owner ann); team B's numbers are for its admins only (owner bob). */
const SPEC = {
  A: { owner: "ann", teamName: "Aurora Quillfeather Collective", access: "members", memberName: "Ottoline Quaxley", machineLabel: "quaxley-aardvark-laptop", total: 10, costUsd: 0.25 },
  B: { owner: "bob", teamName: "Borealis Zephyrine Guild", access: "admins", memberName: "Zebulon Vexworth", machineLabel: "vexworth-zebra-workstation", total: 700, costUsd: 7.5 },
} as const;

/** One of the two teams, with every value that marks it. */
export type Team = {
  id: number;
  publicId: string;
  name: string;
  code: string;
  memberId: number;
  memberName: string;
  machineLabel: string;
  total: number;
  costUsd: number;
};

export type Caller = { name: CallerName; headers: Record<string, string> };
export type World = { db: Db; app: Hono; teams: Record<TeamKey, Team>; callers: Record<CallerName, Caller> };

/** A request as `caller`: its credential, its own client address, the server's origin and a JSON body. */
export async function requestAs(app: Hono, caller: Caller, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return app.request(path, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { "Content-Type": "application/json", Origin: PUBLIC, [CALLER_HEADER]: caller.name, ...caller.headers },
  });
}

/** The parsed body of a set-up request that must answer `status`. */
async function expectAnswer<T>(res: Promise<Response>, status: number, what: string): Promise<T> {
  const answer = await res;
  if (answer.status !== status) throw new Error(`${what} answered ${answer.status}`);
  return (await answer.json()) as T;
}

/** Creates the team `key` as its owner, registers its member's machine and uploads one record; returns the machine's token. */
async function setUpTeam(world: Pick<World, "db" | "app">, ownerCookie: string, key: TeamKey): Promise<{ team: Team; token: string }> {
  const s = SPEC[key];
  const setUp: Caller = { name: s.owner, headers: { Cookie: ownerCookie } };
  const send = (path: string, body: unknown, caller = setUp) => requestAs(world.app, caller, path, { method: "POST", body });
  const created = await expectAnswer<{ team: { id: string }; code: string }>(
    send("/api/teams", { name: s.teamName, dashboardAccess: s.access }), 201, `creating team ${key}`);
  const reg = goodReg({ inviteCode: created.code, name: s.memberName, email: SAME_EMAIL, machineId: MID, machineLabel: s.machineLabel });
  const joined = await expectAnswer<{ token: string; memberId: number }>(send("/api/register", reg), 200, `joining team ${key}`);
  const machine: Caller = { name: s.owner, headers: { Authorization: `Bearer ${joined.token}` } };
  const upload = { records: [record({ date: UPLOAD_DAY, input: s.total - 9, total: s.total, costUsd: s.costUsd })] };
  await expectAnswer(send("/api/usage", upload, machine), 200, `uploading to team ${key}`);
  const id = teamByPublicId(world.db, created.team.id)?.id;
  if (id === undefined) throw new Error(`team ${key} is missing`);
  const { teamName: name, memberName, machineLabel, total, costUsd } = s;
  return { team: { id, publicId: created.team.id, name, code: created.code, memberId: joined.memberId, memberName, machineLabel, total, costUsd }, token: joined.token };
}

/**
 * Two hosted teams on one server, each with a member of the same email and machine id and one upload, and the
 * callers of the isolation suite: no credential, each team's machine token, the session of A's member signed in from
 * its machine, the GitHub sessions of both owners, and a GitHub session with no team. `o` gives the app its limits and
 * clocks.
 */
export async function twoTeams(o: Omit<HostedAppOptions, "clientKey"> = {}): Promise<World> {
  const { db, app } = hostedApp({ ...o, clientKey: (c) => c.req.header(CALLER_HEADER) ?? "" });
  const [ann, bob, eve] = [await signIn(app, "code-ann"), await signIn(app, "code-bob"), await signIn(app, "code-eve")];
  const a = await setUpTeam({ db, app }, ann, "A");
  const b = await setUpTeam({ db, app }, bob, "B");
  const memberA = await memberSignIn(app, a.token);
  const caller = (name: CallerName, headers: Record<string, string> = {}): Caller => ({ name, headers });
  const callers: Record<CallerName, Caller> = {
    nobody: caller("nobody"),
    machineA: caller("machineA", { Authorization: `Bearer ${a.token}` }),
    machineB: caller("machineB", { Authorization: `Bearer ${b.token}` }),
    memberA: caller("memberA", { Cookie: memberA }),
    ann: caller("ann", { Cookie: ann }),
    bob: caller("bob", { Cookie: bob }),
    eve: caller("eve", { Cookie: eve }),
  };
  return { db, app, teams: { A: a.team, B: b.team }, callers };
}

type Row = Record<string, unknown>;
export type TeamRows = { members: Row[]; machines: Row[]; usage: Row[] };

/** Team `teamId`'s row of usage counts, which `rowsOf` does not read. */
export const countRowOf = (db: Db, teamId: number) => db.prepare("select * from usage_counts where team_id = ?").get(teamId);

/** Every row of team `teamId` in members, machines and usage, all columns, in the order they were inserted. */
export function rowsOf(db: Db, teamId: number): TeamRows {
  const all = (table: string) => db.prepare(`select * from ${table} where team_id = ? order by rowid`).all(teamId) as Row[];
  return { members: all("members"), machines: all("machines"), usage: all("usage") };
}
