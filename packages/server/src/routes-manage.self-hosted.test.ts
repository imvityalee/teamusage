import { expect, test } from "vitest";
import { app, useFreshApp } from "./app.harness.js";

useFreshApp();

const TEAM = "/api/teams/0123456789abcdef";
/** Every management route there is; each task that adds one adds its row. [method, path, body] */
const MANAGEMENT_ROUTES: [string, string, unknown][] = [
  ["GET", TEAM, undefined],
  ["PATCH", TEAM, { name: "Renamed" }],
  ["GET", `${TEAM}/code`, undefined],
  ["POST", `${TEAM}/code/rotate`, undefined],
  ["GET", `${TEAM}/members`, undefined],
];

test.each(MANAGEMENT_ROUTES)("a self-hosted server has no route %s %s", async (method, path, body) => {
  const res = await app.request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not found" });
});
