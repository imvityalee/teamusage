import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { APP_NAME } from "@teamusage/shared";
import type { AppOptions, RouteContext } from "./app-context.js";
import type { Db } from "./db.js";
import { errorTrace, fail, MAX_BODY_BYTES, SESSION_COOKIE } from "./http.js";
import { createLimiter } from "./limiter.js";
import { authRoutes } from "./routes-auth.js";
import { dashboardRoutes } from "./routes-dashboard.js";
import { machineRoutes } from "./routes-machines.js";
import { teamRoutes } from "./routes-teams.js";
import { findSession } from "./sessions.js";

export function createApp(db: Db, opts: AppOptions): Hono {
  const app = new Hono();
  const limiter = createLimiter({ now: opts.now ?? Date.now });
  const clientKey = opts.clientKey ?? (() => "unknown");
  const logError = opts.logError ?? ((line: string) => process.stderr.write(`${line}\n`));

  /** 429 when the client has used up its failed attempts. */
  const throttled = (c: Context) => {
    const wait = limiter.retryAfter(clientKey(c));
    if (wait === null) return null;
    c.header("Retry-After", String(wait));
    return fail(c, 429, "too many attempts");
  };

  /** The team the invite code opens; a code that opens none counts as a failed attempt. */
  const teamOfInvite = (c: Context, given: unknown): number | null => {
    const teamId = opts.teamForCode(given);
    if (teamId === null) limiter.fail(clientKey(c));
    return teamId;
  };

  /** The session the request's cookie opens, or null. */
  const sessionOf = (c: Context) => {
    const id = getCookie(c, SESSION_COOKIE);
    return id ? findSession(db, id) : null;
  };

  app.use(
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, 413, "payload too large") }),
  );
  app.notFound((c) => fail(c, 404, "not found"));
  app.onError((err, c) => {
    try {
      logError(`teamusage: internal error (${errorTrace(err)})`);
    } catch {
      // logging must never change the response
    }
    return fail(c, 500, "internal error");
  });

  app.get("/api/health", (c) => c.json({ ok: true, name: APP_NAME }));

  const ctx: RouteContext = { db, opts, throttled, teamOfInvite, session: sessionOf };
  machineRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  authRoutes(app, ctx);
  teamRoutes(app, ctx);

  return app;
}
