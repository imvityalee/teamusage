import type { Hono } from "hono";
import { isDisplayName, isEmail, validateBatch } from "@teamusage/shared";
import type { RouteContext } from "./app-context.js";
import { bearerToken, fail, readJson } from "./http.js";
import { authenticate, forTeam, MachineOwnedError } from "./team-data.js";

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
  const { db, teamOfInvite } = ctx;

  app.post("/api/register", async (c) => {
    c.header("Cache-Control", "no-store");
    const entry = await teamOfInvite(c);
    if (entry instanceof Response) return entry;
    const input = parseRegister(entry.body);
    if (typeof input === "string") return fail(c, 400, input);
    try {
      return c.json(forTeam(db, entry.teamId).registerMachine(input));
    } catch (err) {
      if (err instanceof MachineOwnedError) return fail(c, 409, "machine already registered to another member");
      throw err;
    }
  });

  app.post("/api/usage", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = bearerToken(c);
    // Identity comes only from the token; nothing in the body can influence it.
    const who = token ? authenticate(db, token) : null;
    if (!who) return fail(c, 401, "unauthorized");
    const body = await readJson(c);
    if (body === undefined) return fail(c, 400, "invalid JSON body");
    const batch = validateBatch(body);
    if (!batch.ok) return fail(c, 400, batch.error);
    return c.json(forTeam(db, who.teamId).upsertUsage(who, batch.records));
  });
}
