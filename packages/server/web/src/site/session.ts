import { request } from "./http.js";

export type Me =
  | {
      kind: "user";
      githubId: number;
      login: string;
      teams: { id: string; name: string; role: "owner" | "admin" | "viewer"; dashboardAccess: "members" | "admins" }[];
    }
  | { kind: "member"; team: { id: string; name: string }; memberId: number };

export type MeAnswer = { kind: "me"; me: Me } | { kind: "none" } | { kind: "noAccounts" } | { kind: "failed" };

export const SIGN_IN_PATH = "/auth/github/start";

/** True when the address carries `?error=signin`: the server's answer to a GitHub sign-in that did not finish. */
export const signInDidNotFinish = (search: string): boolean => new URLSearchParams(search).get("error") === "signin";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ROLES: readonly unknown[] = ["owner", "admin", "viewer"];
const ACCESS: readonly unknown[] = ["members", "admins"];

const isTeam = (t: unknown): boolean =>
  isRecord(t) && typeof t.id === "string" && typeof t.name === "string" && ROLES.includes(t.role) && ACCESS.includes(t.dashboardAccess);

/** Enough of the shape that a page can draw it without throwing; the values are still drawn as text. */
function isMe(v: unknown): v is Me {
  if (!isRecord(v)) return false;
  if (v.kind === "user") {
    return typeof v.githubId === "number" && typeof v.login === "string" && Array.isArray(v.teams) && v.teams.every(isTeam);
  }
  return v.kind === "member" && isRecord(v.team) && typeof v.team.id === "string" && typeof v.team.name === "string" && typeof v.memberId === "number";
}

/** Who this browser is signed in as. `none`: nobody. `noAccounts`: the server has no `/api/me` (404), which is a self-hosted server. */
export async function me(): Promise<MeAnswer> {
  const answer = await request<unknown>("GET", "/api/me");
  if (answer.kind === "ok") return isMe(answer.value) ? { kind: "me", me: answer.value } : { kind: "failed" };
  if (answer.kind === "unauthorized") return { kind: "none" };
  if (answer.kind === "refused" && answer.status === 404) return { kind: "noAccounts" };
  return { kind: "failed" };
}

/** Ends this browser's session: POST /api/logout. True when the session is over (a 401 means it already was); false when it may still be there. */
export async function signOut(): Promise<boolean> {
  const answer = await request("POST", "/api/logout");
  return answer.kind === "ok" || answer.kind === "unauthorized";
}
