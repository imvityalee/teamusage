import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json } from "../site/page.fixture.js";
import { getMembers, isApiMember, isMachine } from "./api.js";

const T = "0f1e2d3c4b5a6978";
const MACHINE = { id: "0123456789abcdef0123456789abcdef", label: "daniyar-mbp", lastSyncAt: "2026-11-27T09:00:00.000Z" };
const MEMBER = { id: 7, name: "Данияр Жумабеков", email: "daniyar@acme.example", joinedAt: "2026-09-02T12:00:00.000Z", machines: [MACHINE] };

let fetched: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetched = vi.fn(async () => json({ members: [MEMBER] }));
  vi.stubGlobal("fetch", fetched);
});
afterEach(() => vi.unstubAllGlobals());

test("getMembers asks GET /api/teams/<team>/members, same-origin, and gives the list", async () => {
  const result = await getMembers(T);
  const [url, init] = fetched.mock.calls[0] as [string, RequestInit];
  expect([url, init.method, init.body, init.credentials]).toEqual([`/api/teams/${T}/members`, "GET", undefined, "same-origin"]);
  expect(result).toEqual({ kind: "ok", value: { members: [MEMBER] } });
});

test("getMembers throws for an id that is not 16 lowercase hex characters, before any request", () => {
  for (const bad of ["", "0F1E2D3C4B5A6978", "../me"]) expect(() => getMembers(bad)).toThrow(RangeError);
  expect(fetched).not.toHaveBeenCalled();
});

test.each<[string, unknown, boolean]>([
  ["a machine", MACHINE, true],
  ["a machine that never synced", { ...MACHINE, lastSyncAt: null }, true],
  ["an id that is not 32 hex characters", { ...MACHINE, id: "abc" }, false],
  ["a label that is not text", { ...MACHINE, label: 4 }, false],
  ["a sync that is not a time", { ...MACHINE, lastSyncAt: "soon" }, false],
  ["nothing", null, false],
])("isMachine: %s → %s", (_name, value, expected) => expect(isMachine(value)).toBe(expected));

test.each<[string, unknown, boolean]>([
  ["a member", MEMBER, true],
  ["a member with no machine", { ...MEMBER, machines: [] }, true],
  ["an id that is not a whole number above zero", { ...MEMBER, id: 0 }, false],
  ["a fractional id", { ...MEMBER, id: 1.5 }, false],
  ["a name that is not text", { ...MEMBER, name: 7 }, false],
  ["an email that is not text", { ...MEMBER, email: null }, false],
  ["a day they joined that is not one", { ...MEMBER, joinedAt: "then" }, false],
  ["machines that are not a list", { ...MEMBER, machines: "mbp" }, false],
  ["a machine that is not one", { ...MEMBER, machines: [MACHINE, 4] }, false],
  ["nothing", undefined, false],
])("isApiMember: %s → %s", (_name, value, expected) => expect(isApiMember(value)).toBe(expected));
