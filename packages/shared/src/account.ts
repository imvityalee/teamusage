import { MAX_ORG_CHARS, NAME_CONTROL_CHARS } from "./limits.js";

export type AccountKind = "personal" | "team" | "enterprise" | "api";
export const CLAUDE_PLANS = ["free", "pro", "max_5x", "max_20x", "team_standard", "team_premium", "enterprise"] as const;
export const CODEX_PLANS = ["free", "plus", "pro", "business", "enterprise", "edu"] as const;
export type Plan = (typeof CLAUDE_PLANS)[number] | (typeof CODEX_PLANS)[number];
export interface AccountLabel {
  kind: AccountKind;
  org?: string;
  plan?: Plan;
}

const KINDS: readonly AccountKind[] = ["personal", "team", "enterprise", "api"];
const WITH_ORG: readonly AccountKind[] = ["team", "enterprise"];

/** The plans an agent's account can have; none for agents without account labels. */
export function plansFor(agent: string): readonly Plan[] {
  return agent === "claude" ? CLAUDE_PLANS : agent === "codex" ? CODEX_PLANS : [];
}

const SHORT_NAMES: Partial<Record<Plan, string>> = {
  free: "Free",
  pro: "Pro",
  max_5x: "Max 5x",
  max_20x: "Max 20x",
  team_standard: "Standard",
  team_premium: "Premium",
  plus: "Plus",
  business: "Business",
  edu: "Edu",
};

/** Short plan name for badges; empty for `enterprise` (the account kind already says it) and for no plan. */
export function planShortName(plan: Plan | null | undefined): string {
  return plan ? (SHORT_NAMES[plan] ?? "") : "";
}

/**
 * Filter key. Claude: `team:<org>`, `enterprise:<org>`, `personal`, `api`, `unknown` for no label. Codex:
 * `chatgpt:<kind>`. `other` for an unlabelled agent, or a Codex record without a label.
 */
export function accountKey(a: AccountLabel | null | undefined, agent = "claude"): string {
  if (!a) return agent === "claude" ? "unknown" : "other";
  if (agent === "codex") return `chatgpt:${a.kind}`;
  return WITH_ORG.includes(a.kind) ? `${a.kind}:${a.org ?? ""}` : a.kind;
}

type ParsedAccountKey = {
  kind: AccountKind | "unknown" | "other";
  org: string | null;
  agent: "claude" | "codex" | null;
};

/** Inverse of accountKey, splitting on the first colon. `undefined` when malformed. */
export function parseAccountKey(key: string): ParsedAccountKey | undefined {
  if (key === "unknown") return { kind: "unknown", org: null, agent: "claude" };
  if (key === "other") return { kind: "other", org: null, agent: null };
  if (key === "personal" || key === "api") return { kind: key, org: null, agent: "claude" };
  const i = key.indexOf(":");
  if (i < 0) return undefined;
  const kind = key.slice(0, i);
  const org = key.slice(i + 1);
  if (kind === "chatgpt") return KINDS.includes(org as AccountKind) ? { kind: org as AccountKind, org: null, agent: "codex" } : undefined;
  if (kind !== "team" && kind !== "enterprise") return undefined;
  if (org.length > MAX_ORG_CHARS || NAME_CONTROL_CHARS.test(org)) return undefined;
  return { kind, org, agent: "claude" };
}

/** Plan filter key: `none` without a plan, else `<agent>:<plan>`. */
export function planKey(agent: string, plan: string | null | undefined): string {
  return plan ? `${agent}:${plan}` : "none";
}

/** Inverse of planKey. `undefined` when malformed or the plan does not belong to the agent. */
export function parsePlanKey(key: string): { agent: "claude" | "codex"; plan: Plan } | { agent: null; plan: null } | undefined {
  if (key === "none") return { agent: null, plan: null };
  const i = key.indexOf(":");
  if (i < 0) return undefined;
  const agent = key.slice(0, i);
  const plan = key.slice(i + 1);
  if (agent !== "claude" && agent !== "codex") return undefined;
  if (!plansFor(agent).includes(plan as Plan)) return undefined;
  return { agent, plan: plan as Plan };
}

/** Validates an uploaded account label; extra keys are dropped. A string result is the error. */
export function validateAccount(raw: unknown, agent: string): AccountLabel | string {
  if (agent !== "claude" && agent !== "codex") return "account on an unlabelled agent's record";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "invalid account";
  const { kind, org, plan } = raw as Record<string, unknown>;
  if (typeof kind !== "string" || !KINDS.includes(kind as AccountKind)) return "invalid account kind";
  const label: AccountLabel = { kind: kind as AccountKind };
  if (org !== undefined) {
    if (agent === "codex" || !WITH_ORG.includes(label.kind)) return "org is not allowed for this account kind";
    if (typeof org !== "string" || org.length > MAX_ORG_CHARS || NAME_CONTROL_CHARS.test(org)) {
      return "invalid account org";
    }
    label.org = org;
  }
  if (plan !== undefined) {
    if (typeof plan !== "string" || !plansFor(agent).includes(plan as Plan)) return "invalid account plan";
    label.plan = plan as Plan;
  }
  return label;
}
