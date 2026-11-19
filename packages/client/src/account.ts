import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readCodexAccount } from "./codex-account.js";
import { MAX_ORG_CHARS, planShortName, type AccountLabel, type Plan, type UsageRecord } from "@teamusage/shared";

/**
 * Claude Code keeps its account details in `.claude.json`: under `CLAUDE_CONFIG_DIR` when that is set,
 * otherwise in the home directory (code.claude.com/docs/en/claude-directory).
 */
export function claudeConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir && path.isAbsolute(dir) ? path.join(dir, ".claude.json") : path.join(home, ".claude.json");
}

const KIND_BY_TYPE: Readonly<Record<string, AccountLabel["kind"]>> = {
  claude_team: "team",
  claude_enterprise: "enterprise",
  claude_pro: "personal",
  claude_max: "personal",
  claude_free: "personal",
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

function cleanOrg(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const org = raw.replace(CONTROL, "").trim().slice(0, MAX_ORG_CHARS).trim();
  return org === "" ? undefined : org;
}

const TEAM_PREMIUM = new Set(["team_tier_1", "premium", "team_premium"]);
const TEAM_STANDARD = new Set(["standard", "team_standard"]);

/** The plan for a Claude login; an unrecognised type, seat or tier gives none. */
function claudePlan(type: string, seatTier: unknown, rateTier: unknown): Plan | undefined {
  switch (type) {
    case "claude_free":
      return "free";
    case "claude_pro":
      return "pro";
    case "claude_enterprise":
      return "enterprise";
    case "claude_max":
      if (typeof rateTier !== "string") return undefined;
      return rateTier.includes("max_20x") ? "max_20x" : rateTier.includes("max_5x") ? "max_5x" : undefined;
    case "claude_team":
      if (typeof seatTier !== "string") return undefined;
      return TEAM_PREMIUM.has(seatTier) ? "team_premium" : TEAM_STANDARD.has(seatTier) ? "team_standard" : undefined;
    default:
      return undefined;
  }
}

/**
 * The current Claude login, reduced to a kind, a plan and (team/enterprise only) an organisation name.
 * Only `oauthAccount.organizationType`, `organizationName`, `seatTier` and `userRateLimitTier` are read. Any problem gives null.
 */
export function readClaudeAccount(
  deps: { env?: NodeJS.ProcessEnv; home?: string | (() => string); readFile?: (p: string) => string } = {},
): AccountLabel | null {
  const { env = process.env, home = homedir, readFile = (p: string) => readFileSync(p, "utf8") } = deps;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(claudeConfigPath(env, typeof home === "function" ? home() : home)));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const oauth = (parsed as { oauthAccount?: unknown }).oauthAccount;
  if (oauth === undefined) return { kind: "api" };
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return null;
  const { organizationType, organizationName, seatTier, userRateLimitTier } = oauth as {
    organizationType?: unknown;
    organizationName?: unknown;
    seatTier?: unknown;
    userRateLimitTier?: unknown;
  };
  const kind = typeof organizationType === "string" && Object.hasOwn(KIND_BY_TYPE, organizationType)
      ? KIND_BY_TYPE[organizationType]
      : undefined;
  if (kind === undefined) return null;
  const plan = claudePlan(organizationType as string, seatTier, userRateLimitTier);
  const label: AccountLabel = { kind };
  if (kind !== "personal") {
    const org = cleanOrg(organizationName);
    if (org !== undefined) label.org = org;
  }
  if (plan !== undefined) label.plan = plan;
  return label;
}

const dayBefore = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

export interface Logins {
  claude: AccountLabel | null;
  codex: AccountLabel | null;
}

/**
 * Labels Claude and Codex records with their login when dated `today` or the day before (any date with `history`);
 * every other record, and every other agent, carries no account.
 */
export function labelRecords(
  records: UsageRecord[],
  logins: Logins,
  today: string,
  opts: { history?: boolean } = {},
): UsageRecord[] {
  const recent = new Set([today, dayBefore(today)]);
  return records.map((r) => {
    const { account: _drop, ...rest } = r;
    const login = r.agent === "claude" ? logins.claude : r.agent === "codex" ? logins.codex : null;
    return login !== null && (opts.history === true || recent.has(r.date)) ? { ...rest, account: login } : rest;
  });
}

/** A short display name for a login, e.g. "Team · Acme · Premium" or "Personal · ChatGPT · Plus". */
export function describeLogin(agent: "claude" | "codex", a: AccountLabel): string {
  let name: string;
  if (agent === "codex") {
    name = `${{ personal: "Personal", team: "Team", enterprise: "Enterprise", api: "API key" }[a.kind]} · ChatGPT`;
  } else if (a.kind === "team" || a.kind === "enterprise") {
    const kind = a.kind === "team" ? "Team" : "Enterprise";
    name = a.org ? `${kind} · ${a.org}` : kind;
  } else {
    name = a.kind === "personal" ? "Personal" : "API key";
  }
  const plan = planShortName(a.plan);
  return plan === "" ? name : `${name} · ${plan}`;
}

/** Reads each login on its own: a reader that throws gives null for that agent only. */
export function readLogins(
  readers: { claude: () => AccountLabel | null; codex: () => AccountLabel | null } = {
    claude: () => readClaudeAccount(),
    codex: () => readCodexAccount(),
  },
): Logins {
  const safe = (read: () => AccountLabel | null): AccountLabel | null => {
    try {
      return read();
    } catch {
      return null;
    }
  };
  return { claude: safe(readers.claude), codex: safe(readers.codex) };
}
