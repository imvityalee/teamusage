import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchStats, login } from "./api.js";
import { memberStatsFixture, statsFixture } from "./test-fixtures.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function stubFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected request");
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchStats", () => {
  test("asks the same origin for the range, with the session cookie", async () => {
    const stats = statsFixture();
    const fetch = stubFetch(json(stats));
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "ok", stats });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/stats?from=2026-01-01&to=2026-01-31");
    expect(init.credentials).toBe("same-origin");
  });

  test("maps 401, other errors and network failure", async () => {
    stubFetch(json({ error: "unauthorized" }, 401), json({ error: "invalid date range" }, 400), new TypeError("offline"));
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "unauthorized" });
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "error", message: "invalid date range" });
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "network" });
  });

  test("a body that is not stats is an error, not a crash", async () => {
    stubFetch(json({ totals: "nope" }), new Response("<html>", { status: 502 }));
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "error", message: "unexpected response" });
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "error", message: "HTTP 502" });
  });

  test("an aborted request reports as aborted", async () => {
    stubFetch(new DOMException("aborted", "AbortError"));
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "aborted" });
  });
});

describe("login", () => {
  test("sends the invite code only in the body of a same-origin POST to /api/login", async () => {
    const fetch = stubFetch(new Response(null, { status: 204 }));
    expect(await login("s3cret-invite-code")).toEqual({ kind: "ok" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/login");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({ inviteCode: "s3cret-invite-code" });
    expect(url).not.toContain("s3cret");
  });

  test("maps 403, 429 with Retry-After, other statuses and network failure", async () => {
    stubFetch(
      json({ error: "invalid invite code" }, 403),
      json({ error: "too many attempts" }, 429, { "Retry-After": "90" }),
      json({ error: "too many attempts" }, 429),
      json({ error: "invalid JSON body" }, 400),
      new TypeError("offline"),
    );
    expect(await login("x")).toEqual({ kind: "wrong" });
    expect(await login("x")).toEqual({ kind: "tooMany", retryAfterSec: 90 });
    expect(await login("x")).toEqual({ kind: "tooMany", retryAfterSec: 60 });
    expect(await login("x")).toEqual({ kind: "error" });
    expect(await login("x")).toEqual({ kind: "network" });
  });
});

describe("fetchStats for one member", () => {
  test("adds the numeric member id and maps 404 to not found", async () => {
    const fetch = stubFetch(json(memberStatsFixture()), json({ error: "member not found" }, 404));
    expect(await fetchStats("2026-01-01", "2026-01-31", undefined, 1)).toEqual({ kind: "ok", stats: memberStatsFixture() });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/stats?from=2026-01-01&to=2026-01-31&member=1");
    expect(init.credentials).toBe("same-origin");
    expect(await fetchStats("2026-01-01", "2026-01-31", undefined, 999999)).toEqual({ kind: "notFound" });
  });

  test("an invalid id is never sent", async () => {
    const fetch = stubFetch();
    for (const bad of [0, -1, 1.5, Number.NaN, 1e21, "1&member=2" as unknown as number]) {
      expect(await fetchStats("2026-01-01", "2026-01-31", undefined, bad)).toEqual({ kind: "error", message: "invalid member" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("an answer without that member or without machines is unexpected", async () => {
    stubFetch(json(statsFixture()), json({ ...memberStatsFixture(), members: [] }), json({ ...memberStatsFixture(), machines: "x" }));
    for (let i = 0; i < 3; i++) {
      expect(await fetchStats("2026-01-01", "2026-01-31", undefined, 1)).toEqual({ kind: "error", message: "unexpected response" });
    }
  });

  test("a 404 for the team stats stays an ordinary error", async () => {
    stubFetch(json({ error: "not found" }, 404));
    expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "error", message: "not found" });
  });
});

describe("fetchStats with filters", () => {
  test("sends agents, models and accounts as repeated, encoded parameters after the range and member", async () => {
    const fetch = stubFetch(json(memberStatsFixture()));
    const filters = {
      agents: ["codex", `claude"><img src=x>`],
      models: [{ agent: "claude", model: "opus 4/7&member=2#x" }, { agent: "x", model: "a:b" }],
      accounts: ["team:a&member=2#x", "unknown"],
      plans: ["claude:pro", "none"],
    };
    await fetchStats("2026-01-01", "2026-01-31", undefined, 1, filters);
    const [url] = fetch.mock.calls[0] as unknown as [string];
    expect(url.startsWith("/api/stats?")).toBe(true);
    const q = new URLSearchParams(url.slice("/api/stats?".length));
    expect([...q]).toEqual([
      ["from", "2026-01-01"],
      ["to", "2026-01-31"],
      ["member", "1"],
      ["agent", "codex"],
      ["agent", `claude"><img src=x>`],
      ["model", "claude:opus 4/7&member=2#x"],
      ["model", "x:a:b"],
      ["account", "team:a&member=2#x"],
      ["account", "unknown"],
      ["plan", "claude:pro"],
      ["plan", "none"],
    ]);
    expect(q.getAll("member")).toEqual(["1"]);
  });

  test("no filters, no filter parameters; never more than 20 agents and 50 models", async () => {
    const fetch = stubFetch(json(statsFixture()), json(statsFixture()));
    await fetchStats("2026-01-01", "2026-01-31", undefined, undefined, { agents: [], models: [], accounts: [], plans: [] });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("/api/stats?from=2026-01-01&to=2026-01-31");
    const many = {
      agents: Array.from({ length: 25 }, (_, i) => `a${i}`),
      models: Array.from({ length: 60 }, (_, i) => ({ agent: "a", model: `m${i}` })),
      accounts: [],
      plans: [],
    };
    await fetchStats("2026-01-01", "2026-01-31", undefined, undefined, many);
    const q = new URLSearchParams((fetch.mock.calls[1] as unknown as [string])[0].split("?")[1]);
    expect(q.getAll("agent")).toHaveLength(20);
    expect(q.getAll("model")).toHaveLength(50);
  });

  test("an answer without the filter lists is unexpected", async () => {
    stubFetch(json({ ...statsFixture(), available: undefined }), json({ ...statsFixture(), available: { agents: "x", models: [] } }));
    for (let i = 0; i < 2; i++) {
      expect(await fetchStats("2026-01-01", "2026-01-31")).toEqual({ kind: "error", message: "unexpected response" });
    }
  });
});

describe("fetchStats cleans the filter lists", () => {
  test("malformed agents and models are dropped, so a null cannot make prune throw or show NaN", async () => {
    const body = {
      ...statsFixture(),
      available: {
        agents: [null, "claude", 5, "codex"],
        models: [
          null,
          { agent: "claude", model: "m1", tokens: 10 },
          { agent: "claude", model: "m2", tokens: "12" },
          { agent: "claude", model: null, tokens: 1 },
          { agent: 7, model: "m3", tokens: 1 },
          { agent: "codex", model: "m4", tokens: Number.MAX_VALUE },
          "x",
        ],
      },
    };
    stubFetch(json(body));
    const res = await fetchStats("2026-01-01", "2026-01-31");
    expect(res.kind).toBe("ok");
    const available = (res as { stats: { available: unknown } }).stats.available;
    expect(available).toEqual({
      agents: ["claude", "codex"],
      models: [
        { agent: "claude", model: "m1", tokens: 10 },
        { agent: "codex", model: "m4", tokens: Number.MAX_VALUE },
      ],
      accounts: [],
      plans: [],
    });
  });
});
