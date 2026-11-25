import { describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { INVITE, MID, MID2, record } from "./app.fixture.js";
import { bearer, db, getStatsReq, login, post, RANGE, register, sessionCookie, useFreshApp } from "./app.harness.js";
import { createUserSession } from "./sessions.js";
import { ensureSingleTeam, singleTeamCodes } from "./teams.js";

useFreshApp();

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

  test("a user's session reads no team's stats", async () => {
    const cookie = `tu_session=${createUserSession(db, { githubId: 7, login: "ann" })}`;
    const res = await getStatsReq(RANGE, { Cookie: cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
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
    const demoApp = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE), demoTeamId: ensureSingleTeam(db) });
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
    const demoApp = createApp(db, { teamForCode: singleTeamCodes(ensureSingleTeam(db), () => INVITE), demoTeamId: ensureSingleTeam(db) });
    expect((await demoApp.request(`/api/stats?${RANGE}`)).status).toBe(200);
    expect((await demoApp.request(`/api/stats?${RANGE}&member=me`)).status).toBe(400);
    expect((await demoApp.request("/api/stats?from=x&to=y")).status).toBe(400);
  });
});

