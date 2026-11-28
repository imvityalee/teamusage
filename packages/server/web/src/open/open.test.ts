import { describe, expect, test, vi, type Mock } from "vitest";
import type { ApiResult } from "../site/http.js";
import type { Me, me as meOf } from "../site/session.js";
import { opener, type OpenFailure, type Opener } from "./open.js";

const TOKEN = "0123456789abcdef".repeat(4);
const NOT_VALID = "this link is no longer valid; ask your agent for a new one";
const BOB: Me = { kind: "user", githubId: 7_310_442, login: "bob", teams: [] };
const MEMBER: Me = { kind: "member", team: { id: "a1b2c3d4e5f60718", name: "Acme" }, memberId: 3 };

type MeAnswer = Awaited<ReturnType<typeof meOf>>;
type Request = Parameters<typeof opener>[0]["request"];
type Answer = ApiResult<never>;
const ok: Answer = { kind: "ok", value: undefined as never };
const refused = (status: number, error: string): Answer => ({ kind: "refused", status, error });

/** A stub of `request` from an answer of any shape: a mock that can stand where the generic `request` goes. */
const asRequest = <F extends (...args: never[]) => Promise<Answer>>(spy: Mock<F>) => spy as Mock<F> & Request;

/** A `request` that answers each call with the next of `answers`. */
function requests(...answers: Answer[]) {
  return asRequest(vi.fn(async (_method: string, _path: string, _body?: unknown) => answers.shift() ?? ok));
}

/** A `me` that answers each call with the next of `answers`. */
function sessions(...answers: MeAnswer[]) {
  return vi.fn(async () => answers.shift() ?? { kind: "none" as const });
}

/** Lets every pending answer arrive. */
async function settled(_o: Opener): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("opening a link", () => {
  test("a GitHub user is asked first, and declining sends nothing", async () => {
    const spy = requests();
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => ({ kind: "me", me: BOB }), request: spy, go });
    await settled(o);
    expect(o.view).toBe("confirm");
    expect(o.login).toBe("bob");
    expect(spy).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  test("confirming opens the link and goes to the dashboard", async () => {
    const spy = requests(ok);
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => ({ kind: "me", me: BOB }), request: spy, go });
    await settled(o);
    await o.open();
    expect(spy).toHaveBeenCalledWith("POST", "/api/dashboard-link/open", { token: TOKEN });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("/dashboard");
  });

  test.each<[string, MeAnswer]>([
    ["a member", { kind: "me", me: MEMBER }],
    ["a browser nobody is signed in to", { kind: "none" }],
  ])("%s opens the link without being asked", async (_, answer) => {
    const spy = requests(ok);
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => answer, request: spy, go });
    await settled(o);
    expect(spy).toHaveBeenCalledWith("POST", "/api/dashboard-link/open", { token: TOKEN });
    expect(go).toHaveBeenCalledWith("/dashboard");
  });

  test("a server with no accounts asks nothing and goes to /", async () => {
    const spy = requests(ok);
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => ({ kind: "noAccounts" }), request: spy, go });
    await settled(o);
    expect(spy).toHaveBeenCalledWith("POST", "/api/dashboard-link/open", { token: TOKEN });
    expect(go).toHaveBeenCalledWith("/");
    expect(go).not.toHaveBeenCalledWith("/dashboard");
  });

  test.each([
    [403, NOT_VALID, "expired"],
    [403, "this team's dashboard is limited to its admins", "adminsOnly"],
  ])("a %i %s shows %s", async (status, error, view) => {
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => ({ kind: "none" }), request: requests(refused(status, error)), go });
    await settled(o);
    expect(o.view).toBe(view);
    expect(go).not.toHaveBeenCalled();
  });

  // Each of these leaves the link unspent: the route refuses before it takes the link.
  test.each<[string, Answer, OpenFailure]>([
    ["a 403 from a server that opens links only from its own address", refused(403, "cross-site request refused"), { kind: "wrongAddress" }],
    ["another refusal of the route", refused(400, "invalid token"), { kind: "refused", error: "invalid token" }],
    ["a refusal without the server's text (a proxy's page)", refused(403, ""), { kind: "refused", error: "" }],
    ["a network error", { kind: "network" }, { kind: "unreachable" }],
  ])("%s shows failed with its reason, not an expired link", async (_, answer, failure) => {
    const o = opener({ token: TOKEN, me: async () => ({ kind: "none" }), request: requests(answer), go: vi.fn() });
    await settled(o);
    expect(o.view).toBe("failed");
    expect(o.failure).toEqual(failure);
  });

  test.each<[string, Answer]>([
    ["a network error", { kind: "network" }],
    ["a 500", { kind: "failed" }],
    ["a 503", refused(503, "busy")],
  ])("after %s the same token is sent again on Try again", async (_, first) => {
    const spy = requests(first, ok);
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => ({ kind: "none" }), request: spy, go });
    await settled(o);
    expect(o.view).toBe("failed");
    expect(go).not.toHaveBeenCalled();
    await o.open();
    expect(spy.mock.calls).toEqual([
      ["POST", "/api/dashboard-link/open", { token: TOKEN }],
      ["POST", "/api/dashboard-link/open", { token: TOKEN }],
    ]);
    expect(go).toHaveBeenCalledWith("/dashboard");
  });

  test("a pressed view stays, busy, until the answer, and a second press sends nothing", async () => {
    let answer: (r: Answer) => void = () => {};
    const spy = asRequest(vi.fn(() => new Promise<Answer>((r) => (answer = r))));
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: async () => ({ kind: "me", me: BOB }), request: spy, go });
    await settled(o);
    const first = o.open();
    const second = o.open();
    expect(o.view).toBe("confirm");
    expect(o.busy).toBe(true);
    answer(ok);
    await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(1);
  });

  test("a refused press ends the busy state on the view the answer leads to", async () => {
    const o = opener({ token: TOKEN, me: async () => ({ kind: "me", me: BOB }), request: requests(refused(403, NOT_VALID)), go: vi.fn() });
    const seen: string[] = [];
    o.onChange(() => seen.push(o.busy ? `${o.view} (busy)` : o.view));
    await settled(o);
    await o.open();
    expect(seen).toEqual(["confirm", "confirm (busy)", "expired"]);
  });

  test("the automatic opening is the opening view, never busy", async () => {
    const o = opener({ token: TOKEN, me: () => new Promise(() => {}), request: requests(), go: vi.fn() });
    await settled(o);
    expect(o.view).toBe("opening");
    expect(o.busy).toBe(false);
  });
});

describe("a session that could not be read", () => {
  test("with a token: the view is failed, nothing is posted, and Try again asks who is signed in first", async () => {
    const spy = requests(ok);
    const go = vi.fn();
    const me = sessions({ kind: "failed" }, { kind: "me", me: BOB });
    const o = opener({ token: TOKEN, me, request: spy, go });
    await settled(o);
    expect(o.view).toBe("failed");
    expect(spy).not.toHaveBeenCalled();

    const pressed = o.open();
    expect(o.view).toBe("failed");
    expect(o.busy).toBe(true);
    await pressed;
    await settled(o);
    expect(me).toHaveBeenCalledTimes(2);
    expect(o.view).toBe("confirm");
    expect(spy).not.toHaveBeenCalled();
  });

  test("with a token: Try again opens the link once the session reads as nobody", async () => {
    const spy = requests(ok);
    const go = vi.fn();
    const o = opener({ token: TOKEN, me: sessions({ kind: "failed" }, { kind: "none" }), request: spy, go });
    await settled(o);
    await o.open();
    await settled(o);
    expect(spy).toHaveBeenCalledWith("POST", "/api/dashboard-link/open", { token: TOKEN });
    expect(go).toHaveBeenCalledWith("/dashboard");
  });

  test("without a token: the page shows how to get a link", async () => {
    const spy = requests();
    const o = opener({ token: null, me: async () => ({ kind: "failed" }), request: spy, go: vi.fn() });
    await settled(o);
    expect(o.view).toBe("how");
    expect(o.noAccounts).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("no token", () => {
  test.each<[string, MeAnswer, boolean]>([
    ["nobody", { kind: "none" }, false],
    ["a GitHub user", { kind: "me", me: BOB }, false],
    ["a server with no accounts", { kind: "noAccounts" }, true],
  ])("for %s the page shows how to get a link and sends nothing", async (_, answer, noAccounts) => {
    const spy = requests();
    const go = vi.fn();
    const o = opener({ token: null, me: async () => answer, request: spy, go });
    await settled(o);
    expect(o.view).toBe("how");
    expect(o.noAccounts).toBe(noAccounts);
    await o.open();
    expect(spy).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });
});
