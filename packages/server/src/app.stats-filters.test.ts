import { describe, expect, test } from "vitest";
import { record } from "./app.fixture.js";
import { bearer, getStatsReq, login, post, RANGE, register, sessionCookie, useFreshApp } from "./app.harness.js";

useFreshApp();

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
