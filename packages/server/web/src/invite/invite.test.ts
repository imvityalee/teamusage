import { describe, expect, test, vi, type Mock } from "vitest";
import type { ApiResult } from "../site/http.js";
import type { Me, MeAnswer } from "../site/session.js";
import { INVITE_KEY, inviter, takeToken, type Inviter } from "./invite.js";

const TOKEN = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const TEAM_ID = "2222222222222222";
const AIGERIM: Me = { kind: "user", githubId: 6_402_118, login: "aigerim-t", teams: [] };
const MEMBER: Me = { kind: "member", team: { id: "3333333333333333", name: "Acme" }, memberId: 4 };
const HAS_ROLE = "you already have a role in this team";
const TEAM_FULL = "this team has reached its limit of 50 admins and viewers";

type Answer = ApiResult<unknown>;
type Request = Parameters<typeof inviter>[0]["request"];
const ok = (value: unknown): Answer => ({ kind: "ok", value });
const refused = (status: number, error = ""): Answer => ({ kind: "refused", status, error });
const preview = (role: "admin" | "viewer" = "admin"): Answer =>
  ok({ team: { name: "Acme Engineering" }, role, expiresAt: "2026-12-04T12:00:00.000Z" });
const accepted = (role: "admin" | "viewer", id = TEAM_ID): Answer =>
  ok({ team: { id, name: "Acme Engineering", role, dashboardAccess: "members" } });
/** An answer that never arrives. */
const PENDING = "pending" as const;

/** A Storage stand-in whose calls are spies. */
function fakeStorage(items: Record<string, string> = {}) {
  const data = new Map(Object.entries(items));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void data.set(key, value)),
    removeItem: vi.fn((key: string) => void data.delete(key)),
  };
}

/** The deps of an inviter whose requests are answered in turn by `answers` (a preview first, unless given). */
function depsWith(over: { token?: string | null; me?: () => Promise<MeAnswer>; answers?: (Answer | typeof PENDING)[]; signOut?: () => Promise<boolean> } = {}) {
  const queue = [...(over.answers ?? [preview()])];
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    requests.push(body === undefined ? { method, path } : { method, path, body });
    const next = queue.shift() ?? PENDING;
    return next === PENDING ? new Promise<Answer>(() => {}) : next;
  }) as Mock & Request;
  const deps = {
    token: over.token === undefined ? TOKEN : over.token,
    storage: fakeStorage(),
    me: vi.fn(over.me ?? (async (): Promise<MeAnswer> => ({ kind: "me", me: AIGERIM }))),
    request,
    signOut: vi.fn(over.signOut ?? (async () => true)),
    go: vi.fn(),
    onChange: vi.fn(),
  };
  return { deps, requests };
}

/** Lets every pending answer arrive. */
async function settled(_i: Inviter): Promise<void> {
  for (let n = 0; n < 10; n++) await Promise.resolve();
}

async function started(over: Parameters<typeof depsWith>[0] = {}) {
  const { deps, requests } = depsWith(over);
  const i = inviter(deps);
  await settled(i);
  return { i, deps, requests };
}

describe("the token", () => {
  test("a token in the address wins over a stored one and replaces it", () => {
    const storage = fakeStorage({ [INVITE_KEY]: TOKEN });
    expect(takeToken(`#${OTHER}`, storage)).toBe(OTHER);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(INVITE_KEY, OTHER);
  });

  test("without one in the address, the stored token is used and nothing is written", () => {
    const storage = fakeStorage({ [INVITE_KEY]: TOKEN });
    expect(takeToken("", storage)).toBe(TOKEN);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test.each(["#abc", `#${TOKEN.toUpperCase()}`, "#new"])("a fragment that is not a token (%j) leaves storage alone", (hash) => {
    const storage = fakeStorage();
    expect(takeToken(hash, storage)).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test("a stored value that is not a token is not used", () => {
    expect(takeToken("", fakeStorage({ [INVITE_KEY]: "x" }))).toBeNull();
  });

  test("the key is the one the privacy page and the global constraints name", () => {
    expect(INVITE_KEY).toBe("teamusage.invite");
  });
});

describe("opening an invitation", () => {
  test("returning from GitHub, the token comes from the tab's storage and nothing is accepted yet", async () => {
    const storage = fakeStorage({ [INVITE_KEY]: TOKEN });
    const { deps, requests } = depsWith({ token: takeToken("", storage), me: async () => ({ kind: "me", me: AIGERIM }) });
    const i = inviter(deps);
    await settled(i);
    expect(i.view).toBe("accept");
    expect(i.login).toBe("aigerim-t");
    expect(i.preview).toEqual({ team: { name: "Acme Engineering" }, role: "admin", expiresAt: "2026-12-04T12:00:00.000Z" });
    expect(requests).toEqual([{ method: "POST", path: "/api/invites/preview", body: { token: TOKEN } }]);
  });

  test.each<[string, MeAnswer]>([
    ["nobody", { kind: "none" }],
    ["a member's session", { kind: "me", me: MEMBER }],
  ])("%s is asked to sign in with GitHub, and nothing is accepted", async (_who, answer) => {
    const { i, requests, deps } = await started({ me: async () => answer });
    expect(i.view).toBe("signIn");
    expect(i.login).toBeNull();
    expect(requests.map((r) => r.path)).toEqual(["/api/invites/preview"]);
    expect(deps.storage.removeItem).not.toHaveBeenCalled();
  });

  test("no token: nothing is asked", async () => {
    const { i, deps } = await started({ token: null });
    expect(i.view).toBe("none");
    expect(i.loading).toBe(false);
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.me).not.toHaveBeenCalled();
  });

  test("an invite that no longer works is forgotten", async () => {
    const { i, deps, requests } = await started({ answers: [refused(404, "this invite is no longer valid")] });
    expect(i.view).toBe("notValid");
    expect(deps.storage.removeItem).toHaveBeenCalledExactlyOnceWith(INVITE_KEY);
    expect(requests.map((r) => r.path)).toEqual(["/api/invites/preview"]);
    expect(deps.me).not.toHaveBeenCalled();
  });

  test.each<[string, Answer]>([
    ["a network error", { kind: "network" }],
    ["a 500", { kind: "failed" }],
    ["a 503", refused(503)],
    ["a preview of another shape", ok({ team: { name: "Acme" }, role: "owner", expiresAt: "2026-12-04T12:00:00.000Z" })],
    ["a preview with no day", ok({ team: { name: "Acme" }, role: "admin", expiresAt: "soon" })],
  ])("%s for the preview fails, keeps the token, and Try again asks again without accepting", async (_what, answer) => {
    const { i, deps, requests } = await started({ answers: [answer, preview()] });
    expect(i.view).toBe("failed");
    expect(deps.storage.removeItem).not.toHaveBeenCalled();
    await i.retry();
    expect(i.view).toBe("accept");
    expect(requests.map((r) => r.path)).toEqual(["/api/invites/preview", "/api/invites/preview"]);
  });

  test("a session that could not be read fails, and Try again asks for both again", async () => {
    const answers: MeAnswer[] = [{ kind: "failed" }, { kind: "me", me: AIGERIM }];
    const { i, requests, deps } = await started({ answers: [preview(), preview()], me: async () => answers.shift() ?? { kind: "none" } });
    expect(i.view).toBe("failed");
    await i.retry();
    expect(i.view).toBe("accept");
    expect(deps.me).toHaveBeenCalledTimes(2);
    expect(requests.map((r) => r.path)).toEqual(["/api/invites/preview", "/api/invites/preview"]);
  });

  test("while the invitation is read again the page says so, and a second Try again sends nothing", async () => {
    const { i, deps } = await started({ answers: [{ kind: "network" }, PENDING] });
    void i.retry();
    void i.retry();
    expect(i.loading).toBe(true);
    expect(deps.request).toHaveBeenCalledTimes(2);
  });
});

describe("accepting", () => {
  test("accepting sends the token once, forgets it, and goes to the team page", async () => {
    const { i, deps, requests } = await started({ answers: [preview(), accepted("admin")] });
    await i.accept();
    expect(requests.at(-1)).toEqual({ method: "POST", path: "/api/invites/accept", body: { token: TOKEN } });
    expect(deps.storage.removeItem).toHaveBeenCalledWith(INVITE_KEY);
    expect(deps.go).toHaveBeenCalledWith("/team?team=2222222222222222");
  });

  test("a viewer goes to the dashboard", async () => {
    const { i, deps } = await started({ answers: [preview("viewer"), accepted("viewer")] });
    await i.accept();
    expect(deps.storage.removeItem).toHaveBeenCalledExactlyOnceWith(INVITE_KEY);
    expect(deps.go).toHaveBeenCalledExactlyOnceWith("/dashboard?team=2222222222222222");
  });

  test("an answer whose team id is not an id still forgets the used token, and goes to the list of teams", async () => {
    const { i, deps } = await started({ answers: [preview(), accepted("admin", "../x")] });
    await i.accept();
    expect(deps.storage.removeItem).toHaveBeenCalledExactlyOnceWith(INVITE_KEY);
    expect(deps.go).toHaveBeenCalledExactlyOnceWith("/teams#all");
  });

  test("a double press sends one accept, and the page is busy until the answer", async () => {
    const { i, deps } = await started({ answers: [preview(), PENDING] });
    void i.accept();
    void i.accept();
    expect(deps.request).toHaveBeenCalledTimes(2);
    expect(i.busy).toBe(true);
  });

  test("an invite that stopped working before the press is forgotten", async () => {
    const { i, deps } = await started({ answers: [preview(), refused(404, "this invite is no longer valid")] });
    await i.accept();
    expect(i.view).toBe("notValid");
    expect(deps.storage.removeItem).toHaveBeenCalledExactlyOnceWith(INVITE_KEY);
    expect(deps.go).not.toHaveBeenCalled();
  });

  test("an account that already has a role is told so, and the invite is forgotten", async () => {
    const { i, deps } = await started({ answers: [preview(), refused(409, HAS_ROLE)] });
    await i.accept();
    expect(i.view).toBe("hasRole");
    expect(i.login).toBe("aigerim-t");
    expect(deps.storage.removeItem).toHaveBeenCalledExactlyOnceWith(INVITE_KEY);
  });

  test("a full team keeps the token so the link can be opened again", async () => {
    const { i, deps } = await started({ answers: [preview(), refused(409, TEAM_FULL)] });
    await i.accept();
    expect(i.view).toBe("teamFull");
    expect(deps.storage.removeItem).not.toHaveBeenCalled();
  });

  test("a session that ended meanwhile leads to the sign-in, and the token stays for the way back", async () => {
    const { i, deps } = await started({ answers: [preview(), { kind: "unauthorized" }] });
    await i.accept();
    expect(i.view).toBe("signIn");
    expect(i.login).toBeNull();
    expect(deps.storage.removeItem).not.toHaveBeenCalled();
  });

  test.each<[string, Answer]>([
    ["a network error", { kind: "network" }],
    ["a 500", { kind: "failed" }],
    ["an unknown refusal", refused(409, "something else")],
    ["a cross-site refusal", refused(403, "cross-site request")],
  ])("%s keeps the token; Try again reads the invitation again and waits for a new press", async (_what, answer) => {
    const { i, deps, requests } = await started({ answers: [preview(), answer, preview()] });
    await i.accept();
    expect(i.view).toBe("failed");
    expect(deps.storage.removeItem).not.toHaveBeenCalled();
    await i.retry();
    expect(i.view).toBe("accept");
    expect(requests.map((r) => r.path)).toEqual(["/api/invites/preview", "/api/invites/accept", "/api/invites/preview"]);
  });

  test("nothing is accepted from any other view", async () => {
    const { i, deps } = await started({ me: async () => ({ kind: "none" }) });
    await i.accept();
    expect(deps.request).toHaveBeenCalledTimes(1);
  });
});

describe("another account", () => {
  test("signs out and shows the sign-in with the line about switching on github.com; the token stays", async () => {
    const { i, deps } = await started();
    await i.useAnotherAccount();
    expect(deps.signOut).toHaveBeenCalledTimes(1);
    expect(i.view).toBe("signIn");
    expect(i.switchAccount).toBe(true);
    expect(i.login).toBeNull();
    expect(i.busy).toBe(false);
    expect(deps.storage.removeItem).not.toHaveBeenCalled();
  });

  test("a sign-out that did not happen keeps the person here, says so, and lets them press again", async () => {
    const answers = [false, true];
    const { i, deps } = await started({ signOut: async () => answers.shift() ?? true });
    await i.useAnotherAccount();
    expect(i.view).toBe("accept");
    expect(i.signOutFailed).toBe(true);
    expect(i.busy).toBe(false);
    expect(i.switchAccount).toBe(false);
    await i.useAnotherAccount();
    expect(i.view).toBe("signIn");
    expect(i.signOutFailed).toBe(false);
    expect(deps.signOut).toHaveBeenCalledTimes(2);
  });

  test("is not sent while an accept is out", async () => {
    const { i, deps } = await started({ answers: [preview(), PENDING] });
    void i.accept();
    await i.useAnotherAccount();
    expect(deps.signOut).not.toHaveBeenCalled();
  });
});
