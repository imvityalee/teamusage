import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { APP_NAME, presetRange, type Stats } from "@teamusage/shared";
import { z } from "zod";
import { ApiError, fetchStats } from "./api.js";
import { clientVersion } from "./codex.js";
import { collect } from "./collect.js";
import { loadConfig } from "./config.js";
import { clean } from "./text.js";
import { readLogins } from "./account.js";
import { assertTokenBound, errorMessage, localToday, sync, SyncError, type Deps as SyncDeps } from "./sync.js";

export type Range = "1m" | "3m" | "6m"; // 30, 90, 180 days

export interface Deps extends SyncDeps {
  nowMs?: () => number;
  fetchStats: typeof fetchStats;
  loadConfig: typeof loadConfig;
}

export const RANGES = ["1m", "3m", "6m"] as const;
export const COST_NOTE = "Cost is an estimate from public API prices, not what a subscription plan charges.";
const NOT_SET_UP = "teamusage is not set up; run `teamusage setup`";
const INVALID_INPUT = "invalid input; see the tool's input schema";
const GENERIC_ERROR = "the tool failed unexpectedly";
const DAYS: Record<Range, 30 | 90 | 180> = { "1m": 30, "3m": 90, "6m": 180 };

export const rangeInput = z.strictObject({ range: z.enum(["1m", "3m", "6m"]).default("1m") });
export const syncInput = z.strictObject({ labelHistory: z.boolean().optional() });

export const TOOLS = [
  {
    name: "sync_usage",
    description:
      "Collect this machine's coding-agent token usage and upload it to the team server. " +
      "labelHistory: true sends all history again and labels every Claude and Codex day with the current login. " +
      "Use labelHistory only when the user explicitly asks to label past usage, because it states that the current " +
      "logins were used for all past usage on this machine.",
    inputSchema: {
      type: "object" as const,
      properties: {
        labelHistory: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_my_usage",
    description: "Token usage and estimated cost for the configured member, per model.",
    inputSchema: rangeSchema(),
  },
  {
    name: "get_team_usage",
    description: "Team token usage and estimated cost: totals, per member and per model.",
    inputSchema: rangeSchema(),
  },
];

function rangeSchema() {
  return {
    type: "object" as const,
    properties: {
      range: {
        type: "string",
        enum: ["1m", "3m", "6m"],
        default: "1m",
        description: "Last 1, 3 or 6 months (30, 90 or 180 days) ending today.",
      },
    },
    additionalProperties: false,
  };
}

export const defaults = (): Deps => ({
  collect,
  env: process.env,
  today: () => localToday(),
  accounts: () => readLogins(),
  log: (line) => process.stderr.write(`${line}\n`),
  fetchStats,
  loadConfig,
});

const MAX_MEMBERS = 100;
const MAX_MODELS = 200;
const SYNC_MIN_INTERVAL_MS = 60_000;
let lastSync: { at: number; result: object } | undefined;
/** For tests: forget the last sync so the interval does not carry over. */
export function resetSyncThrottle(): void {
  lastSync = undefined;
}

/** Highest first; adds truncated/count fields when anything was cut. */
function capped<T>(list: unknown, max: number, by: (x: T) => number, countKey: string) {
  const all = (Array.isArray(list) ? (list as T[]) : []).filter((x) => typeof x === "object" && x !== null);
  const kept = [...all].sort((a, b) => num(by(b)) - num(by(a))).slice(0, max);
  return { kept, extra: all.length > max ? { truncated: true, [countKey]: all.length } : {} };
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const ok = (value: unknown) => ({ text: JSON.stringify({ ...(value as object), costNote: COST_NOTE }) });
const fail = (text: string) => ({ text, isError: true as const });

/** Fetches stats for a range; refuses (sending nothing) unless a token bound to this server and email exists. */
export async function loadStats(member: "me" | undefined, range: Range, deps: Deps): Promise<Stats> {
  const cfg = deps.loadConfig(deps.env);
  if (!cfg || !cfg.token) throw new SyncError(NOT_SET_UP);
  assertTokenBound(cfg);
  const { from, to } = presetRange(DAYS[range], deps.today());
  return deps.fetchStats(cfg.serverUrl, cfg.token, member ? { from, to, member } : { from, to });
}

export async function handleTool(
  name: string,
  args: unknown,
  deps: Partial<Deps> = {},
): Promise<{ text: string; isError?: boolean }> {
  try {
    const d: Deps = { ...defaults(), ...deps };
    switch (name) {
      case "sync_usage": {
        const input = syncInput.safeParse(args === undefined ? {} : args);
        if (!input.success) return fail(INVALID_INPUT);
        const labelHistory = input.data.labelHistory === true;
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
        const input = rangeInput.safeParse(args === undefined ? {} : args);
        if (!input.success) return fail(INVALID_INPUT);
        const s = await loadStats("me", input.data.range, d);
        return (() => {
          const mod = models(s);
          return ok({ from: clean(s.from), to: clean(s.to), totals: totals(s), models: mod.list, ...mod.extra });
        })();
      }
      case "get_team_usage": {
        const input = rangeInput.safeParse(args === undefined ? {} : args);
        if (!input.success) return fail(INVALID_INPUT);
        const s = await loadStats(undefined, input.data.range, d);
        const mem = capped<Stats["members"][number]>(s.members, MAX_MEMBERS, (x) => x.tokens, "memberCount");
        const mod = models(s);
        return ok({
          from: clean(s.from),
          to: clean(s.to),
          totals: totals(s),
          members: mem.kept.map((m) => ({
            name: clean(m.name),
            email: clean(m.email),
            tokens: num(m.tokens),
            costUsd: num(m.costUsd),
          })),
          models: mod.list,
          ...mem.extra,
          ...mod.extra,
        });
      }
      default:
        return fail(`unknown tool`);
    }
  } catch (e) {
    if (e instanceof ApiError) return fail(`server error: ${e.message}`);
    const safe = errorMessage(e);
    return fail(safe.startsWith("unexpected error") ? GENERIC_ERROR : safe);
  }
}

const totals = (s: Stats) => ({ tokens: num(s.totals?.tokens), costUsd: num(s.totals?.costUsd) });
const models = (s: Stats) => {
  const c = capped<Stats["models"][number]>(s.models, MAX_MODELS, (x) => x.total, "modelCount");
  return { list: c.kept.map(modelRow), extra: c.extra };
};
const modelRow = (m: Stats["models"][number]) => ({
    agent: clean(m.agent),
    model: clean(m.model),
    input: num(m.input),
    output: num(m.output),
    cacheCreate: num(m.cacheCreate),
    cacheRead: num(m.cacheRead),
    total: num(m.total),
    costUsd: num(m.costUsd),
    unpriced: m.unpriced === true,
  });

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
