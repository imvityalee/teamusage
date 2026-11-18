import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { APP_NAME, validateBatch } from "@teamusage/shared";
import { authenticate, createSession, hasSession, registerMachine, upsertUsage, type Db } from "./db.js";
import { createLimiter } from "./limiter.js";
import { getStats, memberExists } from "./stats.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MACHINE_ID = /^[a-f0-9]{32}$/;
const BEARER = /^Bearer (\S+)$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const SESSION_COOKIE = "tu_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const MAX_RANGE_DAYS = 730;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time: both sides are hashed first, so neither content nor length leaks through timing. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500, error: string) => c.json({ error }, status);

/** Parses the JSON body; undefined when it is not valid JSON. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type RegisterInput = { name: string; email: string; machineId: string; machineLabel: string };

function parseRegister(b: Record<string, unknown>): RegisterInput | string {
  const { name, email, machineId, machineLabel } = b;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 100 || CONTROL_CHARS.test(name)) {
    return "invalid name";
  }
  if (typeof email !== "string" || email.length > 254 || !email.includes("@") || CONTROL_CHARS.test(email)) return "invalid email";
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) return "invalid machineId";
  if (
    typeof machineLabel !== "string" ||
    machineLabel.trim().length < 1 ||
    machineLabel.trim().length > 100 ||
    CONTROL_CHARS.test(machineLabel)
  ) {
    return "invalid machineLabel";
  }
  return { name: name.trim(), email: email.trim(), machineId, machineLabel: machineLabel.trim() };
}

const forwardedProto = (c: Context): string =>
  (c.req.header("X-Forwarded-Proto")?.split(",")[0] ?? "").trim().toLowerCase();

/** A strict YYYY-MM-DD that is a real calendar date, as epoch ms (UTC); undefined otherwise. */
function parseDate(s: string | undefined): number | undefined {
  if (s === undefined || !DATE.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? undefined : t;
}

/**
 * The error's class name and its `code`, for an operator's trace of a 500. Never the message, which can hold
 * paths or submitted values, and nothing from the request.
 */
function errorTrace(err: unknown): string {
  const ctor = typeof err === "object" && err !== null ? (err as { constructor?: { name?: unknown } }).constructor?.name : undefined;
  const name = typeof ctor === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(ctor) ? ctor : "unknown";
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? `${name} ${code}` : name;
}

const MEMBER_ID = /^[1-9][0-9]{0,9}$/;

export function createApp(
  db: Db,
  opts: {
    inviteCode: () => string;
    demo?: boolean;
    now?: () => number;
    /** Identifies the client for failed-attempt limiting. No request header is trusted by default. */
    clientKey?: (c: Context) => string;
    /** Receives one line per 500; defaults to stderr. */
    logError?: (line: string) => void;
  },
): Hono {
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

  /** Checks the invite code; a wrong one counts as a failed attempt. */
  const inviteOk = (c: Context, given: unknown): boolean => {
    if (typeof given === "string" && safeEqual(given, opts.inviteCode())) return true;
    limiter.fail(clientKey(c));
    return false;
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

  app.post("/api/register", async (c) => {
    const limited = throttled(c);
    if (limited) return limited;
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    if (!inviteOk(c, body.inviteCode)) return fail(c, 403, "invalid invite code");
    const input = parseRegister(body);
    if (typeof input === "string") return fail(c, 400, input);
    try {
      return c.json(registerMachine(db, input));
    } catch (err) {
      if (err instanceof Error && /another member/.test(err.message)) {
        return fail(c, 409, "machine already registered to another member");
      }
      throw err;
    }
  });

  app.post("/api/usage", async (c) => {
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
    // Identity comes only from the token; nothing in the body can influence it.
    const who = token ? authenticate(db, token) : null;
    if (!who) return fail(c, 401, "unauthorized");
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    const batch = validateBatch(body);
    if (!batch.ok) return fail(c, 400, batch.error);
    return c.json(upsertUsage(db, who, batch.records));
  });

  app.post("/api/login", async (c) => {
    c.header("Cache-Control", "no-store");
    const limited = throttled(c);
    if (limited) return limited;
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    if (!isObject(body)) return fail(c, 400, "body must be an object");
    if (!inviteOk(c, body.inviteCode)) return fail(c, 403, "invalid invite code");
    const https = new URL(c.req.url).protocol === "https:" || forwardedProto(c) === "https";
    setCookie(c, SESSION_COOKIE, createSession(db), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
      secure: https,
    });
    return c.body(null, 204);
  });

  app.get("/api/stats", (c) => {
    c.header("Cache-Control", "no-store");
    const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
    const who = token ? authenticate(db, token) : null;
    const sessionId = getCookie(c, SESSION_COOKIE);
    // A presented bearer token must be valid; it wins over a cookie, but a bad one is never rescued by a cookie.
    const allowed = opts.demo === true || (token !== undefined ? who !== null : !!sessionId && hasSession(db, sessionId));
    if (!allowed) return fail(c, 401, "unauthorized");

    const { from, to, member } = c.req.query();
    // Repeated parameters are ambiguous, so they are rejected rather than resolved by position.
    const repeated = ["from", "to", "member"].some((k) => (c.req.queries(k)?.length ?? 0) > 1);
    if (repeated) return fail(c, 400, "invalid query");
    const f = parseDate(from);
    const t = parseDate(to);
    if (f === undefined || t === undefined || f > t || (t - f) / 86_400_000 + 1 > MAX_RANGE_DAYS) {
      return fail(c, 400, "invalid date range");
    }
    const range = { from: from as string, to: to as string };
    if (member === undefined) return c.json(getStats(db, range));
    if (member === "me") {
      // `me` is the token's member; a cookie or demo session has no member of its own.
      if (!who || opts.demo) return fail(c, 400, "invalid member");
      return c.json(getStats(db, { ...range, memberId: who.memberId }));
    }
    if (!MEMBER_ID.test(member)) return fail(c, 400, "invalid query");
    const memberId = Number(member);
    if (!Number.isSafeInteger(memberId)) return fail(c, 400, "invalid query");
    if (!memberExists(db, memberId)) return fail(c, 404, "member not found");
    return c.json(getStats(db, { ...range, memberId }));
  });

  return app;
}
