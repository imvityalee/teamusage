import { beforeEach, describe, expect, test } from "vitest";
import { APP_NAME, MAX_COST_USD, MAX_TOKENS, MAX_TOTAL_TOKENS } from "@teamusage/shared";
import { createApp } from "./app.js";
import { openDb, type Db } from "./db.js";

const INVITE = "invite-code-123";
const MID = "a".repeat(32);
const MID2 = "b".repeat(32);

let db: Db;
let app: ReturnType<typeof createApp>;
let logged: string[];
const logError = (line: string) => logged.push(line);
beforeEach(() => {
  db = openDb(":memory:");
  logged = [];
  app = createApp(db, { inviteCode: () => INVITE, logError });
});

const goodReg = (over: Record<string, unknown> = {}) => ({
  inviteCode: INVITE,
  name: "Ann",
  email: "ann@example.com",
  machineId: MID,
  machineLabel: "mbp",
  ...over,
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });

const record = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-01",
  agent: "claude",
  model: "m",
  input: 1,
  output: 2,
  cacheCreate: 3,
  cacheRead: 4,
  total: 10,
  costUsd: 0.5,
  unpriced: false,
  ...over,
});

const register = async (over: Record<string, unknown> = {}) => {
  const res = await post("/api/register", goodReg(over));
  return (await res.json()) as { token: string; memberId: number };
};
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const usageCount = () => (db.prepare("select count(*) as n from usage").get() as { n: number }).n;

describe("GET /api/health", () => {
  test("reports ok and app name", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: APP_NAME });
  });
});

describe("POST /api/register", () => {
  test("happy path returns token and memberId", async () => {
    const res = await post("/api/register", goodReg());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; memberId: number };
    expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof body.memberId).toBe("number");
  });

  test("wrong invite code -> 403", async () => {
    const res = await post("/api/register", goodReg({ inviteCode: "nope" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid invite code" });
  });

  test("invite code of a different length or non-string -> 403 without throwing", async () => {
    expect((await post("/api/register", goodReg({ inviteCode: "" }))).status).toBe(403);
    expect((await post("/api/register", goodReg({ inviteCode: INVITE + "x" }))).status).toBe(403);
    expect((await post("/api/register", goodReg({ inviteCode: 5 }))).status).toBe(403);
  });

  test("invite code is read on each request (rotation takes effect)", async () => {
    let code = "one";
    const a = createApp(db, { inviteCode: () => code });
    const send = (c: string) =>
      a.request("/api/register", {
        method: "POST",
        body: JSON.stringify(goodReg({ inviteCode: c })),
        headers: { "Content-Type": "application/json" },
      });
    expect((await send("one")).status).toBe(200);
    code = "two";
    expect((await send("one")).status).toBe(403);
    expect((await send("two")).status).toBe(200);
  });

  test.each([
    ["missing email", { email: undefined }],
    ["email without @", { email: "annexample.com" }],
    ["email over 254 chars", { email: "a".repeat(250) + "@b.co" }],
    ["empty name", { name: "   " }],
    ["name over 100 chars", { name: "n".repeat(101) }],
    ["non-string name", { name: 5 }],
    ["short machineId", { machineId: "abc" }],
    ["uppercase machineId", { machineId: "A".repeat(32) }],
    ["machineId with newline", { machineId: MID + "\n" }],
    ["empty machineLabel", { machineLabel: " " }],
    ["machineLabel over 100 chars", { machineLabel: "l".repeat(101) }],
  ])("invalid input (%s) -> 400 and nothing stored", async (_n, over) => {
    const res = await post("/api/register", goodReg(over));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(db.prepare("select count(*) as n from members").get()).toEqual({ n: 0 });
  });

  test("validation runs only after the invite check (bad invite + bad input -> 403)", async () => {
    const res = await post("/api/register", goodReg({ inviteCode: "nope", email: "x" }));
    expect(res.status).toBe(403);
  });

  test("malformed JSON -> 400, not 500", async () => {
    const res = await post("/api/register", "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("non-object JSON body -> 400", async () => {
    expect((await post("/api/register", "null")).status).toBe(400);
    expect((await post("/api/register", "[1]")).status).toBe(400);
  });

  test("machine owned by another member -> 409 without echoing details", async () => {
    await register();
    const res = await post("/api/register", goodReg({ email: "bob@example.com", name: "Bob" }));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "machine already registered to another member" });
    expect(text).not.toContain(MID);
  });

  test("re-registering the same machine for the same member succeeds", async () => {
    await register();
    expect((await post("/api/register", goodReg())).status).toBe(200);
  });
});

describe("POST /api/usage", () => {
  test("no Authorization header -> 401", async () => {
    const res = await post("/api/usage", { records: [record()] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("bad token -> 401", async () => {
    const res = await post("/api/usage", { records: [record()] }, bearer("f".repeat(64)));
    expect(res.status).toBe(401);
  });

  test.each([
    ["wrong scheme", (t: string) => `Basic ${t}`],
    ["lowercase scheme", (t: string) => `bearer ${t}`],
    ["extra whitespace", (t: string) => `Bearer  ${t}`],
    ["no scheme", (t: string) => t],
    ["empty token", () => "Bearer "],
  ])("malformed Authorization (%s) -> 401 even with a valid token", async (_n, mk) => {
    const { token } = await register();
    const res = await post("/api/usage", { records: [record()] }, { Authorization: mk(token) });
    expect(res.status).toBe(401);
    expect(usageCount()).toBe(0);
  });

  test("auth is checked before the body (bad token + bad body -> 401)", async () => {
    const res = await post("/api/usage", "{oops", bearer("f".repeat(64)));
    expect(res.status).toBe(401);
  });

  test("invalid batch -> 400 and nothing stored", async () => {
    const { token } = await register();
    const res = await post("/api/usage", { records: [record({ total: 999 })] }, bearer(token));
    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    expect(usageCount()).toBe(0);
  });

  test("malformed JSON -> 400, not 500", async () => {
    const { token } = await register();
    const res = await post("/api/usage", "{oops", bearer(token));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  test("valid batch -> 200 {stored:1,kept:0}", async () => {
    const { token } = await register();
    const res = await post("/api/usage", { records: [record()] }, bearer(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 1, kept: 0 });
    expect(usageCount()).toBe(1);
  });

  test("lower total for the same day is kept, not stored", async () => {
    const { token } = await register();
    await post("/api/usage", { records: [record()] }, bearer(token));
    const res = await post("/api/usage", { records: [record({ input: 0, total: 9 })] }, bearer(token));
    expect(await res.json()).toEqual({ stored: 0, kept: 1 });
  });

  test("body memberId/machineId are ignored: row is stored under the token's identity", async () => {
    const other = await register({ email: "bob@example.com", name: "Bob", machineId: MID2 });
    const mine = await register();
    const res = await post(
      "/api/usage",
      { memberId: other.memberId, machineId: MID2, records: [{ ...record(), memberId: other.memberId, machineId: MID2 }] },
      bearer(mine.token),
    );
    expect(res.status).toBe(200);
    expect(db.prepare("select member_id, machine_id from usage").all()).toEqual([
      { member_id: mine.memberId, machine_id: MID },
    ]);
  });
});

describe("hardening", () => {
  test("body over 2 MB -> 413 JSON error", async () => {
    const big = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 1) });
    for (const path of ["/api/register", "/api/usage"]) {
      const res = await post(path, big);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload too large" });
    }
  });

  test("oversized body without content-length is still rejected (413)", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 1) }));
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(big);
        c.close();
      },
    });
    const res = await app.request("/api/register", {
      method: "POST",
      body: stream,
      headers: { "Content-Type": "application/json" },
      // @ts-expect-error duplex is required by undici for stream bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  test("unexpected errors -> generic 500 that leaks nothing", async () => {
    const boom = createApp(db, {
      inviteCode: () => {
        throw new Error("secret-internal-detail");
      },
      logError,
    });
    const res = await boom.request("/api/register", {
      method: "POST",
      body: JSON.stringify(goodReg()),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "internal error" });
    expect(text).not.toContain("secret-internal-detail");
  });

  test("a 500 logs one line with the error's class name and code only", async () => {
    class SqliteLikeError extends Error {
      code = "SQLITE_ERROR";
    }
    const boom = createApp(db, {
      inviteCode: () => {
        throw new SqliteLikeError("secret-internal-detail /path/to/db");
      },
      logError,
    });
    const res = await boom.request("/api/register", {
      method: "POST",
      body: JSON.stringify(goodReg({ email: "reflect-me@example.com" })),
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-secret" },
    });
    expect(res.status).toBe(500);
    expect(logged).toEqual(["teamusage: internal error (SqliteLikeError SQLITE_ERROR)"]);
  });

  test("the logged line never carries the message, an odd code or request data", async () => {
    const thrown: unknown[] = [
      Object.assign(new TypeError("secret-message"), { code: "lower case; secret" }),
      Object.assign(new Error("secret-message"), { code: 42 }),
    ];
    for (const value of thrown) {
      logged = [];
      const boom = createApp(db, {
        inviteCode: () => {
          throw value;
        },
        logError,
      });
      const res = await boom.request("/api/register", { method: "POST", body: JSON.stringify(goodReg()) });
      expect(res.status).toBe(500);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^teamusage: internal error \([A-Za-z]+\)$/);
      expect(logged[0]).not.toMatch(/secret|reflect|invite/);
    }
  });

  test("unknown route -> JSON 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("error responses never echo the token or submitted values", async () => {
    const token = "f".repeat(64);
    const res = await post("/api/usage", { records: [record()] }, bearer(token));
    expect(await res.text()).not.toContain(token);
    const res2 = await post("/api/register", goodReg({ email: "reflect-me" }));
    expect(await res2.text()).not.toContain("reflect-me");
  });
});

// ---- Task 6: stats, login, sessions, limiter ----
const sessionCookie = (res: Response): string => {
  const sc = res.headers.get("Set-Cookie") ?? "";
  return /tu_session=[^;]+/.exec(sc)?.[0] ?? "";
};
const login = (headers: Record<string, string> = {}, code = INVITE) => post("/api/login", { inviteCode: code }, headers);
const getStatsReq = (qs: string, headers: Record<string, string> = {}) => app.request(`/api/stats?${qs}`, { headers });
const RANGE = "from=2026-11-01&to=2026-11-10";

describe("POST /api/login", () => {
  test("correct invite code gives 204 and a hardened session cookie", async () => {
    const res = await login();
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const sc = res.headers.get("Set-Cookie") ?? "";
    expect(sc).toMatch(/^tu_session=[a-f0-9]{64};/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=2592000/);
    expect(sc).not.toMatch(/Secure/i);
  });

  test("cookie is Secure over https, by URL or X-Forwarded-Proto", async () => {
    const viaHeader = await login({ "X-Forwarded-Proto": "https" });
    expect(viaHeader.headers.get("Set-Cookie")).toMatch(/Secure/i);
    const viaUrl = await app.request("https://example.com/api/login", {
      method: "POST",
      body: JSON.stringify({ inviteCode: INVITE }),
      headers: { "Content-Type": "application/json" },
    });
    expect(viaUrl.headers.get("Set-Cookie")).toMatch(/Secure/i);
  });

  test("wrong invite code is 403 with no cookie", async () => {
    const res = await login({}, "nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid invite code" });
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("bad bodies are 400", async () => {
    expect((await post("/api/login", "{")).status).toBe(400);
    expect((await post("/api/login", [])).status).toBe(400);
    expect((await post("/api/login", { inviteCode: 5 })).status).toBe(403);
  });
});

describe("GET /api/stats", () => {
  test("no auth is 401, with no-store", async () => {
    const res = await getStatsReq(RANGE);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a cookie from /api/login is accepted; a forged or rotated one is not", async () => {
    const cookie = sessionCookie(await login());
    const res = await getStatsReq(RANGE, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(((await res.json()) as { daily: unknown[] }).daily).toHaveLength(10);
    expect((await getStatsReq(RANGE, { Cookie: "tu_session=" + "0".repeat(64) })).status).toBe(401);
    db.prepare("delete from sessions").run();
    expect((await getStatsReq(RANGE, { Cookie: cookie })).status).toBe(401);
  });

  test("a bearer token is accepted and wins over a cookie; a bad token is 401 even with a valid cookie", async () => {
    const { token } = await register();
    expect((await getStatsReq(RANGE, bearer(token))).status).toBe(200);
    const cookie = sessionCookie(await login());
    expect((await getStatsReq(RANGE, { ...bearer(token), Cookie: cookie })).status).toBe(200);
    expect((await getStatsReq(RANGE, { ...bearer("bad"), Cookie: cookie })).status).toBe(401);
  });

  test("returns aggregated numbers and only Stats fields", async () => {
    const { token, memberId } = await register();
    await register({ email: "bob@example.com", name: "Bob", machineId: MID2 });
    await post("/api/usage", { records: [record({ total: 10 })] }, bearer(token));
    const res = await getStatsReq(RANGE, bearer(token));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["available", "daily", "from", "members", "models", "to", "totals"]);
    expect((body.totals as { tokens: number; memberCount: number }).tokens).toBe(10);
    expect((body.totals as { memberCount: number }).memberCount).toBe(2);
    const text = JSON.stringify(body);
    for (const secret of [token, MID, MID2, "mbp"]) expect(text).not.toContain(secret);
    expect(Object.keys((body.members as object[])[0] as object).sort()).toEqual([
      "byAccount", "byAccountPlan", "byAgent", "costUsd", "email", "id", "lastSyncAt", "machines", "name", "tokens",
    ]);
    expect(Object.keys(body.available as object).sort()).toEqual(["accounts", "agents", "models", "plans"]);
    expect(memberId).toBeGreaterThan(0);
  });

  test("member=me with a token filters to that member", async () => {
    const { token } = await register();
    const bob = await register({ email: "bob@example.com", name: "Bob", machineId: MID2 });
    await post("/api/usage", { records: [record({ total: 10 })] }, bearer(token));
    await post("/api/usage", { records: [record({ total: 99 })] }, bearer(bob.token));
    const body = (await (await getStatsReq(`${RANGE}&member=me`, bearer(token))).json()) as {
      totals: { tokens: number; memberCount: number };
      members: { name: string }[];
    };
    expect(body.totals).toMatchObject({ tokens: 10, memberCount: 1 });
    expect(body.members.map((m) => m.name)).toEqual(["Ann"]);
  });

  test("member=me with only a cookie is 400", async () => {
    const cookie = sessionCookie(await login());
    expect((await getStatsReq(`${RANGE}&member=me`, { Cookie: cookie })).status).toBe(400);
  });

  test("a repeated member parameter is 400 invalid query", async () => {
    const cookie = sessionCookie(await login());
    const res = await getStatsReq(`${RANGE}&member=1&member=2`, { Cookie: cookie });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
  });

  test("member=me with a token and an agent filter counts only that member's usage by that agent", async () => {
    const { token } = await register();
    const bob = await register({ email: "bob@example.com", name: "Bob", machineId: MID2 });
    await post(
      "/api/usage",
      { records: [record({ agent: "claude", model: "opus-4-7", total: 10 }), record({ agent: "codex", model: "gpt", total: 20, input: 11 })] },
      bearer(token),
    );
    await post("/api/usage", { records: [record({ agent: "codex", model: "gpt", total: 99 })] }, bearer(bob.token));
    const res = await getStatsReq(`${RANGE}&member=me&agent=codex`, bearer(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { tokens: number; memberCount: number }; members: { name: string; tokens: number }[] };
    expect(body.totals.tokens).toBe(20);
    expect(body.members.map((m) => [m.name, m.tokens])).toEqual([["Ann", 20]]);
  });

  test("member=me includes machines by label and last sync only", async () => {
    const { token } = await register();
    await post("/api/usage", { records: [record()] }, bearer(token));
    const res = await getStatsReq(`${RANGE}&member=me`, bearer(token));
    const body = (await res.json()) as { machines: { label: string; lastSyncAt: string | null }[] };
    expect(body.machines).toHaveLength(1);
    expect(Object.keys(body.machines[0] as object).sort()).toEqual(["label", "lastSyncAt"]);
    expect(body.machines[0]?.label).toBe("mbp");
    expect(body.machines[0]?.lastSyncAt).not.toBeNull();
    const text = JSON.stringify(body);
    for (const secret of [token, MID]) expect(text).not.toContain(secret);
  });

  test("member=<id> works with a session, any token and demo mode, and leaks no secrets", async () => {
    const ann = await register();
    const bob = await register({ email: "bob@example.com", name: "Bob", machineId: MID2, machineLabel: "box" });
    await post("/api/usage", { records: [record({ total: 10 })] }, bearer(ann.token));
    await post("/api/usage", { records: [record({ output: 91, total: 99 })] }, bearer(bob.token));
    const cookie = { Cookie: sessionCookie(await login()) };
    const demoApp = createApp(db, { inviteCode: () => INVITE, demo: true });
    const hashes = (db.prepare("select token_hash as h from machines").all() as { h: string }[]).map((r) => r.h);
    const responses = [
      await getStatsReq(`${RANGE}&member=${bob.memberId}`, cookie),
      await getStatsReq(`${RANGE}&member=${bob.memberId}`, bearer(ann.token)), // another member's id
      await demoApp.request(`/api/stats?${RANGE}&member=${bob.memberId}`),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text) as {
        totals: { tokens: number; memberCount: number };
        members: { id: number; name: string }[];
        machines: { label: string }[];
      };
      expect(body.totals).toMatchObject({ tokens: 99, memberCount: 1 });
      expect(body.members.map((m) => [m.id, m.name])).toEqual([[bob.memberId, "Bob"]]);
      expect(body.machines.map((m) => m.label)).toEqual(["box"]);
      for (const secret of [ann.token, bob.token, MID, MID2, ...hashes]) expect(text).not.toContain(secret);
    }
  });

  test("a well-formed member id that does not exist is 404", async () => {
    const cookie = { Cookie: sessionCookie(await login()) };
    const res = await getStatsReq(`${RANGE}&member=999999`, cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "member not found" });
  });

  test("malformed member values are 400 invalid query and never echoed", async () => {
    const cookie = { Cookie: sessionCookie(await login()) };
    for (const v of ["0", "-1", "01", "1.5", "abc", "1%20or%201%3D1", "12345678901", "", "9007199254740993", "ME"]) {
      const res = await getStatsReq(`${RANGE}&member=${v}`, cookie);
      expect(res.status, v).toBe(400);
      expect(await res.json(), v).toEqual({ error: "invalid query" });
    }
  });

  test("bad dates are 400 with a fixed message", async () => {
    const cookie = { Cookie: sessionCookie(await login()) };
    const bad = [
      "from=2026-11-10&to=2026-11-01", // reversed
      "from=2026-11-01", // missing to
      "to=2026-11-01",
      "from=2026-02-30&to=2026-03-01", // not a real date
      "from=2026-1-01&to=2026-11-01", // not strict
      "from=2026-11-01&to=2026-11-01x",
      "from=%20&to=2026-11-01",
      "from=2024-01-01&to=2026-01-01", // > 730 days
    ];
    for (const qs of bad) {
      const res = await getStatsReq(qs, cookie);
      expect(res.status, qs).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid date range" });
    }
  });

  test("span limit is 730 days inclusive", async () => {
    const cookie = { Cookie: sessionCookie(await login()) };
    expect((await getStatsReq("from=2025-01-01&to=2026-12-31", cookie)).status).toBe(200); // 730 days
    expect((await getStatsReq("from=2025-01-01&to=2027-01-01", cookie)).status).toBe(400); // 731 days
  });

  test("demo mode needs no auth, and member=me is 400", async () => {
    const demoApp = createApp(db, { inviteCode: () => INVITE, demo: true });
    expect((await demoApp.request(`/api/stats?${RANGE}`)).status).toBe(200);
    expect((await demoApp.request(`/api/stats?${RANGE}&member=me`)).status).toBe(400);
    expect((await demoApp.request("/api/stats?from=x&to=y")).status).toBe(400);
  });
});

describe("failed-attempt limiting", () => {
  const limited = (clock: { t: number }) =>
    createApp(db, { inviteCode: () => INVITE, now: () => clock.t });
  const attempt = (a: ReturnType<typeof createApp>, path: string, code: string, headers: Record<string, string> = {}) =>
    a.request(path, {
      method: "POST",
      body: JSON.stringify(path === "/api/login" ? { inviteCode: code } : goodReg({ inviteCode: code })),
      headers: { "Content-Type": "application/json", ...headers },
    });

  for (const path of ["/api/login", "/api/register"]) {
    test(`${path}: 10 wrong codes then 429 with Retry-After, until the window passes`, async () => {
      const clock = { t: 1_000_000 };
      const a = limited(clock);
      for (let i = 0; i < 10; i++) expect((await attempt(a, path, "wrong")).status).toBe(403);
      const blocked = await attempt(a, path, "wrong");
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ error: "too many attempts" });
      expect(blocked.headers.get("Retry-After")).toBe("600");
      // even the correct code is refused while blocked
      expect((await attempt(a, path, INVITE)).status).toBe(429);
      clock.t += 599_000;
      expect((await attempt(a, path, INVITE)).status).toBe(429);
      clock.t += 1_000;
      expect((await attempt(a, path, INVITE)).status).toBeLessThan(300);
    });
  }

  test("successes do not count", async () => {
    const a = limited({ t: 1 });
    for (let i = 0; i < 15; i++) expect((await attempt(a, "/api/login", INVITE)).status).toBe(204);
    expect((await attempt(a, "/api/login", "wrong")).status).toBe(403);
  });

  test("clients are keyed by the clientKey option, not by any header", async () => {
    const a = createApp(db, {
      inviteCode: () => INVITE,
      now: () => 1,
      clientKey: (c) => c.req.header("X-Test-Client") ?? "none",
    });
    for (let i = 0; i < 10; i++) await attempt(a, "/api/login", "wrong", { "X-Test-Client": "A" });
    expect((await attempt(a, "/api/login", "wrong", { "X-Test-Client": "A" })).status).toBe(429);
    expect((await attempt(a, "/api/login", "wrong", { "X-Test-Client": "B" })).status).toBe(403);
  });

  test("without clientKey every client shares one key and X-Forwarded-For is ignored", async () => {
    const clock = { t: 1_000_000 };
    const a = limited(clock);
    for (let i = 0; i < 10; i++) {
      expect((await attempt(a, "/api/login", "wrong", { "X-Forwarded-For": `1.1.1.${i}` })).status).toBe(403);
    }
    const res = await attempt(a, "/api/login", INVITE, { "X-Forwarded-For": "8.8.8.8" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    clock.t += 600_000;
    expect((await attempt(a, "/api/login", INVITE)).status).toBe(204);
  });
});

describe("upload bounds", () => {
  const many = (n: number, over: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => record({ model: `m${i}`, ...over }));
  const atCaps = {
    input: MAX_TOKENS, output: MAX_TOKENS, cacheCreate: MAX_TOKENS, cacheRead: MAX_TOKENS,
    total: MAX_TOTAL_TOKENS, costUsd: MAX_COST_USD,
  };
  const machines = (n: number) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        register({ email: `m${i}@example.com`, machineId: i.toString(16).padStart(32, "0") }),
      ),
    );
  const finiteNumbers = (v: unknown): boolean =>
    typeof v === "number" ? Number.isFinite(v)
    : Array.isArray(v) ? v.every(finiteNumbers)
    : typeof v === "object" && v !== null ? Object.values(v).every(finiteNumbers)
    : true;

  test("rows near MAX_SAFE_INTEGER are refused, so they cannot overflow /api/stats", async () => {
    const big = Number.MAX_SAFE_INTEGER;
    for (const { token } of await machines(2)) {
      const res = await post("/api/usage", { records: many(1000, { input: big, output: 0, cacheCreate: 0, cacheRead: 0, total: big }) }, bearer(token));
      expect(res.status).toBe(400);
    }
    expect(usageCount()).toBe(0);
    expect((await getStatsReq(RANGE, { Cookie: sessionCookie(await login()) })).status).toBe(200);
  });

  test("a huge cost or model name is refused", async () => {
    const { token } = await register();
    for (const over of [{ costUsd: 1e308 }, { model: "m".repeat(2 * 1024 * 1024 - 1000) }]) {
      expect((await post("/api/usage", { records: [record(over)] }, bearer(token))).status).toBe(400);
    }
    expect(usageCount()).toBe(0);
  });

  test("rows whose true sum exceeds the 64-bit range (bypassing upload validation) keep /api/stats at 200", async () => {
    const { token } = await register();
    expect((await post("/api/usage", { records: [record()] }, bearer(token))).status).toBe(200);
    const { member_id: memberId, id } = db.prepare("select member_id, id from machines").get() as { member_id: number; id: string };
    const ins = db.prepare(
      `insert into usage (team_id, member_id, machine_id, date, agent, model, input, output, cache_create, cache_read, total, cost_usd, unpriced)
       values (1, ?, ?, '2026-11-01', 'claude', ?, ?, ?, ?, ?, ?, 1, 0)`,
    );
    const big = 2 ** 62;
    for (let i = 0; i < 4; i++) ins.run(memberId, id, `big${i}`, big, big, big, big, big);
    const res = await getStatsReq(RANGE, { Cookie: sessionCookie(await login()) });
    expect(res.status).toBe(200);
    expect(finiteNumbers(await res.json())).toBe(true);
  });

  test("rows at the caps from several machines keep /api/stats at 200 with finite numbers", async () => {
    for (const { token } of await machines(3)) {
      expect((await post("/api/usage", { records: many(1000, atCaps) }, bearer(token))).status).toBe(200);
    }
    const res = await getStatsReq(RANGE, { Cookie: sessionCookie(await login()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { tokens: number; costUsd: number } };
    expect(finiteNumbers(body)).toBe(true);
    expect(body.totals.tokens).toBe(3000 * MAX_TOTAL_TOKENS);
    expect(body.totals.costUsd).toBe(3000 * MAX_COST_USD);
    expect(logged).toEqual([]);
  });
});

describe("POST /api/register input hygiene", () => {
  test("control characters in name or machineLabel are 400", async () => {
    for (const bad of ["a\nb", "a\x00b", "a\x7fb", "a\tb", "\x1bx"]) {
      expect((await post("/api/register", goodReg({ name: bad }))).status).toBe(400);
      expect((await post("/api/register", goodReg({ machineLabel: bad }))).status).toBe(400);
    }
    expect((await post("/api/register", goodReg())).status).toBe(200);
  });
});

describe("hardening details", () => {
  test("Secure uses the first X-Forwarded-Proto token, trimmed and lower-cased", async () => {
    expect((await login({ "X-Forwarded-Proto": " HTTPS , http" })).headers.get("Set-Cookie")).toMatch(/Secure/i);
    expect((await login({ "X-Forwarded-Proto": "http, https" })).headers.get("Set-Cookie")).not.toMatch(/Secure/i);
  });

  test("repeated query parameters are 400 invalid query", async () => {
    const cookie = { Cookie: sessionCookie(await login()) };
    for (const qs of [`${RANGE}&from=2026-11-02`, `${RANGE}&to=2026-11-09`, `${RANGE}&member=me&member=me`]) {
      const res = await getStatsReq(qs, cookie);
      expect(res.status, qs).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid query" });
    }
  });

  test("control characters in email are 400", async () => {
    expect((await post("/api/register", goodReg({ email: "a\n@example.com" }))).status).toBe(400);
  });

  test("a failure inside /api/stats is a fixed 500 JSON error", async () => {
    const cookie = { Cookie: sessionCookie(await login()) };
    db.exec("drop table usage");
    const res = await getStatsReq(RANGE, cookie);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});

describe("agent and model filters", () => {
  const seedUsage = async () => {
    const ann = await register();
    await post(
      "/api/usage",
      {
        records: [
          record({ agent: "claude", model: "opus-4-7" }),
          record({ agent: "codex", model: "gpt", total: 20, input: 11 }),
          record({ agent: "x", model: "a:b", total: 10 }),
        ],
      },
      bearer(ann.token),
    );
    return { cookie: { Cookie: sessionCookie(await login()) } };
  };
  const stats = async (qs: string, headers: Record<string, string>) => {
    const res = await getStatsReq(`${RANGE}${qs}`, headers);
    return { res, body: (await res.json()) as { totals: { tokens: number }; models: { agent: string; model: string }[]; available: { agents: string[] } } };
  };

  test("repeated agent and model parameters work", async () => {
    const { cookie } = await seedUsage();
    expect((await stats("&agent=claude&agent=codex", cookie)).body.totals.tokens).toBe(30);
    const m = await stats("&model=claude:opus-4-7", cookie);
    expect(m.res.status).toBe(200);
    expect(m.body.totals.tokens).toBe(10);
    expect(m.body.available.agents.sort()).toEqual(["claude", "codex", "x"]);
    expect((await stats("&agent=claude&model=codex:gpt", cookie)).body.totals.tokens).toBe(0);
  });

  test("a model name containing a colon splits on the first colon", async () => {
    const { cookie } = await seedUsage();
    const r = await stats("&model=x:a:b", cookie);
    expect(r.body.totals.tokens).toBe(10);
    expect(r.body.models).toEqual([expect.objectContaining({ agent: "x", model: "a:b" })]);
  });

  test("duplicates are collapsed and filters work with member and bearer auth", async () => {
    const { cookie } = await seedUsage();
    expect((await stats("&agent=claude&agent=claude&model=claude:opus-4-7&model=claude:opus-4-7", cookie)).body.totals.tokens).toBe(10);
  });

  test("invalid agent and model values are 400 invalid query and never echoed", async () => {
    const { cookie } = await seedUsage();
    const many = (k: string, n: number) => Array.from({ length: n }, (_, i) => `&${k}=${k === "model" ? `a${i}:m` : `a${i}`}`).join("");
    const bad = [
      many("agent", 21),
      many("model", 51),
      "&agent=",
      "&model=",
      "&agent=a%0Ab",
      "&agent=a%00b",
      "&agent=a%7Fb",
      "&model=a:b%0Ac",
      `&agent=${"a".repeat(65)}`,
      `&model=${"a".repeat(65)}:m`,
      `&model=a:${"m".repeat(129)}`,
      "&model=nocolon",
      "&model=:m",
      "&model=a:",
      "&model=:",
    ];
    for (const qs of bad) {
      const res = await getStatsReq(`${RANGE}${qs}`, cookie);
      expect(res.status, qs.slice(0, 40)).toBe(400);
      expect(await res.json(), qs.slice(0, 40)).toEqual({ error: "invalid query" });
    }
    expect((await getStatsReq(`${RANGE}${many("agent", 20)}${many("model", 50)}`, cookie)).status).toBe(200);
    expect((await getStatsReq(`${RANGE}&agent=${"a".repeat(64)}&model=${"a".repeat(64)}:${"m".repeat(128)}`, cookie)).status).toBe(200);
  });

  test("injection-looking values are bound as data and match nothing", async () => {
    const { cookie } = await seedUsage();
    for (const v of ["claude' or '1'='1", "claude\" or 1=1 --", "%", "x'); drop table usage; --"]) {
      const a = await stats(`&agent=${encodeURIComponent(v)}`, cookie);
      expect(a.res.status).toBe(200);
      expect(a.body.totals.tokens).toBe(0);
      const m = await stats(`&model=${encodeURIComponent(`${v}:${v}`)}`, cookie);
      expect(m.body.totals.tokens).toBe(0);
    }
    expect((await stats("", cookie)).body.totals.tokens).toBe(40);
  });

  test("filters are validated before the member lookup; the repeat rule for from, to and member stays", async () => {
    const { cookie } = await seedUsage();
    expect((await getStatsReq(`${RANGE}&member=999999&agent=`, cookie)).status).toBe(400);
    expect((await getStatsReq(`${RANGE}&member=999999&agent=claude`, cookie)).status).toBe(404);
    for (const qs of ["&from=2026-11-02&agent=claude", "&member=me&member=me&agent=a", "&to=2026-11-09&model=a:b"]) {
      const res = await getStatsReq(`${RANGE}${qs}`, cookie);
      expect(res.status, qs).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid query" });
    }
  });

  test("filters do not bypass authentication", async () => {
    await seedUsage();
    expect((await getStatsReq(`${RANGE}&agent=claude`, {})).status).toBe(401);
  });
});

describe("account filter", () => {
  const seedAccounts = async () => {
    const ann = await register();
    const up = await post(
      "/api/usage",
      {
        records: [
          record({ model: "opus", total: 100, input: 91, account: { kind: "team", org: "D" } }),
          record({ model: "sonnet", total: 40, input: 31, account: { kind: "personal" } }),
          record({ model: "haiku", total: 13, input: 4, account: { kind: "team", org: "a:b" } }),
          record({ agent: "codex", model: "gpt", total: 10 }),
        ],
      },
      bearer(ann.token),
    );
    expect(up.status).toBe(200);
    return { cookie: { Cookie: sessionCookie(await login()) } };
  };
  type Body = { totals: { tokens: number }; available: { accounts: { key: string; tokens: number }[] }; members: { byAccount: Record<string, number> }[] };
  const stats = async (qs: string, headers: Record<string, string>) => {
    const res = await getStatsReq(`${RANGE}${qs}`, headers);
    return { res, body: (await res.json()) as Body };
  };

  test("repeated account parameters are alternatives; available accounts and byAccount are returned", async () => {
    const { cookie } = await seedAccounts();
    const r = await stats("&account=personal&account=team:D", cookie);
    expect(r.res.status).toBe(200);
    expect(r.body.totals.tokens).toBe(140);
    expect(r.body.members[0]?.byAccount).toEqual({ "team:D": 100, personal: 40 });
    expect(r.body.available.accounts).toEqual([
      { key: "team:D", tokens: 100 },
      { key: "personal", tokens: 40 },
      { key: "team:a:b", tokens: 13 },
      { key: "other", tokens: 10 },
    ]);
    expect((await stats("&account=unknown", cookie)).body.totals.tokens).toBe(0);
    expect((await stats("&account=other", cookie)).body.totals.tokens).toBe(10);
    expect((await stats("&account=personal&account=personal", cookie)).body.totals.tokens).toBe(40);
  });

  test("an org containing a colon splits on the first colon", async () => {
    const { cookie } = await seedAccounts();
    expect((await stats("&account=team:a:b", cookie)).body.totals.tokens).toBe(13);
    expect((await stats("&account=team:a", cookie)).body.totals.tokens).toBe(0);
  });

  test("malformed or too many account values are 400 invalid query and never echoed", async () => {
    const { cookie } = await seedAccounts();
    const many = (n: number) => Array.from({ length: n }, (_, i) => `&account=team:o${i}`).join("");
    const bad = [
      many(51),
      "&account=boss",
      "&account=",
      "&account=Personal",
      "&account=unknown:x",
      "&account=personal:x",
      "&account=org:x",
      "&account=:x",
      "&account=team:a%0Ab",
      `&account=team:${"o".repeat(101)}`,
    ];
    for (const qs of bad) {
      const res = await getStatsReq(`${RANGE}${qs}`, cookie);
      expect(res.status, qs.slice(0, 40)).toBe(400);
      expect(await res.json(), qs.slice(0, 40)).toEqual({ error: "invalid query" });
    }
    expect((await getStatsReq(`${RANGE}${many(50)}`, cookie)).status).toBe(200);
    expect((await getStatsReq(`${RANGE}&account=team:${"o".repeat(100)}&account=enterprise:&account=api`, cookie)).status).toBe(200);
  });

  test("account values are validated before the member lookup and do not bypass authentication", async () => {
    const { cookie } = await seedAccounts();
    expect((await getStatsReq(`${RANGE}&member=999999&account=boss`, cookie)).status).toBe(400);
    expect((await getStatsReq(`${RANGE}&member=999999&account=personal`, cookie)).status).toBe(404);
    expect((await getStatsReq(`${RANGE}&account=personal`, {})).status).toBe(401);
  });
});

describe("plan filter", () => {
  const seedPlans = async () => {
    const ann = await register();
    const up = await post(
      "/api/usage",
      {
        records: [
          record({ agent: "codex", model: "gpt", total: 200, input: 191, account: { kind: "personal", plan: "plus" } }),
          record({ model: "opus", total: 50, input: 41 }),
        ],
      },
      bearer(ann.token),
    );
    expect(up.status).toBe(200);
    return { cookie: { Cookie: sessionCookie(await login()) } };
  };

  test("plan filters totals and is validated", async () => {
    const { cookie } = await seedPlans();
    const tokens = async (qs: string) => ((await (await getStatsReq(`${RANGE}${qs}`, cookie)).json()) as { totals: { tokens: number } }).totals.tokens;
    expect(await tokens("&plan=codex:plus")).toBe(200);
    expect(await tokens("&plan=none")).toBe(50);
    expect(await tokens("&plan=none&plan=codex:plus&plan=codex:plus")).toBe(250);
    expect((await getStatsReq(`${RANGE}&plan=bogus`, cookie)).status).toBe(400);
    expect((await getStatsReq(`${RANGE}&plan=claude:plus`, cookie)).status).toBe(400);
    const many = (n: number) => Array.from({ length: n }, () => "&plan=codex:plus").join("");
    expect((await getStatsReq(`${RANGE}${many(51)}`, cookie)).status).toBe(400);
    expect((await getStatsReq(`${RANGE}${many(50)}`, cookie)).status).toBe(200);
    expect((await getStatsReq(`${RANGE}&plan=codex:plus`, {})).status).toBe(401);
  });
});
