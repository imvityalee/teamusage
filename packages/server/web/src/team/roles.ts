import type { RoleEntry, TeamInfo } from "./api.js";

/** What the team page decides about the people of a team, with no page in it: who may do what to whom, the order, the link. */

export type RoleAction = "remove" | "makeOwner" | "leave";

/** The server's limits that the card's sentences name; a test compares each with the server's own. */
export const MAX_PENDING_INVITES = 20;
export const MAX_TEAMS_PER_USER = 5;
/** How long an invite works, in days (`INVITE_DAYS` of the server). */
export const INVITE_DAYS = 7;

/** The server's refusals the card answers in its own words or by loading the list again (`src/routes-team-roles.ts`, which a test compares). */
export const REFUSALS = {
  pendingFull: `this team has ${MAX_PENDING_INVITES} pending invites; cancel one first`,
  notAnAdmin: "ownership goes to an admin of this team",
  ownsMost: `that user already owns ${MAX_TEAMS_PER_USER} teams`,
  roleNotFound: "role not found",
  inviteNotFound: "invite not found",
} as const;

/** What the viewer of the page may do to this row: an owner removes anyone else and makes an admin the owner; anyone but the owner leaves through their own row. */
export function actionsFor(row: RoleEntry, mine: { githubId: number; role: TeamInfo["role"] }): RoleAction[] {
  if (row.githubId === mine.githubId) return mine.role === "owner" ? [] : ["leave"];
  if (mine.role !== "owner") return [];
  if (row.role === "admin") return ["remove", "makeOwner"];
  return row.role === "viewer" ? ["remove"] : [];
}

/** The address an invited person opens: `<origin>/invite#<token>`. The token is in the fragment, which no request carries. */
export const inviteLink = (origin: string, token: string): string => `${origin}/invite#${token}`;

const RANK: Record<RoleEntry["role"], number> = { owner: 0, admin: 1, viewer: 2 };

/** The owner first, then admins, then viewers, each by login (and by GitHub id, so that equal logins keep one order). */
export function sortRoles(roles: readonly RoleEntry[]): RoleEntry[] {
  return [...roles].sort((a, b) => RANK[a.role] - RANK[b.role] || a.login.localeCompare(b.login, "en") || a.githubId - b.githubId);
}

/** How many admins and viewers there are: everyone but the owner. */
export const countOf = (roles: readonly RoleEntry[]): number => roles.filter((r) => r.role !== "owner").length;

/** Two letters for a login's mark: the first letters of its first two words ("acme-admin" is AA), or its first two letters. */
export function initialsOf(login: string): string {
  const [first = "", second] = login.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = second === undefined ? Array.from(first).slice(0, 2) : [Array.from(first)[0], Array.from(second)[0]];
  return letters.join("").toUpperCase();
}
