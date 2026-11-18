import { afterEach, describe, expect, test, vi } from "vitest";
import { checkRange, fetchStats, login } from "./api.js";
import { statsFixture } from "./test-fixtures.js";

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

describe("checkRange", () => {
  test("accepts ordered real dates up to 730 days", () => {
    expect(checkRange("2026-01-01", "2026-01-01")).toBe("ok");
    expect(checkRange("2024-11-19", "2026-11-18")).toBe("ok"); // 730 days inclusive
  });

  test("rejects missing, reversed and too long ranges", () => {
    expect(checkRange("", "2026-01-01")).toBe("incomplete");
    expect(checkRange("2026-02-30", "2026-03-01")).toBe("incomplete");
    expect(checkRange("2026-02-01", "2026-01-01")).toBe("order");
    expect(checkRange("2024-11-18", "2026-11-18")).toBe("tooLong"); // 731 days
  });
});
