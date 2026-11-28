import { json } from "../site/page.fixture.js";
import type { Invite, RoleEntry, TeamInfo } from "./api.js";

/** People and invites of a team's roles for the tests (tests only). The viewer of the page is `ME`: `user()` of the page fixture. */

/** The GitHub id `user()` of `site/page.fixture.ts` gives the signed-in person, and the login `page.fixture.ts` calls them. */
export const ME = 9_104_227;
export const ME_LOGIN = "acme-admin";

const entry = (githubId: number, login: string, role: RoleEntry["role"], since: string): RoleEntry => ({ githubId, login, role, since });

export const OWNER = entry(4_001, "acme-owner", "owner", "2026-09-02T12:00:00.000Z");
export const ADMIN = entry(4_002, "aigerim-t", "admin", "2026-09-03T12:00:00.000Z");
export const OTHER_ADMIN = entry(4_003, "bakyt-s", "admin", "2026-09-04T12:00:00.000Z");
export const VIEWER = entry(4_004, "nurlan-b", "viewer", "2026-10-14T12:00:00.000Z");
/** The person at the page, as the team's owner or as one of its admins. */
export const MY_OWNER = entry(ME, ME_LOGIN, "owner", "2026-08-30T12:00:00.000Z");
export const MY_ADMIN = entry(ME, ME_LOGIN, "admin", "2026-09-05T12:00:00.000Z");

export const PENDING: Invite = { id: "ab12cd34ef567890", role: "admin", createdAt: "2026-11-27T09:00:00.000Z", expiresAt: "2026-12-04T09:00:00.000Z" };
export const PENDING_VIEWER: Invite = { id: "cd34ef567890ab12", role: "viewer", createdAt: "2026-11-20T09:00:00.000Z", expiresAt: "2026-11-27T09:00:00.000Z" };

/** What the invite dialog shows once, and what it must never leave behind. */
export const TOKEN = "0123456789abcdef".repeat(4);

export const rolesReply = (roles: RoleEntry[]) => json({ roles });
export const invitesReply = (invites: Invite[]) => json({ invites });

/** The answers the roles card gets when the page opens for someone of `role`: the roles of a small team, and for an owner no invites. */
export function listReplies(role: TeamInfo["role"]) {
  return role === "owner" ? [rolesReply([MY_OWNER, ADMIN]), invitesReply([])] : [rolesReply([OWNER, MY_ADMIN])];
}
