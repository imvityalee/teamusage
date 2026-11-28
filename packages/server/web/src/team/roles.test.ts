import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { INVITE_DAYS as SERVER_DAYS, MAX_PENDING_INVITES as SERVER_PENDING } from "../../../src/admin-invites.js";
import { MAX_TEAMS_PER_USER as SERVER_TEAMS } from "../../../src/hosted-teams.js";
import { MAX_ADMINS_AND_VIEWERS as PAGE_ADMINS } from "../site/limits.js";
import { MAX_ADMINS_AND_VIEWERS as SERVER_ADMINS } from "../../../src/team-roles.js";
import { actionsFor, countOf, initialsOf, inviteLink, INVITE_DAYS, MAX_PENDING_INVITES, MAX_TEAMS_PER_USER, REFUSALS, sortRoles } from "./roles.js";
import { ADMIN, OTHER_ADMIN, OWNER, TOKEN, VIEWER } from "./roles.fixture.js";

test.each([
  ["the owner looking at an admin", ADMIN, { githubId: OWNER.githubId, role: "owner" }, ["remove", "makeOwner"]],
  ["the owner looking at a viewer", VIEWER, { githubId: OWNER.githubId, role: "owner" }, ["remove"]],
  ["the owner looking at themselves", OWNER, { githubId: OWNER.githubId, role: "owner" }, []],
  ["an admin looking at themselves", ADMIN, { githubId: ADMIN.githubId, role: "admin" }, ["leave"]],
  ["an admin looking at another admin", OTHER_ADMIN, { githubId: ADMIN.githubId, role: "admin" }, []],
  ["an admin looking at a viewer", VIEWER, { githubId: ADMIN.githubId, role: "admin" }, []],
  ["an admin looking at the owner", OWNER, { githubId: ADMIN.githubId, role: "admin" }, []],
] as const)("%s", (_, row, mine, actions) => expect(actionsFor(row, { ...mine })).toEqual(actions));

test("who a row is is decided by the GitHub id, not by the login", () => {
  const sameLogin = { ...VIEWER, login: ADMIN.login };
  expect(actionsFor(sameLogin, { githubId: ADMIN.githubId, role: "admin" })).toEqual([]);
  expect(actionsFor(ADMIN, { githubId: sameLogin.githubId, role: "owner" })).toEqual(["remove", "makeOwner"]);
});

test("the invite's link carries the token in the fragment", () => {
  expect(inviteLink("https://teamusage.example", TOKEN)).toBe(`https://teamusage.example/invite#${TOKEN}`);
});

test("the owner comes first, then admins, then viewers, each by login", () => {
  const zed = { ...ADMIN, githubId: 1, login: "Zed" };
  const sorted = sortRoles([VIEWER, zed, OWNER, OTHER_ADMIN, ADMIN]);
  expect(sorted.map((r) => r.login)).toEqual([OWNER.login, ADMIN.login, OTHER_ADMIN.login, "Zed", VIEWER.login]);
});

test("two rows with one login keep a fixed order, by GitHub id", () => {
  const twin = { ...ADMIN, githubId: ADMIN.githubId - 1 };
  expect(sortRoles([ADMIN, twin]).map((r) => r.githubId)).toEqual([twin.githubId, ADMIN.githubId]);
  expect(sortRoles([twin, ADMIN]).map((r) => r.githubId)).toEqual([twin.githubId, ADMIN.githubId]);
});

test("the count is of admins and viewers: the owner is not in it", () => {
  expect(countOf([OWNER])).toBe(0);
  expect(countOf([OWNER, ADMIN, VIEWER])).toBe(2);
});

test.each([
  ["acme-admin", "AA"],
  ["aigerim_t", "AT"],
  ["nurlan.b", "NB"],
  ["octocat", "OC"],
  ["x", "X"],
  ["-a-", "A"],
])("the initials of %s are %s", (login, initials) => expect(initialsOf(login)).toBe(initials));

const routes = readFileSync(new URL("../../../src/routes-team-roles.ts", import.meta.url), "utf8");

test("the page's copies of the server's limits are the server's", () => {
  expect([MAX_PENDING_INVITES, PAGE_ADMINS, MAX_TEAMS_PER_USER, INVITE_DAYS]).toEqual([SERVER_PENDING, SERVER_ADMINS, SERVER_TEAMS, SERVER_DAYS]);
  expect(new Set([MAX_PENDING_INVITES, PAGE_ADMINS, MAX_TEAMS_PER_USER, INVITE_DAYS]).size).toBe(4);
});

test("each refusal the card matches is the text the server's route file holds", () => {
  expect(routes).toContain(`error: "${REFUSALS.notAnAdmin}"`);
  expect(routes).toContain(`error: \`${REFUSALS.ownsMost.replace(String(SERVER_TEAMS), "${MAX_TEAMS_PER_USER}")}\``);
  expect(routes).toContain(`error: \`${REFUSALS.pendingFull.replace(String(SERVER_PENDING), "${MAX_PENDING_INVITES}")}\``);
  expect(routes).toContain(`const ROLE_NOT_FOUND = "${REFUSALS.roleNotFound}"`);
  expect(routes).toContain(`const INVITE_NOT_FOUND = "${REFUSALS.inviteNotFound}"`);
});
