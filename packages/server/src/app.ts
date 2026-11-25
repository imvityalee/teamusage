import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import {
  APP_NAME,
  checkRange,
  isDisplayName,
  isEmail,
  isName,
  MAX_ACCOUNT_FILTERS,
  MAX_AGENT_CHARS,
  MAX_AGENT_FILTERS,
  MAX_MODEL_CHARS,
  MAX_MODEL_FILTERS,
  MAX_PLAN_FILTERS,
  parseAccountKey,
  parsePlanKey,
  validateBatch,
} from "@teamusage/shared";
import { authenticate, createSession, hasSession, MachineOwnedError, registerMachine, upsertUsage, type Db } from "./db.js";
import { createLimiter } from "./limiter.js";
import { getStats } from "./stats.js";
import { forTeam } from "./team-data.js";
import { ensureSingleTeam } from "./teams.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MACHINE_ID = /^[a-f0-9]{32}$/;
const BEARER = /^Bearer (\S+)$/;
const SESSION_COOKIE = "tu_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant-time: both sides are hashed first, so neither content nor length leaks through timing. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Parses repeated `agent`, `model` (`<agent>:<model>`, split on the first colon) and `account` (an account key,
 * see parseAccountKey) and `plan` (a plan key, see parsePlanKey). Undefined when malformed.
 */
function parseFilters(
  agentValues: string[] = [],
  modelValues: string[] = [],
  accountValues: string[] = [],
  planValues: string[] = [],
): { agents: string[]; models: { agent: string; model: string }[]; accounts: string[]; plans: string[] } | undefined {
  if (agentValues.length > MAX_AGENT_FILTERS || modelValues.length > MAX_MODEL_FILTERS) return undefined;
  if (accountValues.length > MAX_ACCOUNT_FILTERS) return undefined;
  if (!accountValues.every((k) => parseAccountKey(k) !== undefined)) return undefined;
  if (planValues.length > MAX_PLAN_FILTERS || !planValues.every((k) => parsePlanKey(k) !== undefined)) return undefined;
  if (!agentValues.every((a) => isName(a, MAX_AGENT_CHARS))) return undefined;
  const models = new Map<string, { agent: string; model: string }>();
  for (const v of modelValues) {
    const i = v.indexOf(":");
    if (i < 0) return undefined;
    const agent = v.slice(0, i);
    const model = v.slice(i + 1);
    if (!isName(agent, MAX_AGENT_CHARS) || !isName(model, MAX_MODEL_CHARS)) return undefined;
    models.set(v, { agent, model });
  }
  return {
    agents: [...new Set(agentValues)],
    models: [...models.values()],
    accounts: [...new Set(accountValues)],
    plans: [...new Set(planValues)],
  };
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
  if (!isDisplayName(name)) return "invalid name";
  if (!isEmail(email)) return "invalid email";
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) return "invalid machineId";
  if (!isDisplayName(machineLabel)) return "invalid machineLabel";
  return { name: name.trim(), email: email.trim(), machineId, machineLabel: machineLabel.trim() };
}

const forwardedProto = (c: Context): string =>
  (c.req.header("X-Forwarded-Proto")?.split(",")[0] ?? "").trim().toLowerCase();

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
      if (err instanceof MachineOwnedError) return fail(c, 409, "machine already registered to another member");
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
    // Only `agent`, `model`, `account` and `plan` are lists and may repeat.
    const repeated = ["from", "to", "member"].some((k) => (c.req.queries(k)?.length ?? 0) > 1);
    if (repeated) return fail(c, 400, "invalid query");
    if (from === undefined || to === undefined || checkRange(from, to) !== "ok") return fail(c, 400, "invalid date range");
    const filters = parseFilters(c.req.queries("agent"), c.req.queries("model"), c.req.queries("account"), c.req.queries("plan"));
    if (!filters) return fail(c, 400, "invalid query");
    const range = { from, to, ...filters };
    const teamId = ensureSingleTeam(db);
    if (member === undefined) return c.json(getStats(db, teamId, range));
    if (member === "me") {
      // `me` is the token's member; a cookie or demo session has no member of its own.
      if (!who || opts.demo) return fail(c, 400, "invalid member");
      return c.json(getStats(db, teamId, { ...range, memberId: who.memberId }));
    }
    if (!MEMBER_ID.test(member)) return fail(c, 400, "invalid query");
    const memberId = Number(member);
    if (!Number.isSafeInteger(memberId)) return fail(c, 400, "invalid query");
    if (!forTeam(db, teamId).memberExists(memberId)) return fail(c, 404, "member not found");
    return c.json(getStats(db, teamId, { ...range, memberId }));
  });

  return app;
}
