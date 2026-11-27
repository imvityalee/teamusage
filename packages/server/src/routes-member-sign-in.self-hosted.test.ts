import { expect, test } from "vitest";
import type { Stats } from "@teamusage/shared";
import { app, bearer, getStatsReq, login, post, RANGE, register, sessionCookie, useFreshApp } from "./app.harness.js";

useFreshApp();

test("on a self-hosted server a machine's link opens the dashboard without an Origin, and the code still signs in", async () => {
  const { token, memberId } = await register();
  const linked = await app.request("/api/dashboard-link", { method: "POST", headers: bearer(token) });
  expect(linked.status).toBe(200);
  const { path } = (await linked.json()) as { path: string };
  const opened = await post("/api/dashboard-link/open", { token: path.slice("/open#".length) });
  expect(opened.status).toBe(204);
  expect(opened.headers.get("cache-control")).toBe("no-store");
  const res = await getStatsReq(`${RANGE}&member=me`, { Cookie: sessionCookie(opened) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Stats;
  expect(body.members.map((m) => m.id)).toEqual([memberId]);
  const coded = await login();
  expect(coded.status).toBe(204);
  expect((await getStatsReq(RANGE, { Cookie: sessionCookie(coded) })).status).toBe(200);
});

test("on a self-hosted server a used link is refused like on a hosted one", async () => {
  const { token } = await register();
  const { path } = (await (await app.request("/api/dashboard-link", { method: "POST", headers: bearer(token) })).json()) as { path: string };
  const body = { token: path.slice("/open#".length) };
  expect((await post("/api/dashboard-link/open", body)).status).toBe(204);
  const again = await post("/api/dashboard-link/open", body);
  expect(again.status).toBe(403);
  expect(await again.json()).toEqual({ error: "this link is no longer valid; ask your agent for a new one" });
});
