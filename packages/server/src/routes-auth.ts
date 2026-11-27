import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { RouteContext } from "./app-context.js";
import { safeEqual, type Db } from "./db.js";
import { membersSeeTeam, teamById, teamsOf } from "./hosted-teams.js";
import { clearPrivateCookie, clearSessionCookie, crossSite, fail, SESSION_COOKIE, setPrivateCookie, setSessionCookie } from "./http.js";
import { createUserSession, endSession, type Session } from "./sessions.js";

/** Holds `<state>.<verifier>` of a sign-in in progress, for the browser that started it. */
const OAUTH_COOKIE = "tu_oauth";
const OAUTH_PATH = "/auth/github";
/** How long a browser has to come back from GitHub. */
const OAUTH_MAX_AGE_S = 600;

/** The one value of query parameter `name`; undefined when it is missing, empty or repeated. */
function singleQuery(c: Context, name: string): string | undefined {
  const values = c.req.queries(name);
  return values?.length === 1 && values[0] !== "" ? values[0] : undefined;
}

/** The state and verifier of the `tu_oauth` cookie; null when it is missing or not two non-empty parts. */
function pendingSignIn(cookie: string | undefined): { state: string; verifier: string } | null {
  const [state, verifier, ...rest] = cookie?.split(".") ?? [];
  return state && verifier && rest.length === 0 ? { state, verifier } : null;
}

/** The code and verifier of a callback to the browser's own sign-in; null when anything is missing or differs. */
function callbackOf(c: Context): { code: string; verifier: string } | null {
  const pending = pendingSignIn(getCookie(c, OAUTH_COOKIE));
  const state = singleQuery(c, "state");
  const code = singleQuery(c, "code");
  if (pending === null || state === undefined || code === undefined) return null;
  return safeEqual(state, pending.state) ? { code, verifier: pending.verifier } : null;
}

/** What `/api/me` tells of a session; null when its team is gone, and for a member's while the team's members do not see it. */
function meOf(db: Db, session: Session) {
  if (session.kind === "user") return { kind: "user", login: session.login, teams: teamsOf(db, session.githubId) };
  if (session.kind === "member" && !membersSeeTeam(db, session.teamId)) return null;
  const team = teamById(db, session.teamId);
  if (team === null) return null;
  const named = { id: team.publicId, name: team.name };
  return session.kind === "team" ? { kind: "team", team: named } : { kind: "member", team: named, memberId: session.memberId };
}

/** Signing in with GitHub, signing out, and who the session is. Mounted only on a hosted server. */
export function authRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts, session: sessionOf } = ctx;
  const hosted = opts.hosted;
  if (hosted === undefined) return;

  app.get(`${OAUTH_PATH}/start`, (c) => {
    c.header("Cache-Control", "no-store");
    const state = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    setPrivateCookie(c, OAUTH_COOKIE, `${state}.${verifier}`, { path: OAUTH_PATH, maxAge: OAUTH_MAX_AGE_S });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return c.redirect(hosted.github.authorizeUrl({ state, challenge }), 302);
  });

  app.get(`${OAUTH_PATH}/callback`, async (c) => {
    c.header("Cache-Control", "no-store");
    const callback = callbackOf(c);
    // A sign-in gets one callback, whatever its answer.
    clearPrivateCookie(c, OAUTH_COOKIE, OAUTH_PATH);
    if (callback === null) return fail(c, 400, "sign-in failed");
    const user = await hosted.github.fetchUser(callback);
    if (user === null) return fail(c, 502, "sign-in failed");
    setSessionCookie(c, createUserSession(db, { githubId: user.id, login: user.login }));
    return c.redirect("/", 302);
  });

  app.post("/api/logout", (c) => {
    c.header("Cache-Control", "no-store");
    const refused = crossSite(c, hosted.publicUrl);
    if (refused) return refused;
    const id = getCookie(c, SESSION_COOKIE);
    if (id) endSession(db, id);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get("/api/me", (c) => {
    c.header("Cache-Control", "no-store");
    const session = sessionOf(c);
    const me = session ? meOf(db, session) : null;
    return me ? c.json(me) : fail(c, 401, "unauthorized");
  });
}
