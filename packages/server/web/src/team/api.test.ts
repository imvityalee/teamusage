import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json } from "../site/page.fixture.js";
import { deleteTeam, getCode, getTeam, isTeamInfo, patchTeam, replaceCode } from "./api.js";

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
