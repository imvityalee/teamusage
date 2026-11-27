import type { Hono } from "hono";
import type { RouteContext } from "./app-context.js";
import { createDemoStats } from "./demo-stats.js";
import { fail } from "./http.js";
import { parseMemberId, parseRange } from "./stats-query.js";

/**
 * `GET /api/demo/stats`, on a hosted server only: the query of `/api/stats`, answered from the demo's own database.
 * It reads no cookie, no token and no `team`, so what it answers cannot depend on who asks.
 */
export function demoRoutes(app: Hono, ctx: RouteContext): void {
  const demo = createDemoStats(ctx.now);

  app.get("/api/demo/stats", (c) => {
    c.header("Cache-Control", "no-store");
    const range = parseRange(c);
    if (typeof range === "string") return fail(c, 400, range);
    const { member } = c.req.query();
    if (member === undefined) return c.json(demo.stats(range));
    if (member === "me") return fail(c, 400, "invalid member");
    const memberId = parseMemberId(member);
    if (memberId === null) return fail(c, 400, "invalid query");
    if (!demo.memberExists(memberId)) return fail(c, 404, "member not found");
    return c.json(demo.stats({ ...range, memberId }));
  });
}
