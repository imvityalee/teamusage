import type { Lang } from "../lang.js";
import type { ApiResult } from "../site/http.js";
import { MAX_ADMINS_AND_VIEWERS } from "../site/limits.js";
import { dashboardPath, isTeamId, teamPath } from "../site/team-param.js";

/** What the server's answers about an invitation mean for `/invite` (src/routes-team-roles.ts). */

export type InviteView = "none" | "notValid" | "signIn" | "accept" | "hasRole" | "teamFull" | "failed";
export type Preview = { team: { name: string }; role: "admin" | "viewer"; expiresAt: string };
/** Why the page could not go on: the server was not reached (network, 5xx), refused with its own text, or answered what the page cannot read. */
export type Failure = { kind: "unreachable" } | { kind: "refused"; error: string } | { kind: "unreadable" };

/** The server's refusals of an accept that the page names in its own words. */
const HAS_ROLE = "you already have a role in this team";
const TEAM_FULL = `this team has reached its limit of ${MAX_ADMINS_AND_VIEWERS} admins and viewers`;

/** Where an accepted invitation leads when the answer does not name a team to open. */
const TEAMS_LIST = "/teams#all";
const ROLES: readonly unknown[] = ["admin", "viewer"];

/** Enough of the preview's shape that the page can draw it: a team name, a role an invitation gives, a day. */
export function isPreview(value: unknown): value is Preview {
  const v = value as { team?: { name?: unknown } | null; role?: unknown; expiresAt?: unknown } | null;
  return typeof v?.team?.name === "string" && ROLES.includes(v.role) && typeof v.expiresAt === "string" && !Number.isNaN(Date.parse(v.expiresAt));
}

/** The page an accepted invitation leads to: the team page for an admin, the dashboard for a viewer, the list of teams otherwise. */
export function acceptedPath(value: unknown): string {
  const team = (value as { team?: { id?: unknown; role?: unknown } | null } | null)?.team;
  if (typeof team?.id !== "string" || !isTeamId(team.id)) return TEAMS_LIST;
  if (team.role === "admin") return teamPath(team.id);
  if (team.role === "viewer") return dashboardPath(team.id);
  return TEAMS_LIST;
}

/** The view an accept that was not answered with a 2xx leads to. */
export function viewAfterRefusal(answer: Exclude<ApiResult<unknown>, { kind: "ok" }>): InviteView {
  if (answer.kind === "unauthorized") return "signIn";
  if (answer.kind !== "refused") return "failed";
  if (answer.status === 404) return "notValid";
  if (answer.status === 409 && answer.error === HAS_ROLE) return "hasRole";
  if (answer.status === 409 && answer.error === TEAM_FULL) return "teamFull";
  return "failed";
}

/** The failure an answer that the page could not go on with stands for. `failed` of `request` is a 5xx or a 2xx that is not JSON. */
export function failureOf(answer: ApiResult<unknown>): Failure {
  if (answer.kind === "refused" && answer.status < 500) return { kind: "refused", error: answer.error };
  if (answer.kind === "ok") return { kind: "unreadable" };
  return { kind: "unreachable" };
}
