import { beforeAll, expect, test } from "vitest";
import { cookieOf } from "./hosted.fixture.js";
import {
  expectNothingOf,
  expectRefused,
  manageScene,
  markersOfA,
  markersOfB,
  OUTSIDERS,
  routeNamed,
  rowsOfBoth,
  send,
  statusOf,
  SUCCESS_ORDER,
  type CallerName,
  type Scene,
} from "./hosted.isolation.manage.fixture.js";
import { RANGE } from "./manage.fixture.js";

// The cells of the management table that succeed, in an order that leaves each next one possible: signing in, reads,
// renaming, the code, invites, roles, removals, deletion. After each, the team it did not act on is as it was. The
// refused cells are in hosted.isolation.manage.test.ts.

let s: Scene;
let rowsOfA: ReturnType<typeof rowsOfBoth>["A"];
const paths: string[] = [];
beforeAll(async () => {
  s = await manageScene();
  rowsOfA = rowsOfBoth(s.w).A;
});

/** Checks what a successful cell of these routes answers, beyond its status. */
const ANSWERS: Record<string, (res: Response, caller: CallerName) => Promise<void>> = {
  "POST /api/dashboard-link": async (res) => {
    const { path } = (await res.json()) as { path: string };
    expect(path).toMatch(/^\/open#[a-f0-9]{64}$/);
    expect(paths, "a path of its own").not.toContain(path);
    paths.push(path);
  },
  "POST /api/dashboard-link/open": async (res) => {
    const cookie = cookieOf(res, "tu_session");
    const me = await s.w.app.request("/api/me", { headers: { Cookie: cookie } });
    expect(await me.json()).toEqual({ kind: "member", team: { id: s.w.B.publicId, name: s.w.B.name }, memberId: s.w.B.tia.memberId });
    const stats = await s.w.app.request(`/api/stats?${RANGE}`, { headers: { Cookie: cookie } });
    expect(stats.status).toBe(200);
    const text = await stats.text();
    expect((JSON.parse(text) as { members: { name: string }[] }).members.map((m) => m.name)).toEqual([s.w.B.sam.name, s.w.B.tia.name]);
    expectNothingOf(text, markersOfA(s.w), "the statistics of the session the link opened");
  },
};

test.each(SUCCESS_ORDER)("%s as %s", async (route, caller) => {
  const r = routeNamed(route);
  await r.prepare?.(s);
  const before = rowsOfBoth(s.w);
  const res = await send(s, r, caller);
  if (statusOf(r, caller) >= 400) {
    // Asked again once the one cell that succeeds has used the thing up.
    const text = await expectRefused(s, r, caller, res, before);
    if (OUTSIDERS.includes(caller)) expectNothingOf(text, markersOfB(s), `the answer to ${caller}`);
    return;
  }
  expect(res.status).toBe(statusOf(r, caller));
  expect(res.headers.get("cache-control")).toBe("no-store");
  // The one answer to an outsider that names B is B's own answer to eve, who accepts its invite and is its viewer from then on.
  if (OUTSIDERS.includes(caller) && route !== "POST /api/invites/accept") expectNothingOf(await res.clone().text(), markersOfB(s), `the answer to ${caller}`);
  const untouched = (r.actsOn?.(caller) ?? "B") === "B" ? "A" : "B";
  expect(rowsOfBoth(s.w)[untouched], `team ${untouched}'s rows`).toEqual(before[untouched]);
  await ANSWERS[route]?.(res, caller);
  await r.restore?.(s);
});

test("at the end B and its people are gone, and A holds what it held and the link its machine asked for", () => {
  const after = rowsOfBoth(s.w);
  expect(after.B.teams).toEqual([undefined]);
  for (const [table, rows] of Object.entries(after.B)) if (table !== "teams") expect(rows, table).toEqual([]);
  expect(after.A.dashboard_links).toHaveLength(1);
  expect(after.A).toEqual({ ...rowsOfA, dashboard_links: after.A.dashboard_links });
  expect(after.users.map((u) => (u as { login: string }).login)).toEqual(["ann", "zoe"]);
});
