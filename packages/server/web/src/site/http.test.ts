import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_ERROR_CHARS, request } from "./http.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function answer(reply: Response | Error) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  test("a 200 is ok with its JSON", async () => {
    answer(json({ a: 1 }));
    expect(await request("GET", "/api/me")).toEqual({ kind: "ok", value: { a: 1 } });
  });

  test("a 204 is ok with no value", async () => {
    answer(new Response(null, { status: 204 }));
    expect(await request("POST", "/api/logout")).toEqual({ kind: "ok", value: undefined });
  });

  test("a 401 is unauthorized", async () => {
    answer(json({ error: "unauthorized" }, 401));
    expect(await request("GET", "/api/me")).toEqual({ kind: "unauthorized" });
  });

  test("a 403 is refused with the server's text", async () => {
    answer(json({ error: "this link is no longer valid; ask your agent for a new one" }, 403));
    expect(await request("POST", "/api/dashboard-link/open", { token: "x" })).toEqual({
      kind: "refused",
      status: 403,
      error: "this link is no longer valid; ask your agent for a new one",
    });
  });

  test("a 429 is refused with its Retry-After", async () => {
    answer(json({ error: "too many attempts" }, 429, { "Retry-After": "7" }));
    expect(await request("POST", "/api/login", {})).toEqual({ kind: "refused", status: 429, error: "too many attempts", retryAfterSec: 7 });
  });

  test("a 404 in plain text, as a self-hosted server answers an unknown path, is refused with no text", async () => {
    answer(new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } }));
    expect(await request("GET", "/api/me")).toEqual({ kind: "refused", status: 404, error: "" });
  });

  test("a proxy's HTML page is refused with no text, so no markup reaches a page", async () => {
    answer(new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", { status: 413, headers: { "Content-Type": "text/html" } }));
    expect(await request("POST", "/api/teams", {})).toEqual({ kind: "refused", status: 413, error: "" });
  });

  test.each([["an array", ["boom"]], ["a number", 7], ["null", null], ["an object without error", { message: "x" }], ["a non-string error", { error: 7 }]])(
    "a refusal whose JSON is %s has no text",
    async (_, body) => {
      answer(json(body, 400));
      expect(await request("GET", "/api/me")).toEqual({ kind: "refused", status: 400, error: "" });
    },
  );

  test(`a refusal's text of ${MAX_ERROR_CHARS} characters is kept whole; a longer one is cut to that length, ending in …`, async () => {
    expect(MAX_ERROR_CHARS).toBe(300);
    const whole = "é".repeat(MAX_ERROR_CHARS);
    answer(json({ error: whole }, 400));
    expect(await request("GET", "/api/me")).toMatchObject({ error: whole });

    answer(json({ error: `${"🦊".repeat(MAX_ERROR_CHARS)}tail` }, 400));
    const cut = await request("GET", "/api/me");
    const error = cut.kind === "refused" ? cut.error : "";
    expect([...error]).toHaveLength(MAX_ERROR_CHARS);
    expect(error).toBe(`${"🦊".repeat(MAX_ERROR_CHARS - 1)}…`);
  });

  test.each([503, 507])("a %i is refused", async (status) => {
    answer(json({ error: "busy" }, status));
    expect(await request("GET", "/api/me")).toEqual({ kind: "refused", status, error: "busy" });
  });

  test.each([500, 502, 302])("a %i failed", async (status) => {
    answer(json({ error: "boom" }, status));
    expect(await request("GET", "/api/me")).toEqual({ kind: "failed" });
  });

  test("a 200 whose body is not JSON failed", async () => {
    answer(new Response("<html>proxy</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await request("GET", "/api/me")).toEqual({ kind: "failed" });
  });

  test("a rejected fetch is a network error", async () => {
    answer(new TypeError("Failed to fetch"));
    expect(await request("GET", "/api/me")).toEqual({ kind: "network" });
  });

  test("the request is same-origin, never cached, and carries a JSON body", async () => {
    const fetch = answer(new Response(null, { status: 204 }));
    await request("POST", "/api/dashboard-link/open", { token: "abc" });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/dashboard-link/open");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ token: "abc" });
  });

  test("a request without a body sends none", async () => {
    const fetch = answer(json({}));
    await request("GET", "/api/me");
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
  });
});
