import { afterEach, describe, expect, test, vi } from "vitest";
import { me, signInDidNotFinish, signOut, SIGN_IN_PATH, type Me } from "./session.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function answer(reply: Response | Error) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const USER: Me = {
  kind: "user",
  githubId: 5_812_331,
  login: "bob",
  teams: [
    { id: "a1b2c3d4e5f60718", name: "Acme", role: "owner", dashboardAccess: "members" },
    { id: "0f1e2d3c4b5a6978", name: "Zeta", role: "viewer", dashboardAccess: "admins" },
  ],
};
const MEMBER: Me = { kind: "member", team: { id: "a1b2c3d4e5f60718", name: "Acme" }, memberId: 42 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("me", () => {
  test.each([
    ["a GitHub user", USER],
    ["a GitHub user with no team", { ...USER, teams: [] }],
    ["a member", MEMBER],
  ])("a 200 for %s is that session", async (_, body) => {
    const fetch = answer(json(body));
    expect(await me()).toEqual({ kind: "me", me: body });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me");
    expect(init.method).toBe("GET");
  });

  test("a 401 is nobody", async () => {
    answer(json({ error: "unauthorized" }, 401));
    expect(await me()).toEqual({ kind: "none" });
  });

  test("a 404, which a self-hosted server answers in plain text, means the server has no accounts", async () => {
    answer(new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } }));
    expect(await me()).toEqual({ kind: "noAccounts" });
  });

  test.each([
    ["a 500", () => json({ error: "internal error" }, 500)],
    ["a 503", () => json({ error: "busy" }, 503)],
    ["a body that is not JSON", () => new Response("<html></html>", { status: 200 })],
    ["a body of another shape", () => json({ kind: "team" })],
    ["a user without a login", () => json({ ...USER, login: undefined })],
    ["a user with an unknown role", () => json({ ...USER, teams: [{ ...USER.teams[0], role: "god" }] })],
    ["a member without a team", () => json({ kind: "member", memberId: 1 })],
    ["a network error", () => new TypeError("Failed to fetch")],
  ])("%s is failed", async (_, reply) => {
    answer(reply());
    expect(await me()).toEqual({ kind: "failed" });
  });
});

describe("signOut", () => {
  test("posts /api/logout", async () => {
    const fetch = answer(new Response(null, { status: 204 }));
    await signOut();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  test.each([
    ["a 204", () => new Response(null, { status: 204 }), true],
    ["a 401, which is signed out already", () => json({ error: "unauthorized" }, 401), true],
    ["a 500", () => json({ error: "internal error" }, 500), false],
    ["a refusal", () => json({ error: "forbidden" }, 403), false],
    ["a network error", () => new TypeError("Failed to fetch"), false],
  ])("answers whether the session ended: %s", async (_, reply, ended) => {
    answer(reply());
    expect(await signOut()).toBe(ended);
  });
});

test("sign-in starts at GitHub's start path", () => {
  expect(SIGN_IN_PATH).toBe("/auth/github/start");
});

test.each([
  ["?error=signin", true],
  ["?error=signin&x=1", true],
  ["", false],
  ["?error=other", false],
  ["?error=SIGNIN", false],
])("signInDidNotFinish(%j) is %s", (search, expected) => {
  expect(signInDidNotFinish(search)).toBe(expected);
});
