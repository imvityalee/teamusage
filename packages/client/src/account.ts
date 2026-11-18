import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_ORG_CHARS, type AccountLabel, type UsageRecord } from "@teamusage/shared";

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

/**
 * The current Claude login, reduced to a kind and (team/enterprise only) an organisation name.
 * Only `oauthAccount.organizationType` and `organizationName` are read. Any problem gives null.
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
  const { organizationType, organizationName } = oauth as { organizationType?: unknown; organizationName?: unknown };
  const kind = typeof organizationType === "string" && Object.hasOwn(KIND_BY_TYPE, organizationType)
      ? KIND_BY_TYPE[organizationType]
      : undefined;
  if (kind === undefined) return null;
  if (kind === "personal") return { kind };
  const org = cleanOrg(organizationName);
  return org === undefined ? { kind } : { kind, org };
}

const dayBefore = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

/** Labels Claude records dated `today` or the day before; every other record carries no account. */
export function labelRecords(records: UsageRecord[], account: AccountLabel | null, today: string): UsageRecord[] {
  const recent = new Set([today, dayBefore(today)]);
  return records.map((r) => {
    const { account: _drop, ...rest } = r;
    return account !== null && r.agent === "claude" && recent.has(r.date) ? { ...rest, account } : rest;
  });
}
