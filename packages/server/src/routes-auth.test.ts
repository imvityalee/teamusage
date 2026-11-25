import { createHash } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import type { Db } from "./db.js";
import { cookieOf, hostedApp, signIn, type FakeGithub } from "./hosted.fixture.js";

let db: Db;
let app: ReturnType<typeof hostedApp>["app"];
let github: FakeGithub;
beforeEach(() => {
  ({ db, app, github } = hostedApp());
});

const sessionCount = () => db.prepare("select count(*) as n from sessions").get();
/** Runs start and returns its state, its `tu_oauth` cookie pair, and the callback URL for `code`. */
const started = async (code = "code-ann") => {
  const res = await app.request("/auth/github/start");
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  return { state, oauth: cookieOf(res, "tu_oauth"), url: `/auth/github/callback?code=${code}&state=${state}` };
};
/** True when the response expires `tu_oauth` on the path it was set for. */
const clearsOauth = (res: Response) => /tu_oauth=;[^,]*Max-Age=0;[^,]*Path=\/auth\/github/.test(res.headers.get("set-cookie") ?? "");

test("start sends the browser to GitHub with a state and a challenge it can prove later", async () => {
  const res = await app.request("/auth/github/start");
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location")!);
  const cookie = res.headers.get("set-cookie")!;
  const [state, verifier] = /tu_oauth=([^;]+)/.exec(cookie)![1]!.split(".");
  expect(to.searchParams.get("state")).toBe(state);
  expect(to.searchParams.get("challenge")).toBe(createHash("sha256").update(verifier!).digest("base64url"));
  expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Lax/i); expect(cookie).toMatch(/Path=\/auth\/github/);
});
test("start makes a 32-byte state and verifier that last ten minutes, Secure only over https", async () => {
  const { state, oauth } = await started();
  expect(state).toMatch(/^[a-f0-9]{64}$/);
  expect(oauth).toMatch(/^tu_oauth=[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/);
  const plain = (await app.request("/auth/github/start")).headers.get("set-cookie");
  expect(plain).toMatch(/Max-Age=600/);
  expect(plain).not.toMatch(/Secure/i);
  const viaUrl = await app.request("https://teamusage.example/auth/github/start");
  const viaHeader = await app.request("/auth/github/start", { headers: { "X-Forwarded-Proto": "https" } });
  expect(viaUrl.headers.get("set-cookie")).toMatch(/Secure/i);
  expect(viaHeader.headers.get("set-cookie")).toMatch(/Secure/i);
});
test("a callback with the browser's own state signs the user in", async () => {
  const cookie = await signIn(app, "code-ann");          // fakeGithub({ "code-ann": { id: 1, login: "ann" } })
  const me = await app.request("/api/me", { headers: { Cookie: cookie } });
  expect(await me.json()).toEqual({ kind: "user", login: "ann", teams: [] });
  expect(me.headers.get("cache-control")).toBe("no-store");
});
test("the callback proves the cookie's verifier to GitHub, sets today's session cookie and goes home", async () => {
  const { oauth, url } = await started();
  const res = await app.request(url, { headers: { Cookie: oauth } });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  expect(github.calls).toEqual([{ code: "code-ann", verifier: oauth.split(".")[1] }]);
  const sc = res.headers.get("set-cookie")!;
  expect(sc).toMatch(/tu_session=[a-f0-9]{64}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax(,|$)/);
  expect(clearsOauth(res)).toBe(true);
  const secure = await app.request(`https://teamusage.example${url}`, { headers: { Cookie: oauth } });
  expect(cookieOf(secure, "tu_session")).not.toBe("");
  expect(secure.headers.get("set-cookie")).toMatch(/tu_session=[a-f0-9]{64};[^,]*Secure/);
});
test.each([
  ["without the oauth cookie", (s: string) => ({ url: `/auth/github/callback?code=code-ann&state=${s}`, cookie: "" })],
  ["with another state", (s: string) => ({ url: "/auth/github/callback?code=code-ann&state=" + "0".repeat(64), cookie: `tu_oauth=${s}.v` })],
  ["without a state", (s: string) => ({ url: "/auth/github/callback?code=code-ann", cookie: `tu_oauth=${s}.v` })],
  ["without a code", (s: string) => ({ url: `/auth/github/callback?state=${s}`, cookie: `tu_oauth=${s}.v` })],
])("a callback %s opens no session", async (_name, build) => {
  const { url, cookie } = build("a".repeat(64));
  const res = await app.request(url, { headers: cookie ? { Cookie: cookie } : {} });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "sign-in failed" });
  expect(res.headers.get("set-cookie") ?? "").not.toContain("tu_session=");
  expect(github.calls).toEqual([]);
  expect(db.prepare("select count(*) as n from sessions").get()).toEqual({ n: 0 });
});
test.each([
  ["has no dot", (s: string) => `tu_oauth=${s}`],
  ["has an empty state", () => "tu_oauth=.v"],
  ["has an empty verifier", (s: string) => `tu_oauth=${s}.`],
  ["has an extra part", (s: string) => `tu_oauth=${s}.v.w`],
])("a callback whose oauth cookie %s opens no session", async (_name, cookie) => {
  const s = "a".repeat(64);
  const res = await app.request(`/auth/github/callback?code=code-ann&state=${s}`, { headers: { Cookie: cookie(s) } });
  expect(res.status).toBe(400);
  expect(github.calls).toEqual([]);
  expect(sessionCount()).toEqual({ n: 0 });
});
test.each([
  ["state", (s: string) => `code=code-ann&state=${s}&state=${s}`],
  ["code", (s: string) => `code=code-ann&code=code-ann&state=${s}`],
])("a callback with a repeated %s opens no session", async (_name, query) => {
  const { state, oauth } = await started();
  const res = await app.request(`/auth/github/callback?${query(state)}`, { headers: { Cookie: oauth } });
  expect(res.status).toBe(400);
  expect(github.calls).toEqual([]);
  expect(sessionCount()).toEqual({ n: 0 });
});
test("a state cannot be used twice", async () => {
  const { oauth, url } = await started();
  const first = await app.request(url, { headers: { Cookie: oauth } });
  expect(first.status).toBe(302);
  // The first answer expired tu_oauth, so the browser sends the second callback without it.
  expect(clearsOauth(first)).toBe(true);
  const second = await app.request(url);
  expect(second.status).toBe(400);
  expect(cookieOf(second, "tu_session")).toBe("");
  expect(sessionCount()).toEqual({ n: 1 });
});
test("when GitHub gives no user, sign-in fails and no session is opened", async () => {
  const { oauth, url } = await started("unknown");
  const res = await app.request(url, { headers: { Cookie: oauth } });
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "sign-in failed" });
  expect(cookieOf(res, "tu_session")).toBe("");
  expect(sessionCount()).toEqual({ n: 0 });
});
test("every callback answer expires the oauth cookie", async () => {
  const refused = await app.request("/auth/github/callback?code=code-ann", { headers: { Cookie: `tu_oauth=${"a".repeat(64)}.v` } });
  const { oauth, url } = await started("unknown");
  const failed = await app.request(url, { headers: { Cookie: oauth } });
  expect([refused.status, failed.status]).toEqual([400, 502]);
  expect([clearsOauth(refused), clearsOauth(failed)]).toEqual([true, true]);
});
