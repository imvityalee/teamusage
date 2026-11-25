import { describe, expect, test } from "vitest";
import { APP_NAME } from "@teamusage/shared";
import { createApp } from "./app.js";
import { goodReg, record } from "./app.fixture.js";
import { app, bearer, db, getStatsReq, logError, logged, login, post, RANGE, sessionCookie, useFreshApp } from "./app.harness.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

useFreshApp();

describe("GET /api/health", () => {
  test("reports ok and app name", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: APP_NAME });
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
      teamForCode: singleTeamCodes(ensureSingleTeam(db), () => {
        throw new Error("secret-internal-detail");
      }),
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
      teamForCode: singleTeamCodes(ensureSingleTeam(db), () => {
        throw new SqliteLikeError("secret-internal-detail /path/to/db");
      }),
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
      logged.length = 0;
      const boom = createApp(db, {
        teamForCode: singleTeamCodes(ensureSingleTeam(db), () => {
          throw value;
        }),
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

