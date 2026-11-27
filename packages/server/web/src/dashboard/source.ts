import { teamParam } from "../site/team-param.js";

/** Where the dashboard's statistics come from: a self-hosted server, the demo, or a team on a hosted server. */

export type Source = { kind: "selfHosted" } | { kind: "demo" } | { kind: "hosted"; team: string | null };

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
