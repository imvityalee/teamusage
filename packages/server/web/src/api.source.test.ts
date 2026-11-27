import { Hono, type Context } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { crossSite } from "../../src/http.js";
import { teamStatsBusyAnswer } from "../../src/limit-answers.js";
import { TEAM_NOT_FOUND } from "../../src/team-access.js";
import { fetchStats, login } from "./api.js";

/** The server's own answer built by `answer`, so the page reads exactly what the server sends. */
async function serverAnswer(answer: (c: Context) => Response): Promise<Response> {
  const app = new Hono();
  app.get("/", answer);
  return app.request("/");
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function answerWith(res: Response) {
  const fetch = vi.fn(async () => res);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the team's statistics budget used up (429, limit team-stats, Retry-After 12) is busy for 12 s", async () => {
  answerWith(await serverAnswer((c) => teamStatsBusyAnswer(c, 12)));
  expect(await fetchStats("2026-11-01", "2026-11-10")).toEqual({ kind: "busy", retryAfterSec: 12 });
});

test("a 429 of another limit is an error with the server's text", async () => {
  answerWith(json({ error: "too many uploads; try again in a minute", limit: "uploads" }, 429, { "Retry-After": "12" }));
  expect(await fetchStats("2026-11-01", "2026-11-10")).toEqual({ kind: "error", message: "too many uploads; try again in a minute" });
});

test("a 404 'team not found' is noTeam, for the team and for one member", async () => {
  answerWith(json({ error: TEAM_NOT_FOUND }, 404));
  expect(await fetchStats("2026-11-01", "2026-11-10")).toEqual({ kind: "noTeam" });
  answerWith(json({ error: TEAM_NOT_FOUND }, 404));
  expect(await fetchStats("2026-11-01", "2026-11-10", undefined, 3)).toEqual({ kind: "noTeam" });
  answerWith(json({ error: "member not found" }, 404));
  expect(await fetchStats("2026-11-01", "2026-11-10", undefined, 3)).toEqual({ kind: "notFound" });
});

test("the source decides the path: the demo's statistics, and a hosted team's with its id", async () => {
  const fetch = answerWith(json({ error: "x" }, 500));
  await fetchStats("2026-11-01", "2026-11-10", undefined, 3, undefined, { kind: "demo" });
  await fetchStats("2026-11-01", "2026-11-10", undefined, undefined, undefined, { kind: "hosted", team: "1111111111111111" });
  await fetchStats("2026-11-01", "2026-11-10");
  expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
    "/api/demo/stats?from=2026-11-01&to=2026-11-10&member=3",
    "/api/stats?from=2026-11-01&to=2026-11-10&team=1111111111111111",
    "/api/stats?from=2026-11-01&to=2026-11-10",
  ]);
});

test("the login's 403 'cross-site request refused' is wrongAddress", async () => {
  answerWith(await serverAnswer((c) => crossSite(c, "https://usage.example.com") ?? c.body(null, 204)));
  expect(await login("a-code")).toEqual({ kind: "wrongAddress" });
});

test("any other 403 of the login is still a wrong code, whatever its body", async () => {
  answerWith(json({ error: "invalid invite code" }, 403));
  expect(await login("a-code")).toEqual({ kind: "wrong" });
  answerWith(new Response("Forbidden", { status: 403 }));
  expect(await login("a-code")).toEqual({ kind: "wrong" });
});
