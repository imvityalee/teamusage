import { request, type ApiResult } from "../site/http.js";
import { isTeam, type UserTeam } from "../site/session.js";
import { isTeamId } from "../site/team-param.js";

/** The team page's requests: one function for each route of `src/routes-team-settings.ts`. `team` is a checked public id. */

export type TeamInfo = UserTeam;

/** A team the page may draw and build addresses from: the shape of `/api/teams/:team`, with a public id. */
export const isTeamInfo = (v: unknown): v is TeamInfo => isTeam(v) && isTeamId(v.id);

/** "/api/teams/<team><rest>"; throws a RangeError, before any request, for an id that is not 16 lowercase hex characters. */
function teamApi(team: string, rest = ""): string {
  if (!isTeamId(team)) throw new RangeError("a team's public id is 16 lowercase hex characters");
  return `/api/teams/${team}${rest}`;
}

export const getTeam = (team: string): Promise<ApiResult<{ team: TeamInfo }>> => request("GET", teamApi(team));

export const patchTeam = (team: string, changes: { name?: string; dashboardAccess?: TeamInfo["dashboardAccess"] }): Promise<ApiResult<{ team: TeamInfo }>> =>
  request("PATCH", teamApi(team), changes);

export const getCode = (team: string): Promise<ApiResult<{ code: string }>> => request("GET", teamApi(team, "/code"));

export const replaceCode = (team: string): Promise<ApiResult<{ code: string }>> => request("POST", teamApi(team, "/code/rotate"));

export const deleteTeam = (team: string, name: string): Promise<ApiResult<undefined>> => request("POST", teamApi(team, "/delete"), { name });

/** One person's role in a team, as `GET …/roles` names it. `githubId` is who the person is; `login` is only how they are shown. */
export type RoleEntry = { githubId: number; login: string; role: "owner" | "admin" | "viewer"; since: string };

/** An invite not yet used, as the owner's `GET …/invites` names it; the token is never in it. */
export type Invite = { id: string; role: "admin" | "viewer"; createdAt: string; expiresAt: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isDay = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

export const isRoleEntry = (v: unknown): v is RoleEntry =>
  isRecord(v) && Number.isSafeInteger(v.githubId) && typeof v.login === "string" && (v.role === "owner" || v.role === "admin" || v.role === "viewer") && isDay(v.since);

export const isInvite = (v: unknown): v is Invite =>
  isRecord(v) && isTeamId(String(v.id)) && (v.role === "admin" || v.role === "viewer") && isDay(v.createdAt) && isDay(v.expiresAt);

/** The path of an invite or a role: the id is checked before it goes into an address. */
function inviteApi(team: string, id: string): string {
  if (!isTeamId(id)) throw new RangeError("an invite's id is 16 lowercase hex characters");
  return teamApi(team, `/invites/${id}`);
}

function roleApi(team: string, githubId: number): string {
  if (!Number.isSafeInteger(githubId) || githubId <= 0) throw new RangeError("a GitHub id is a positive integer");
  return teamApi(team, `/roles/${githubId}`);
}

export const getRoles = (team: string): Promise<ApiResult<{ roles: RoleEntry[] }>> => request("GET", teamApi(team, "/roles"));

/** The owner's pending invites; any other role is refused. */
export const getInvites = (team: string): Promise<ApiResult<{ invites: Invite[] }>> => request("GET", teamApi(team, "/invites"));

/** A new invite and its token, which the server shows only in this answer. */
export const createInvite = (team: string, role: Invite["role"]): Promise<ApiResult<{ invite: Invite; token: string }>> =>
  request("POST", teamApi(team, "/invites"), { role });

export const cancelInvite = (team: string, id: string): Promise<ApiResult<undefined>> => request("DELETE", inviteApi(team, id));

/** Removes an admin or a viewer (the owner), or the caller's own role (leaving). */
export const removeRole = (team: string, githubId: number): Promise<ApiResult<undefined>> => request("DELETE", roleApi(team, githubId));

/** Makes the admin `githubId` the owner; the caller becomes an admin. */
export const handOver = (team: string, githubId: number): Promise<ApiResult<undefined>> => request("POST", teamApi(team, "/owner"), { user: githubId });
