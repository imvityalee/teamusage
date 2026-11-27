import type { Me } from "../site/session.js";
import { isTeamId, teamParam } from "../site/team-param.js";

/** Where the dashboard's statistics come from: a self-hosted server, the demo, or a team on a hosted server. */

export type Source = { kind: "selfHosted" } | { kind: "demo" } | { kind: "hosted"; team: string | null };

type UserTeam = Extract<Me, { kind: "user" }>["teams"][number];

/** `/demo` is the demo and `/dashboard` a hosted team (`team` from `?team=`); every other path is the self-hosted dashboard. */
export function sourceOf(loc: { pathname: string; search: string }): Source {
  if (loc.pathname === "/demo") return { kind: "demo" };
  if (loc.pathname === "/dashboard") return { kind: "hosted", team: teamParam(loc.search) };
  return { kind: "selfHosted" };
}

/** Where this source's statistics are asked for: "/api/demo/stats" or "/api/stats", with `team` added for a hosted team that names one. */
export function statsUrl(source: Source, query: URLSearchParams): string {
  if (source.kind === "demo") return `/api/demo/stats?${query}`;
  const params = new URLSearchParams(query);
  if (source.kind === "hosted" && source.team !== null) params.set("team", source.team);
  return `/api/stats?${params}`;
}

/** The team of a GitHub user's session the dashboard shows: the one `?team=` names when it is theirs; without `?team=`, their only team. */
export function userTeam(team: string | null, teams: readonly UserTeam[]): UserTeam | undefined {
  const usable = teams.filter((t) => isTeamId(t.id));
  if (team !== null) return usable.find((t) => t.id === team);
  return usable.length === 1 ? usable[0] : undefined;
}

/** The hosted source once the session is known: a member's session reads its own team and names none; a GitHub user's names theirs. */
export function sessionSource(source: Extract<Source, { kind: "hosted" }>, me: Me): Source {
  if (me.kind === "member") return { kind: "hosted", team: null };
  return { kind: "hosted", team: userTeam(source.team, me.teams)?.id ?? null };
}
