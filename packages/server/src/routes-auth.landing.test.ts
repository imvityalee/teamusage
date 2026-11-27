import type { Hono } from "hono";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "./db.js";
import { clearsOauth, cookieOf, finishSignIn, hostedApp, hostedTeam, machineClient, memberSignIn, signIn as signInAs } from "./hosted.fixture.js";

let db: Db;
let app: Hono;
beforeEach(() => {
  ({ db, app } = hostedApp());
});

const sessionCount = (d: Db) => (d.prepare("select count(*) as n from sessions").get() as { n: number }).n;
const me = (cookie: string) => app.request("/api/me", { headers: { Cookie: cookie } });
const callback = (query: string, cookie: string) =>
  app.request(`/auth/github/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} });

/** Starts a sign-in at `startPath`; returns the state and verifier of its `tu_oauth` cookie. */
async function started(startPath = "/auth/github/start?to=invite"): Promise<{ state: string; verifier: string }> {
  const res = await app.request(startPath);
  const [state = "", verifier = ""] = cookieOf(res, "tu_oauth").slice("tu_oauth=".length).split(".");
  return { state, verifier };
}

/** Checks a callback that failed: it sends the browser to `location`, opens no session and clears `tu_oauth`. */
function expectFailed(res: Response, location: string): void {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(location);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(cookieOf(res, "tu_session")).toBe("");
  expect(clearsOauth(res)).toBe(true);
  expect(sessionCount(db)).toBe(0);
}

/** Checks a callback that signed the browser in and sent it to `location`. */
function expectLanded(res: Response, location: string): void {
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(location);
  expect(cookieOf(res, "tu_session")).not.toBe("");
  expect(sessionCount(db)).toBe(1);
}

test.each([
  ["", "/teams"], ["?to=teams", "/teams"], ["?to=invite", "/invite"], ["?to=https://evil.example", "/teams"],
  ["?to=//evil.example", "/teams"], ["?to=/team", "/teams"], ["?to=invite&to=teams", "/teams"],
  ["?to=constructor", "/teams"], ["?to=__proto__", "/teams"],
])(
  "a sign-in started with %s lands on %s", async (query, landing) => {
    // follows start, then calls the callback with the cookie and state
    const res = await finishSignIn(app, `/auth/github/start${query}`, "code-bob");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(landing);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
test("a callback GitHub refuses lands on the page with ?error=signin and opens no session", async () => {
  const res = await finishSignIn(app, "/auth/github/start?to=invite", "code-nobody-has");
  expect(res.headers.get("location")).toBe("/invite?error=signin");
  expect(res.headers.get("set-cookie") ?? "").not.toContain("tu_session=");
  expect(sessionCount(db)).toBe(0);
});
test("signing in again ends the session the browser had", async () => {
  const first = await signInAs(app, "code-bob");
  const second = await signInAs(app, "code-bob", { Cookie: first });
  expect((await app.request("/api/me", { headers: { Cookie: first } })).status).toBe(401);
  expect((await app.request("/api/me", { headers: { Cookie: second } })).status).toBe(200);
  expect(sessionCount(db)).toBe(1);
});

test("a callback without the oauth cookie lands on /teams?error=signin", async () => {
  const { state } = await started();
  expectFailed(await callback(`code=code-bob&state=${state}`, ""), "/teams?error=signin");
});
test("a callback with another state lands on the cookie's page with ?error=signin", async () => {
  const { state, verifier } = await started();
  expectFailed(await callback(`code=code-bob&state=${"0".repeat(64)}`, `tu_oauth=${state}.${verifier}.invite`), "/invite?error=signin");
});
test("a callback without a code lands on the cookie's page with ?error=signin", async () => {
  const { state, verifier } = await started();
  expectFailed(await callback(`state=${state}`, `tu_oauth=${state}.${verifier}.invite`), "/invite?error=signin");
});
test.each([
  ["has an empty verifier", (s: string) => `${s}..invite`],
  ["has an empty state", (_s: string, v: string) => `.${v}.invite`],
  ["has a fourth part", (s: string, v: string) => `${s}.${v}.invite.x`],
])("a callback whose oauth cookie %s lands on /teams?error=signin, whatever its third part says", async (_name, cookie) => {
  const { state, verifier } = await started();
  expectFailed(await callback(`code=code-bob&state=${state}`, `tu_oauth=${cookie(state, verifier)}`), "/teams?error=signin");
});
test("a sign-in begun before the upgrade, with a cookie of two parts, lands on /teams", async () => {
  const { state, verifier } = await started();
  expectLanded(await callback(`code=code-bob&state=${state}`, `tu_oauth=${state}.${verifier}`), "/teams");
});
test.each(["team", "Invite", "/invite", "", "constructor", "toString"])("a cookie whose third part is %j lands on /teams", async (to) => {
  const { state, verifier } = await started();
  expectLanded(await callback(`code=code-bob&state=${state}`, `tu_oauth=${state}.${verifier}.${to}`), "/teams");
});
test("the callback's own query does not choose the page", async () => {
  const { state, verifier } = await started("/auth/github/start?to=teams");
  expectLanded(await callback(`code=code-bob&state=${state}&to=invite`, `tu_oauth=${state}.${verifier}.teams`), "/teams");
});

test("/api/me of a GitHub session names its GitHub id", async () => {
  ({ db, app } = hostedApp({ users: { "code-cyd": { id: 9041, login: "cyd" } } }));
  expect(await (await me(await signInAs(app, "code-cyd"))).json()).toEqual({ kind: "user", githubId: 9041, login: "cyd", teams: [] });
});
test("/api/me of a member's session is unchanged", async () => {
  const { team, code } = hostedTeam(db, { githubId: 5101, login: "own" }, "members", "Acme");
  const machine = await machineClient(() => app, () => code).register();
  const { token, memberId } = (await machine.json()) as { token: string; memberId: number };
  const answer = await me(await memberSignIn(app, token));
  expect(await answer.json()).toEqual({ kind: "member", team: { id: team.publicId, name: "Acme" }, memberId });
});

test("a sign-in that fails leaves the browser's session alive", async () => {
  const old = await signInAs(app, "code-bob");
  expect(cookieOf(await finishSignIn(app, "/auth/github/start", "code-nobody-has", { Cookie: old }), "tu_session")).toBe("");
  expect((await me(old)).status).toBe(200);
});
test("two sign-ins open together from one browser end its session and leave only their own two", async () => {
  const old = await signInAs(app, "code-bob");
  const [one, two] = await Promise.all([signInAs(app, "code-bob", { Cookie: old }), signInAs(app, "code-ann", { Cookie: old })]);
  expect((await me(old)).status).toBe(401);
  expect([(await me(one)).status, (await me(two)).status]).toEqual([200, 200]);
  expect(sessionCount(db)).toBe(2);
});
