import { describe, expect, test } from "vitest";
import { MAX_COST_USD, MAX_TOKENS, MAX_TOTAL_TOKENS } from "@teamusage/shared";
import { MID, MID2, record } from "./app.fixture.js";
import { bearer, db, getStatsReq, logged, login, post, RANGE, register, sessionCookie, useFreshApp } from "./app.harness.js";

useFreshApp();

const usageCount = () => (db.prepare("select count(*) as n from usage").get() as { n: number }).n;

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

  test("every answer is no-store", async () => {
    const { token } = await register();
    const answers = [await post("/api/usage", { records: [record()] }, bearer(token)), await post("/api/usage", { records: [record()] })];
    expect(answers.map((r) => r.status)).toEqual([200, 401]);
    for (const r of answers) expect(r.headers.get("cache-control")).toBe("no-store");
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

