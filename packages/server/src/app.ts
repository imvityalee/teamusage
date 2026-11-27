import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { APP_NAME } from "@teamusage/shared";
import type { AppOptions, InviteEntry, RouteContext } from "./app-context.js";
import type { Db } from "./db.js";
import { errorTrace, fail, isObject, MAX_BODY_BYTES, readJson, SESSION_COOKIE } from "./http.js";
import { createLimiter } from "./limiter.js";
import { authRoutes } from "./routes-auth.js";
import { dashboardRoutes } from "./routes-dashboard.js";
import { machineRoutes } from "./routes-machines.js";
import { memberSignInRoutes } from "./routes-member-sign-in.js";
import { teamMembersRoutes } from "./routes-team-members.js";
import { teamSettingsRoutes } from "./routes-team-settings.js";
import { teamRoutes } from "./routes-teams.js";
import { findSession } from "./sessions.js";
import { forTeam } from "./team-data.js";
import { REMOVAL_SLICE_ROWS } from "./team-removal.js";

/** Waits one turn of the event loop, so that the requests waiting in it are served first. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createApp(db: Db, opts: AppOptions): Hono {
  const app = new Hono();
  const now = opts.now ?? Date.now;
  const stopwatch = opts.stopwatch ?? (() => performance.now());
  const limiter = createLimiter({ now });
  const clientKey = opts.clientKey ?? (() => "unknown");
  const logError = opts.logError ?? ((line: string) => process.stderr.write(`${line}\n`));

  /** 429 when the client has used up its failed attempts. */
  const throttled = (c: Context) => {
    const wait = limiter.retryAfter(clientKey(c));
    if (wait === null) return null;
    c.header("Retry-After", String(wait));
    return fail(c, 429, "too many attempts");
  };

  /**
   * The team the body's invite code opens, with the body; otherwise the response that refuses the request.
   * Over its limit, a client gets in only with a correct code, and on a self-hosted server not even then: there
   * it is refused before its body is read. A well-formed body with a wrong code counts as a failed attempt.
   */
  const teamOfInvite = async (c: Context): Promise<InviteEntry | Response> => {
    const early = opts.hosted ? null : throttled(c);
    if (early) return early;
    const body = await readJson(c);
    if (isObject(body)) {
      const teamId = opts.teamForCode(body.inviteCode);
      if (teamId !== null) return { teamId, body };
    }
    const limited = throttled(c);
    if (limited) return limited;
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    limiter.count(clientKey(c));
    return fail(c, 403, "invalid invite code");
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

  const team = (teamId: number) =>
    forTeam(db, teamId, {
      clock: () => new Date(now()).toISOString(),
      limits: opts.limits?.team,
      daysKept: opts.limits?.usageDaysKept,
    });
  const removal = { sliceRows: opts.removal?.sliceRows ?? REMOVAL_SLICE_ROWS, pause: opts.removal?.pause ?? nextTurn };
  const ctx: RouteContext = { db, opts, now, stopwatch, team, teamOfInvite, session: sessionOf, removal };
  machineRoutes(app, ctx);
  dashboardRoutes(app, ctx);
  memberSignInRoutes(app, ctx);
  authRoutes(app, ctx);
  teamRoutes(app, ctx);
  teamSettingsRoutes(app, ctx);
  teamMembersRoutes(app, ctx);

  return app;
}
