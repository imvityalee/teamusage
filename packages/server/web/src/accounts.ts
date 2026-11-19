import { parseAccountKey, parsePlanKey, planShortName } from "@teamusage/shared";
import { t, type Lang, type MessageKey } from "./i18n.js";

/**
 * Display names of account keys (`accountKey` values from the server). Keys are data: they are parsed by the
 * shared `parseAccountKey` and looked up in the fixed map below; the org name is only ever shown as text.
 * Accounts have no colour or icon: agent colours stay the only categorical colours on the page.
 */

const KIND_NAMES = {
  team: "acctTeam",
  enterprise: "acctEnterprise",
  personal: "acctPersonal",
  api: "acctApi",
  unknown: "acctUnknown",
  other: "acctOther",
} as const satisfies Record<string, MessageKey>;

/**
 * "Team · Devcats", "Enterprise", "Personal", "API key" or "Unknown" (and the Russian equivalents). A malformed key
 * is "Unknown", never guessed into another kind.
 */
export function accountName(key: string, lang: Lang): string {
  const parsed = parseAccountKey(String(key));
  if (parsed === undefined) return t(lang, KIND_NAMES.unknown);
  const name = t(lang, KIND_NAMES[parsed.kind]);
  if (parsed.agent === "codex") return `${name} · ${t(lang, "acctChatgpt")}`;
  return parsed.org ? `${name} · ${parsed.org}` : name;
}

const PLAN_NAMES = {
  claude: {
    free: "planClaudeFree",
    pro: "planClaudePro",
    max_5x: "planClaudeMax5x",
    max_20x: "planClaudeMax20x",
    team_standard: "planClaudeTeamStandard",
    team_premium: "planClaudeTeamPremium",
    enterprise: "planClaudeEnterprise",
  },
  codex: {
    free: "planCodexFree",
    plus: "planCodexPlus",
    pro: "planCodexPro",
    business: "planCodexBusiness",
    enterprise: "planCodexEnterprise",
    edu: "planCodexEdu",
  },
} as const satisfies Record<string, Record<string, MessageKey>>;

/** "Claude Team Premium", "ChatGPT Plus" or "No plan" (also for a malformed key, never guessed). */
export function planName(key: string, lang: Lang): string {
  const parsed = parsePlanKey(String(key));
  if (parsed === undefined || parsed.agent === null) return t(lang, "planNone");
  const names: Record<string, MessageKey> = PLAN_NAMES[parsed.agent];
  const id = names[parsed.plan];
  return id === undefined ? t(lang, "planNone") : t(lang, id);
}

/** "Premium", "Plus", ...; empty for enterprise plans, no plan and a malformed key. */
export function planShort(key: string): string {
  const parsed = parsePlanKey(String(key));
  return parsed === undefined ? "" : planShortName(parsed.plan);
}

/** "Team · Devcats · Premium": the account name, then the short plan name when there is one. */
export function accountPlanName(account: string, plan: string, lang: Lang): string {
  const short = planShort(plan);
  return short ? `${accountName(account, lang)} · ${short}` : accountName(account, lang);
}
