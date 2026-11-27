import { beforeAll, expect, test } from "vitest";
import {
  CALLERS,
  expectNothingOf,
  expectRefused,
  manageScene,
  markersOfB,
  NO_SUCH_TEAM,
  OUTSIDERS,
  routeNamed,
  ROUTES,
  rowsOfBoth,
  send,
  statusOf,
  SUCCESS_ORDER,
  type Scene,
} from "./hosted.isolation.manage.fixture.js";

// Every refused cell of the management table: each route of the plan on team B, as every kind of caller. A refusal
// changes nothing, so these cells share one world; the cells that succeed run in their order in
// hosted.isolation.manage.success.test.ts.

let s: Scene;
beforeAll(async () => {
  s = await manageScene();
});

const inSuccessOrder = (route: string, caller: string) => SUCCESS_ORDER.some(([r, c]) => r === route && c === caller);
const REFUSED = ROUTES.flatMap((r) => CALLERS.filter((caller) => !inSuccessOrder(r.name, caller)).map((caller) => ({ route: r.name, caller })));

test("the table has 17 rows by 12 callers, a status for every caller in every row, and every cell that succeeds runs in the success order", () => {
  expect([ROUTES.length, CALLERS.length]).toEqual([17, 12]);
  for (const r of ROUTES) expect(r.statuses, r.name).toHaveLength(CALLERS.length);
  for (const r of ROUTES) for (const caller of CALLERS) if (statusOf(r, caller) < 300) expect(inSuccessOrder(r.name, caller), `${r.name} as ${caller}`).toBe(true);
  expect(REFUSED.length + SUCCESS_ORDER.length).toBe(ROUTES.length * CALLERS.length);
});

test.each(REFUSED)("$route as $caller is refused and changes no row of either team", async ({ route, caller }) => {
  const r = routeNamed(route);
  await r.prepare?.(s);
  const before = rowsOfBoth(s.w);
  const res = await send(s, r, caller);
  const headers = [...res.headers];
  const text = await expectRefused(s, r, caller, res, before);
  if (OUTSIDERS.includes(caller)) expectNothingOf(text, markersOfB(s), `the answer to ${caller}`);
  if (res.status === 404 && r.namesTeam) {
    // The same request for a team that does not exist, by the same caller with the same body.
    const none = await send(s, r, caller, NO_SUCH_TEAM);
    expect([none.status, [...none.headers], await none.text()]).toEqual([res.status, headers, text]);
  }
});
