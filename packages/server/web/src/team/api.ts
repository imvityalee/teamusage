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
