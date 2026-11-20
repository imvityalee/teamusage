import { isIsoDate, localIsoDate, presetRange } from "@teamusage/shared";
import { ApiError, fetchStats } from "./api.js";
import { assertTokenBound, loadConfig } from "./config.js";
import { SyncError } from "./errors.js";
import { clean } from "./text.js";

// The usage report behind `teamusage stats` and the MCP tools get_my_usage and get_team_usage.

export const RANGES = ["1m", "3m", "6m"] as const;
export type Range = (typeof RANGES)[number];
const DAYS: Record<Range, 30 | 90 | 180> = { "1m": 30, "3m": 90, "6m": 180 };

export const COST_NOTE = "Cost is an estimate from public API prices, not what a subscription plan charges.";

export interface MemberUsage {
  name: string;
  email: string;
  tokens: number;
  costUsd: number;
}

export interface ModelUsage {
  agent: string;
  model: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
  costUsd: number;
  unpriced: boolean;
}

/** The part of a stats answer this client uses, checked and cleaned: every string is data (see `clean`), every number finite. */
export interface UsageReport {
  from: string;
  to: string;
  totals: { tokens: number; costUsd: number };
  members: MemberUsage[];
  models: ModelUsage[];
}

export interface ReportDeps {
  env: NodeJS.ProcessEnv;
  today: () => string; // local YYYY-MM-DD
  fetchStats: typeof fetchStats;
  loadConfig: typeof loadConfig;
}

export const reportDefaults = (): ReportDeps => ({ env: process.env, today: () => localIsoDate(), fetchStats, loadConfig });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Checks and cleans a stats answer. Without real dates, a totals object and member and model lists it is not one, and
 * fails with a fixed message; list entries that are not objects are dropped.
 */
export function readReport(raw: unknown): UsageReport {
  if (
    !isObj(raw) ||
    !isIsoDate(raw.from) ||
    !isIsoDate(raw.to) ||
    !isObj(raw.totals) ||
    !Array.isArray(raw.members) ||
    !Array.isArray(raw.models)
  ) {
    throw new ApiError(200, "the server sent an unexpected response");
  }
  return {
    from: raw.from,
    to: raw.to,
    totals: { tokens: num(raw.totals.tokens), costUsd: num(raw.totals.costUsd) },
    members: raw.members.filter(isObj).map((m) => ({
      name: clean(m.name),
      email: clean(m.email),
      tokens: num(m.tokens),
      costUsd: num(m.costUsd),
    })),
    models: raw.models.filter(isObj).map((m) => ({
      agent: clean(m.agent),
      model: clean(m.model),
      input: num(m.input),
      output: num(m.output),
      cacheCreate: num(m.cacheCreate),
      cacheRead: num(m.cacheRead),
      total: num(m.total),
      costUsd: num(m.costUsd),
      unpriced: m.unpriced === true,
    })),
  };
}

/** The report for a range, the member's own or the team's; refuses (sending nothing) without a token bound to this server and email. */
export async function loadReport(member: "me" | undefined, range: Range, deps: ReportDeps): Promise<UsageReport> {
  const cfg = deps.loadConfig(deps.env);
  if (!cfg || !cfg.token) throw new SyncError("notSetUp");
  assertTokenBound(cfg);
  const { from, to } = presetRange(DAYS[range], deps.today());
  return readReport(await deps.fetchStats(cfg.serverUrl, cfg.token, member ? { from, to, member } : { from, to }));
}
