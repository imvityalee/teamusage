import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { RouteContext } from "./app-context.js";
import { safeEqual, type Db } from "./db.js";
import { teamById, teamsOf } from "./hosted-teams.js";
import { clearPrivateCookie, clearSessionCookie, crossSite, fail, SESSION_COOKIE, setPrivateCookie, setSessionCookie } from "./http.js";
import { createUserSession, endSession, replaceSession, type Session } from "./sessions.js";

/** Holds `<state>.<verifier>.<landing>` of a sign-in in progress, for the browser that started it. */
const OAUTH_COOKIE = "tu_oauth";
const OAUTH_PATH = "/auth/github";
/** How long a browser has to come back from GitHub. */
const OAUTH_MAX_AGE_S = 600;

/** The pages a sign-in lands on; the only places the callback sends a browser. */
const LANDINGS = { teams: "/teams", invite: "/invite" } as const;
type Landing = keyof typeof LANDINGS;

/** `value` when it names a landing; otherwise `teams`. */
const landingOf = (value: string | undefined): Landing =>
  value !== undefined && Object.hasOwn(LANDINGS, value) ? (value as Landing) : "teams";

/** The one value of query parameter `name`; undefined when it is missing, empty or repeated. */
function singleQuery(c: Context, name: string): string | undefined {
  const values = c.req.queries(name);
  return values?.length === 1 && values[0] !== "" ? values[0] : undefined;
}

type PendingSignIn = { state: string; verifier: string; landing: Landing };

/**
 * The state, verifier and landing of the `tu_oauth` cookie; null when it is missing, its state or verifier is empty,
 * or it has more than three parts. A cookie of two parts, set before sign-ins had a landing, lands on `teams`.
 */
function pendingSignIn(cookie: string | undefined): PendingSignIn | null {
  const [state, verifier, landing, ...rest] = cookie?.split(".") ?? [];
  return state && verifier && rest.length === 0 ? { state, verifier, landing: landingOf(landing) } : null;
}

/** The code and verifier of a callback to the browser's own sign-in `pending`; null when anything is missing or differs. */
function proofOf(c: Context, pending: PendingSignIn): { code: string; verifier: string } | null {
  const state = singleQuery(c, "state");
  const code = singleQuery(c, "code");
  if (state === undefined || code === undefined) return null;
  return safeEqual(state, pending.state) ? { code, verifier: pending.verifier } : null;
}

/**
 * What `/api/me` tells of a session; null for a session opened with a team's code, which a hosted server does not
 * honour, and for a member's while the team's members do not see it or when the team is gone.
 */
function meOf(db: Db, session: Session) {
  if (session.kind === "user") {
    return { kind: "user", githubId: session.githubId, login: session.login, teams: teamsOf(db, session.githubId) };
  }
  if (session.kind === "team") return null;
  const team = teamById(db, session.teamId);
  if (team?.dashboardAccess !== "members") return null;
  return { kind: "member", team: { id: team.publicId, name: team.name }, memberId: session.memberId };
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
    const landing = landingOf(singleQuery(c, "to"));
    setPrivateCookie(c, OAUTH_COOKIE, `${state}.${verifier}.${landing}`, { path: OAUTH_PATH, maxAge: OAUTH_MAX_AGE_S });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return c.redirect(hosted.github.authorizeUrl({ state, challenge }), 302);
  });

  app.get(`${OAUTH_PATH}/callback`, async (c) => {
    c.header("Cache-Control", "no-store");
    const pending = pendingSignIn(getCookie(c, OAUTH_COOKIE));
    // A sign-in gets one callback, whatever its answer.
    clearPrivateCookie(c, OAUTH_COOKIE, OAUTH_PATH);
    const page = LANDINGS[pending?.landing ?? "teams"];
    const failed = () => c.redirect(`${page}?error=signin`, 302);
    const proof = pending === null ? null : proofOf(c, pending);
    if (proof === null) return failed();
    const user = await hosted.github.fetchUser(proof);
    if (user === null) return failed();
    const replaced = getCookie(c, SESSION_COOKIE);
    setSessionCookie(c, replaceSession(db, replaced, () => createUserSession(db, { githubId: user.id, login: user.login })));
    return c.redirect(page, 302);
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
