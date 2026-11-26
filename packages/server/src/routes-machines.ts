import type { Context, Hono } from "hono";
import { isDisplayName, isEmail, validateBatch } from "@teamusage/shared";
import type { RouteContext } from "./app-context.js";
import { bearerToken, fail, readJson } from "./http.js";
import { createLimiter } from "./limiter.js";
import { limitAnswer, secondsToUtcMidnight } from "./limit-answers.js";
import { authenticate, MachineOwnedError } from "./team-data.js";
import { LimitError } from "./team-limits.js";

const MINUTE_MS = 60_000;
const MACHINE_ID = /^[a-f0-9]{32}$/;

type RegisterInput = { name: string; email: string; machineId: string; machineLabel: string };

function parseRegister(b: Record<string, unknown>): RegisterInput | string {
  const { name, email, machineId, machineLabel } = b;
  if (!isDisplayName(name)) return "invalid name";
  if (!isEmail(email)) return "invalid email";
  if (typeof machineId !== "string" || !MACHINE_ID.test(machineId)) return "invalid machineId";
  if (!isDisplayName(machineLabel)) return "invalid machineLabel";
  return { name: name.trim(), email: email.trim(), machineId, machineLabel: machineLabel.trim() };
}

/** The routes a machine uses: registering with an invite code and sending usage with its token. */
export function machineRoutes(app: Hono, ctx: RouteContext): void {
  const { db, opts, team, teamOfInvite } = ctx;
  const limits = opts.limits && {
    team: opts.limits.team,
    uploads: createLimiter({ max: opts.limits.uploadsPerMinute, windowMs: MINUTE_MS, now: ctx.now }),
  };

  /** The answer to a request a limit refused; any other error is rethrown. */
  const refused = (c: Context, err: unknown): Response => {
    if (!(err instanceof LimitError) || !limits) throw err;
    const wait = err.limit === "team-rows-per-day" ? secondsToUtcMidnight(ctx.now()) : undefined;
    return limitAnswer(c, err.limit, limits.team, wait);
  };

  /** The answer when the machine has used up its minute; otherwise counts this upload. */
  const tooManyUploads = (c: Context, who: { teamId: number; machineId: string }): Response | null => {
    if (!limits) return null;
    const key = `${who.teamId}:${who.machineId}`;
    const wait = limits.uploads.retryAfter(key);
    if (wait !== null) return limitAnswer(c, "uploads", limits.team, wait);
    limits.uploads.count(key);
    return null;
  };

  app.post("/api/register", async (c) => {
    c.header("Cache-Control", "no-store");
    const entry = await teamOfInvite(c);
    if (entry instanceof Response) return entry;
    const input = parseRegister(entry.body);
    if (typeof input === "string") return fail(c, 400, input);
    try {
      return c.json(team(entry.teamId).registerMachine(input));
    } catch (err) {
      if (err instanceof MachineOwnedError) return fail(c, 409, "machine already registered to another member");
      return refused(c, err);
    }
  });

  app.post("/api/usage", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c);
    // Identity comes only from the token; nothing in the body can influence it.
    const who = token ? authenticate(db, token) : null;
    if (!who) return fail(c, 401, "unauthorized");
    const outOfUploads = tooManyUploads(c, who);
    if (outOfUploads) return outOfUploads;
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    const batch = validateBatch(body, new Date(ctx.now()));
    if (!batch.ok) return fail(c, 400, batch.error);
    try {
      return c.json(team(who.teamId).upsertUsage(who, batch.records));
    } catch (err) {
      return refused(c, err);
    }
  });
}
