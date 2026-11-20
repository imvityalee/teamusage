import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { APP_NAME } from "@teamusage/shared";
import { z } from "zod";
import { ApiError } from "./api.js";
import { errorMessage } from "./errors.js";
import { COST_NOTE, loadReport, RANGES, reportDefaults, type ReportDeps } from "./report.js";
import { sync, syncDefaults, type Deps as SyncDeps } from "./sync.js";
import { clientVersion } from "./version.js";

export interface Deps extends SyncDeps, ReportDeps {
  nowMs?: () => number;
}

const INVALID_INPUT = "invalid input; see the tool's input schema";
const GENERIC_ERROR = "the tool failed unexpectedly";

export const rangeInput = z.strictObject({
  range: z.enum(RANGES).default("1m").describe("Last 1, 3 or 6 months (30, 90 or 180 days) ending today."),
});
export const syncInput = z.strictObject({ labelHistory: z.boolean().optional() });

/** A tool's input schema as MCP clients see it, generated from the zod schema that checks the input. */
function inputSchema(schema: z.ZodType): { type: "object"; [key: string]: unknown } {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input" });
  return json as { type: "object"; [key: string]: unknown };
}

export const TOOLS = [
  {
    name: "sync_usage",
    description:
      "Collect this machine's coding-agent token usage and upload it to the team server. " +
      "labelHistory: true sends all history again and labels every Claude and Codex day with the current login. " +
      "Use labelHistory only when the user explicitly asks to label past usage, because it states that the current " +
      "logins were used for all past usage on this machine.",
    inputSchema: inputSchema(syncInput),
  },
  {
    name: "get_my_usage",
    description: "Token usage and estimated cost for the configured member, per model.",
    inputSchema: inputSchema(rangeInput),
  },
  {
    name: "get_team_usage",
    description: "Team token usage and estimated cost: totals, per member and per model.",
    inputSchema: inputSchema(rangeInput),
  },
];

/** stdout carries the MCP protocol, so sync's log lines go to stderr. */
const mcpDefaults = (): Deps => ({ ...syncDefaults(), ...reportDefaults(), log: (line) => process.stderr.write(`${line}\n`) });

const MAX_MEMBERS = 100;
const MAX_MODELS = 200;
const SYNC_MIN_INTERVAL_MS = 60_000;
let lastSync: { at: number; result: object } | undefined;
/** For tests: forget the last sync so the interval does not carry over. */
export function resetSyncThrottle(): void {
  lastSync = undefined;
}

/** Largest first, at most `max`; when anything is cut, says so and how many there were under `countKey`. */
function capped<T>(list: T[], max: number, by: (x: T) => number, countKey: string) {
  const kept = [...list].sort((a, b) => by(b) - by(a)).slice(0, max);
  return { kept, extra: list.length > max ? { truncated: true, [countKey]: list.length } : {} };
}

const ok = (value: object) => ({ text: JSON.stringify({ ...value, costNote: COST_NOTE }) });
const fail = (text: string) => ({ text, isError: true as const });

export async function handleTool(
  name: string,
  args: unknown,
  deps: Partial<Deps> = {},
): Promise<{ text: string; isError?: boolean }> {
  const input = args === undefined ? {} : args;
  try {
    const d: Deps = { ...mcpDefaults(), ...deps };
    switch (name) {
      case "sync_usage": {
        const parsed = syncInput.safeParse(input);
        if (!parsed.success) return fail(INVALID_INPUT);
        const labelHistory = parsed.data.labelHistory === true;
        const now = (d.nowMs ?? Date.now)();
        if (!labelHistory && lastSync && now - lastSync.at >= 0 && now - lastSync.at < SYNC_MIN_INTERVAL_MS) {
          return ok({ ...lastSync.result, cached: true, ageSeconds: Math.floor((now - lastSync.at) / 1000) });
        }
        const r = await sync({ quiet: false, labelHistory, deps: d });
        if (r.skipped) return ok({ skipped: true });
        lastSync = { at: now, result: r };
        return ok(r);
      }
      case "get_my_usage": {
        const parsed = rangeInput.safeParse(input);
        if (!parsed.success) return fail(INVALID_INPUT);
        const { from, to, totals, models } = await loadReport("me", parsed.data.range, d);
        const mod = capped(models, MAX_MODELS, (m) => m.total, "modelCount");
        return ok({ from, to, totals, models: mod.kept, ...mod.extra });
      }
      case "get_team_usage": {
        const parsed = rangeInput.safeParse(input);
        if (!parsed.success) return fail(INVALID_INPUT);
        const { from, to, totals, members, models } = await loadReport(undefined, parsed.data.range, d);
        const mem = capped(members, MAX_MEMBERS, (m) => m.tokens, "memberCount");
        const mod = capped(models, MAX_MODELS, (m) => m.total, "modelCount");
        return ok({ from, to, totals, members: mem.kept, models: mod.kept, ...mem.extra, ...mod.extra });
      }
      default:
        return fail("unknown tool");
    }
  } catch (e) {
    if (e instanceof ApiError) return fail(`server error: ${e.message}`);
    const safe = errorMessage(e);
    return fail(safe.startsWith("unexpected error") ? GENERIC_ERROR : safe);
  }
}

/** The name and version this MCP server reports: the client's own, from its package.json. */
export function mcpServerInfo(): { name: string; version: string } {
  return { name: APP_NAME, version: clientVersion() };
}

/** Serves the three tools over stdio. stdout carries only protocol messages; nothing is logged there. */
export async function startMcp(): Promise<void> {
  const server = new Server(mcpServerInfo(), { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await handleTool(req.params.name, req.params.arguments);
    return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
  });
  await server.connect(new StdioServerTransport());
}
