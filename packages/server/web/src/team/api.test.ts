import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json } from "../site/page.fixture.js";
import {
  cancelInvite, createInvite, deleteTeam, getCode, getInvites, getRoles, getTeam, handOver, isInvite, isRoleEntry, isTeamInfo, patchTeam, removeRole, replaceCode,
} from "./api.js";

const T = "0f1e2d3c4b5a6978";
let fetched: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetched = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetched);
});
afterEach(() => vi.unstubAllGlobals());

const sent = () => {
  const [url, init] = fetched.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init.credentials };
};

test.each<[string, () => Promise<unknown>, { url: string; method: string; body: unknown }]>([
  ["getTeam", () => getTeam(T), { url: `/api/teams/${T}`, method: "GET", body: undefined }],
  ["patchTeam with a name", () => patchTeam(T, { name: "Acme" }), { url: `/api/teams/${T}`, method: "PATCH", body: { name: "Acme" } }],
  ["patchTeam with an access", () => patchTeam(T, { dashboardAccess: "admins" }), { url: `/api/teams/${T}`, method: "PATCH", body: { dashboardAccess: "admins" } }],
  ["getCode", () => getCode(T), { url: `/api/teams/${T}/code`, method: "GET", body: undefined }],
  ["replaceCode", () => replaceCode(T), { url: `/api/teams/${T}/code/rotate`, method: "POST", body: undefined }],
  ["deleteTeam", () => deleteTeam(T, "Acme"), { url: `/api/teams/${T}/delete`, method: "POST", body: { name: "Acme" } }],
])("%s sends its method, path and body, same-origin", async (_name, call, expected) => {
  await call();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(sent()).toEqual({ ...expected, credentials: "same-origin" });
});

test.each<[string, (team: string) => Promise<unknown>]>([
  ["getTeam", (team) => getTeam(team)],
  ["patchTeam", (team) => patchTeam(team, { name: "Acme" })],
  ["getCode", (team) => getCode(team)],
  ["replaceCode", (team) => replaceCode(team)],
  ["deleteTeam", (team) => deleteTeam(team, "Acme")],
])("%s throws for an id that is not 16 lowercase hex characters, before any request", (_name, call) => {
  for (const bad of ["", "0F1E2D3C4B5A6978", "0f1e2d3c4b5a697", "0f1e2d3c4b5a6978/../x", "../../me"]) {
    expect(() => call(bad)).toThrow(RangeError);
  }
  expect(fetched).not.toHaveBeenCalled();
});

test.each<[string, unknown, boolean]>([
  ["a team", { id: T, name: "Acme", role: "owner", dashboardAccess: "members" }, true],
  ["an admin's team for admins", { id: T, name: "Acme", role: "admin", dashboardAccess: "admins" }, true],
  ["an id that is not a public id", { id: "1", name: "Acme", role: "owner", dashboardAccess: "members" }, false],
  ["an unknown role", { id: T, name: "Acme", role: "member", dashboardAccess: "members" }, false],
  ["an unknown access", { id: T, name: "Acme", role: "owner", dashboardAccess: "all" }, false],
  ["a name that is not text", { id: T, name: 4, role: "owner", dashboardAccess: "members" }, false],
  ["nothing", null, false],
])("isTeamInfo: %s → %s", (_name, value, expected) => {
  expect(isTeamInfo(value)).toBe(expected);
});

const INVITE = "ab12cd34ef567890";

test.each<[string, () => Promise<unknown>, { url: string; method: string; body: unknown }]>([
  ["getRoles", () => getRoles(T), { url: `/api/teams/${T}/roles`, method: "GET", body: undefined }],
  ["getInvites", () => getInvites(T), { url: `/api/teams/${T}/invites`, method: "GET", body: undefined }],
  ["createInvite", () => createInvite(T, "viewer"), { url: `/api/teams/${T}/invites`, method: "POST", body: { role: "viewer" } }],
  ["cancelInvite", () => cancelInvite(T, INVITE), { url: `/api/teams/${T}/invites/${INVITE}`, method: "DELETE", body: undefined }],
  ["removeRole", () => removeRole(T, 9_104_227), { url: `/api/teams/${T}/roles/9104227`, method: "DELETE", body: undefined }],
  ["handOver", () => handOver(T, 9_104_227), { url: `/api/teams/${T}/owner`, method: "POST", body: { user: 9_104_227 } }],
])("%s sends its method, path and body, same-origin", async (_name, call, expected) => {
  await call();
  expect(fetched).toHaveBeenCalledTimes(1);
  expect(sent()).toEqual({ ...expected, credentials: "same-origin" });
});

test.each<[string, () => Promise<unknown>]>([
  ["getRoles", () => getRoles("../me")],
  ["createInvite", () => createInvite("0F1E2D3C4B5A6978", "admin")],
  ["cancelInvite with a bad team", () => cancelInvite("x", INVITE)],
  ["cancelInvite with a bad invite", () => cancelInvite(T, "../roles/1")],
  ["removeRole with a fraction", () => removeRole(T, 1.5)],
  ["removeRole with a negative id", () => removeRole(T, -4)],
  ["removeRole with an unsafe id", () => removeRole(T, 2 ** 60)],
  ["handOver with a bad team", () => handOver("", 4)],
])("%s throws before any request", (_name, call) => {
  expect(call).toThrow(RangeError);
  expect(fetched).not.toHaveBeenCalled();
});

const ROLE = { githubId: 7, login: "ada", role: "admin", since: "2026-09-02T12:00:00.000Z" };
const PENDING = { id: INVITE, role: "viewer", createdAt: "2026-11-01T09:00:00.000Z", expiresAt: "2026-11-08T09:00:00.000Z" };

test.each<[string, unknown, boolean]>([
  ["a role", ROLE, true],
  ["a role of a string id", { ...ROLE, githubId: "7" }, false],
  ["an unknown role", { ...ROLE, role: "member" }, false],
  ["a day that is not one", { ...ROLE, since: "soon" }, false],
  ["nothing", null, false],
])("isRoleEntry: %s → %s", (_name, value, expected) => expect(isRoleEntry(value)).toBe(expected));

test.each<[string, unknown, boolean]>([
  ["an invite", PENDING, true],
  ["an invite for an owner", { ...PENDING, role: "owner" }, false],
  ["an id that is not a public id", { ...PENDING, id: "7" }, false],
  ["an invite with no end", { ...PENDING, expiresAt: undefined }, false],
])("isInvite: %s → %s", (_name, value, expected) => expect(isInvite(value)).toBe(expected));
