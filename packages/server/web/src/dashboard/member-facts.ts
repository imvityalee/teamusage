import { parseAccountKey, parsePlanKey, type Stats } from "@teamusage/shared";
import { accountPlanName, planShort } from "../accounts.js";
import { daysSince } from "../format.js";
import { count, t, type Lang } from "../i18n.js";

/** What the dashboard reads from a member's numbers: shares, sync age and the checked breakdowns by agent and by account. */

export const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);
export const STALE_DAYS = 7;

export function lastSync(lang: Lang, at: string | null, today: string): { text: string; days: number | null } {
  const days = at === null ? null : daysSince(at, today);
  if (days === null) return { text: "—", days };
  if (days === 0) return { text: t(lang, "today"), days };
  if (days === 1) return { text: t(lang, "yesterday"), days };
  return { text: count(lang, "daysAgo", days), days };
}

/**
 * A member's tokens by agent, as a Map. The answer is server data checked only for its shape, so a malformed `byAgent`
 * gives an empty Map and entries without a finite, positive number are left out.
 */
export function agentMixOf(m: Stats["members"][number]): Map<string, number> {
  const v: unknown = m.byAgent;
  const out = new Map<string, number>();
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [agent, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n) && n > 0) out.set(agent, n);
  return out;
}

/**
 * A member's tokens by account and plan, largest first (ties by label, so the order never depends on the server's).
 * Entries with a malformed account or plan key or a bad number are left out; entries that show the same name
 * (for example a plan with no short name and no plan) are added together. Each is `[account, plan, tokens]`.
 */
export function byAccountPlanOf(m: Stats["members"][number]): [string, string, number][] {
  const v = (m as { byAccountPlan?: unknown }).byAccountPlan;
  if (!Array.isArray(v)) return [];
  const merged = new Map<string, [string, string, number]>();
  for (const e of v as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const { account, plan, tokens: n } = e as { account?: unknown; plan?: unknown; tokens?: unknown };
    if (typeof account !== "string" || typeof plan !== "string") continue;
    if (parseAccountKey(account) === undefined || parsePlanKey(plan) === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    const id = `${account}\u0000${planShort(plan)}`;
    const old = merged.get(id);
    if (old) old[2] = Math.min(old[2] + n, Number.MAX_VALUE);
    else merged.set(id, [account, plan, n]);
  }
  const label = (e: [string, string, number]) => accountPlanName(e[0], e[1], "en");
  return [...merged.values()].sort((a, b) => b[2] - a[2] || (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0));
}

export const sumOf = (parts: [string, string, number][]): number => parts.reduce((s, [, , n]) => s + n, 0);
