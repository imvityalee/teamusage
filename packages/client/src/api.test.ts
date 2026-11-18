import { afterEach, expect, test, vi } from "vitest";
import { ApiError, fetchStats, register, upload } from "./api.js";

const TOKEN = "tok-SECRET-91b2";
const stub = (res: Response | Error) => {
  const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (res instanceof Error) throw res;
    return res;
  });
  vi.stubGlobal("fetch", f);
  return f;
};
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

test("fetchStats builds the stats URL and sends the bearer token", async () => {
  const f = stub(jsonRes({ from: "2026-10-20", to: "2026-11-18" }));
  await fetchStats("https://u.example.com", TOKEN, { from: "2026-10-20", to: "2026-11-18", member: "me" });
  const [url, init] = f.mock.calls[0]!;
  expect(url).toBe("https://u.example.com/api/stats?from=2026-10-20&to=2026-11-18&member=me");
  expect(init?.method).toBe("GET");
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(init?.redirect).toBe("error");
});

test("fetchStats omits member when not asked", async () => {
  const f = stub(jsonRes({}));
  await fetchStats("https://u.example.com", TOKEN, { from: "2026-10-20", to: "2026-11-18" });
  expect(f.mock.calls[0]![0]).toBe("https://u.example.com/api/stats?from=2026-10-20&to=2026-11-18");
});

test("upload sends exactly {records} with the bearer token", async () => {
  const f = stub(jsonRes({ stored: 0, kept: 0 }));
  await upload("https://u.example.com", TOKEN, []);
  const [url, init] = f.mock.calls[0]!;
  expect(url).toBe("https://u.example.com/api/usage");
  expect(JSON.parse(String(init?.body))).toEqual({ records: [] });
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
});

test("errors carry the status and the server's error string truncated to 200 chars, nothing else", async () => {
  stub(jsonRes({ error: `${"x".repeat(300)}`, detail: "leak-me" }, 400));
  const e = (await upload("https://u.example.com", TOKEN, []).catch((x: unknown) => x)) as ApiError;
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBe(400);
  expect(e.message).toBe(`server responded 400: ${"x".repeat(200)}`);
  expect(e.message).not.toContain("leak-me");
  expect(e.message).not.toContain(TOKEN);
});

test("control characters in the server's error are neutralised", async () => {
  stub(jsonRes({ error: "bad\u001b[31m\nthing" }, 400));
  const e = (await upload("https://u.example.com", TOKEN, []).catch((x: unknown) => x)) as ApiError;
  expect(e.message).not.toMatch(/[\u0000-\u001f]/);
});

test("bidi and zero-width characters in the server's error are removed", async () => {
  stub(jsonRes({ error: "in\u202evalid\u200b to\u2066ken\ufeff\u2069\u200f" }, 400));
  const e = (await upload("https://u.example.com", TOKEN, []).catch((x: unknown) => x)) as ApiError;
  expect(e.message).toBe("server responded 400: invalid token");
});

test("a non-JSON error body yields only the status", async () => {
  stub(new Response("<html>stack trace with secrets</html>", { status: 502 }));
  const e = (await upload("https://u.example.com", TOKEN, []).catch((x: unknown) => x)) as ApiError;
  expect(e.message).toBe("server responded 502");
});

test("network failure and timeout map to status 0 with fixed messages", async () => {
  stub(new TypeError("fetch failed: connect ECONNREFUSED"));
  await expect(register("https://u.example.com", { inviteCode: "inv", name: "A", email: "a@b.c", machineId: "a".repeat(32), machineLabel: "m" }))
    .rejects.toMatchObject({ status: 0, message: "could not reach the server" });
  stub(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  await expect(upload("https://u.example.com", TOKEN, [])).rejects.toMatchObject({
    status: 0,
    message: "the server did not respond in time",
  });
});

test("register rejects a response without a token", async () => {
  stub(jsonRes({ memberId: 1 }));
  await expect(
    register("https://u.example.com", { inviteCode: "inv", name: "A", email: "a@b.c", machineId: "a".repeat(32), machineLabel: "m" }),
  ).rejects.toBeInstanceOf(ApiError);
});

test("a response body over 5 MB is refused with a fixed error, with and without Content-Length", async () => {
  const big = "x".repeat(6 * 1024 * 1024);
  const calls: [string, () => Promise<unknown>][] = [
    ["fetchStats", () => fetchStats("https://u.example.com", TOKEN, { from: "a", to: "b" })],
    ["upload", () => upload("https://u.example.com", TOKEN, [])],
  ];
  for (const [, call] of calls) {
    // streamed, no Content-Length
    stub(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }), { status: 200 }));
    await expect(call()).rejects.toMatchObject({ message: "the server's response was too large" });
    // declared up front
    stub(new Response(big, { status: 200, headers: { "Content-Length": String(big.length) } }));
    await expect(call()).rejects.toMatchObject({ message: "the server's response was too large" });
  }
});
