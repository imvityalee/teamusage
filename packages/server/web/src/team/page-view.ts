import type { ApiResult } from "../site/http.js";
import type { MeAnswer } from "../site/session.js";
import { isTeamInfo, type TeamInfo } from "./api.js";

/** What the team page shows before any card: the cards, or one of the panels. */
export type TeamPageView = "page" | "signedOut" | "notFound" | "viewer" | "failed";

/**
 * The view of `GET /api/teams/:team`'s answer for the team `?team=` names (null: no valid id, and nothing was asked).
 * A 404 and a 403 read alike, so the page tells nobody whether a team they have no role in exists.
 */
export function teamPageView(team: string | null, result: ApiResult<{ team: TeamInfo }> | null): TeamPageView {
  if (team === null || result === null) return "notFound";
  if (result.kind === "unauthorized") return "signedOut";
  if (result.kind === "refused" && (result.status === 404 || result.status === 403)) return "notFound";
  if (result.kind !== "ok" || !isTeamInfo(result.value?.team) || result.value.team.id !== team) return "failed";
  return result.value.team.role === "viewer" ? "viewer" : "page";
}

/** The view once the session is read too: a session that could not be read is `failed`; only a GitHub user reaches the team. */
export function startView(team: string | null, session: MeAnswer, result: ApiResult<{ team: TeamInfo }> | null): TeamPageView {
  if (session.kind === "failed" || session.kind === "noAccounts") return "failed";
  if (session.kind === "none" || session.me.kind !== "user") return "signedOut";
  return teamPageView(team, result);
}
