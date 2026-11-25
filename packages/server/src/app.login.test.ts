import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { goodReg, INVITE } from "./app.fixture.js";
import { app, db, login, post, useFreshApp } from "./app.harness.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

useFreshApp();

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


describe("failed-attempt limiting", () => {
  const limited = (clock: { t: number }) =>
    createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE), now: () => clock.t });
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
      teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE),
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

