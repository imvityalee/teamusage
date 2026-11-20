import {
  MAX_ACCOUNT_FILTERS,
  MAX_AGENT_FILTERS,
  MAX_MODEL_FILTERS,
  MAX_PLAN_FILTERS,
  parseAccountKey,
  parsePlanKey,
  type Stats,
} from "@teamusage/shared";

/**
 * The agent, model, account and plan filters. They live only in memory: they are never stored and never put in the
 * URL, and reach the server only as `agent`, `model`, `account` and `plan` query parameters (see `toQuery`).
 * Agent ids, model names, account keys and plan keys are compared as plain strings, through Map and Set only.
 */

export interface ModelRef {
  agent: string;
  model: string;
}

export interface Filters {
  agents: string[];
  models: ModelRef[];
  /** Account keys (`accountKey` values), in selection order. */
  accounts: string[];
  /** Plan keys (`claude:team_premium`, `codex:plus`, `none`), in selection order. */
  plans: string[];
}

export type FilterKind = keyof Filters;

/** In the order of the filter bar and the query parameters. */
export const FILTER_KINDS: readonly FilterKind[] = ["agents", "models", "accounts", "plans"];

/** The filters that are plain lists of keys, with no rule tying them to another filter. */
export const KEY_KINDS = ["accounts", "plans"] as const satisfies readonly FilterKind[];
export type KeyKind = (typeof KEY_KINDS)[number];

export const NO_FILTERS: Filters = Object.freeze({
  agents: Object.freeze([]),
  models: Object.freeze([]),
  accounts: Object.freeze([]),
  plans: Object.freeze([]),
}) as unknown as Filters;

/** The server's limits; the page never asks for more. */
export const LIMITS: Readonly<Record<FilterKind, number>> = {
  agents: MAX_AGENT_FILTERS,
  models: MAX_MODEL_FILTERS,
  accounts: MAX_ACCOUNT_FILTERS,
  plans: MAX_PLAN_FILTERS,
};

/**
 * Whether a model can be filtered on. The server reads `<agent>:<model>` up to the first colon, so a model of an
 * agent whose id has a colon would be read as a different pair.
 */
export function canFilterModel(ref: ModelRef): boolean {
  return !String(ref.agent).includes(":");
}

/** Query parameters, agents first in selection order, then models as `<agent>:<model>`, then account keys, then plan keys. */
export function toQuery(f: Filters): [string, string][] {
  const pairs = (name: string, values: string[], max: number) => values.slice(0, max).map((v): [string, string] => [name, v]);
  return [
    ...pairs("agent", f.agents, LIMITS.agents),
    ...pairs("model", f.models.filter(canFilterModel).map((m) => `${m.agent}:${m.model}`), LIMITS.models),
    ...pairs("account", f.accounts, LIMITS.accounts),
    ...pairs("plan", f.plans, LIMITS.plans),
  ];
}

const sameModel = (a: ModelRef, b: ModelRef): boolean => a.agent === b.agent && a.model === b.model;

/** Models available per agent, for exact pair lookups without composing a key. */
function modelIndex(available: Stats["available"]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const m of available.models) {
    const set = index.get(m.agent) ?? new Set<string>();
    set.add(m.model);
    index.set(m.agent, set);
  }
  return index;
}

const keysOf = (list: { key: string }[]): Set<string> => new Set(list.map((a) => a.key));

/** Drops selections that are not in `available`; keeps the rest in order. */
export function prune(f: Filters, available: Stats["available"]): Filters {
  const agents = new Set(available.agents);
  const models = modelIndex(available);
  const accounts = keysOf(available.accounts);
  const plans = keysOf(available.plans);
  return {
    agents: f.agents.filter((a) => agents.has(a)),
    models: f.models.filter((m) => models.get(m.agent)?.has(m.model) === true),
    accounts: f.accounts.filter((k) => accounts.has(k)),
    plans: f.plans.filter((k) => plans.has(k)),
  };
}

export function isActive(f: Filters): boolean {
  return FILTER_KINDS.some((kind) => f[kind].length > 0);
}

/** True when `after` lost every selection of a filter that `before` had: the answer was narrowed by a filter now gone. */
export function anyFilterEmptied(before: Filters, after: Filters): boolean {
  return FILTER_KINDS.some((kind) => before[kind].length > 0 && after[kind].length === 0);
}

const sameList = <T>(a: T[], b: T[], same: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((x, i) => same(x, b[i] as T));
const sameString = (x: string, y: string): boolean => x === y;

export function equalFilters(a: Filters, b: Filters): boolean {
  return (
    sameList(a.agents, b.agents, sameString) &&
    sameList(a.models, b.models, sameModel) &&
    sameList(a.accounts, b.accounts, sameString) &&
    sameList(a.plans, b.plans, sameString)
  );
}

export interface Toggled {
  filters: Filters;
  /** True when the change was refused because the list is full. */
  limited: boolean;
}

/** `list` without `key` when it has it, else with `key` added; null when adding would go over `max`. */
function toggled(list: string[], key: string, max: number): string[] | null {
  if (list.includes(key)) return list.filter((k) => k !== key);
  return list.length >= max ? null : [...list, key];
}

/** Adds or removes an agent. While agents are selected, selected models of other agents are dropped. */
export function toggleAgent(f: Filters, id: string): Toggled {
  const agents = toggled(f.agents, id, LIMITS.agents);
  if (agents === null) return { filters: f, limited: true };
  const listed = new Set(agents);
  const models = agents.length === 0 ? f.models : f.models.filter((m) => listed.has(m.agent));
  return { filters: { ...f, agents, models }, limited: false };
}

/** Adds or removes an exact (agent, model) pair. */
export function toggleModel(f: Filters, ref: ModelRef): Toggled {
  if (!canFilterModel(ref)) return { filters: f, limited: false };
  const has = f.models.some((m) => sameModel(m, ref));
  if (!has && f.models.length >= LIMITS.models) return { filters: f, limited: true };
  const models = has ? f.models.filter((m) => !sameModel(m, ref)) : [...f.models, { agent: ref.agent, model: ref.model }];
  return { filters: { ...f, models }, limited: false };
}

/** Adds or removes an account or plan key. The other filters are left as they are. */
export function toggleKey(f: Filters, kind: KeyKind, key: string): Toggled {
  const keys = toggled(f[kind], key, LIMITS[kind]);
  return keys === null ? { filters: f, limited: true } : { filters: { ...f, [kind]: keys }, limited: false };
}

const isTokenCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The `{ key, tokens }` entries of `raw` with a valid key and a finite, non-negative total. */
function keyedTotals(raw: unknown, validKey: (key: string) => boolean): { key: string; tokens: number }[] {
  return (Array.isArray(raw) ? raw : []).flatMap((a: unknown) => {
    if (typeof a !== "object" || a === null) return [];
    const { key, tokens } = a as { key?: unknown; tokens?: unknown };
    return typeof key === "string" && validKey(key) && isTokenCount(tokens) ? [{ key, tokens }] : [];
  });
}

/**
 * The filter lists from an answer, keeping only well-formed entries: agent ids that are strings; models with a string
 * agent and model and a finite, non-negative total; accounts and plans with a well-formed key and such a total.
 * Anything else is dropped, so a `null` cannot make `prune` throw and no total can show as NaN.
 */
export function cleanAvailable(raw: unknown): Stats["available"] {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as { agents?: unknown; models?: unknown; accounts?: unknown; plans?: unknown };
  const agents = Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === "string") : [];
  const models = (Array.isArray(r.models) ? r.models : []).flatMap((m: unknown) => {
    if (typeof m !== "object" || m === null) return [];
    const { agent, model, tokens } = m as { agent?: unknown; model?: unknown; tokens?: unknown };
    return typeof agent === "string" && typeof model === "string" && isTokenCount(tokens) ? [{ agent, model, tokens }] : [];
  });
  return {
    agents,
    models,
    accounts: keyedTotals(r.accounts, (k) => parseAccountKey(k) !== undefined),
    plans: keyedTotals(r.plans, (k) => parsePlanKey(k) !== undefined),
  };
}

/** `list` plus every selected key it lacks, at zero tokens. */
function withKeys(list: { key: string; tokens: number }[], selected: string[]): { key: string; tokens: number }[] {
  const present = keysOf(list);
  const missing = [...new Set(selected)].filter((key) => !present.has(key));
  return [...list, ...missing.map((key) => ({ key, tokens: 0 }))];
}

/**
 * The period's items plus every selected item they lack, at zero, so a selection is always listed and can be
 * unticked (for example on a member's page, whose `available` is that member's).
 */
export function withSelection(available: Stats["available"], f: Filters): Stats["available"] {
  const present = new Set(available.agents);
  const agents = [...available.agents, ...[...new Set(f.agents)].filter((a) => !present.has(a))];
  const index = modelIndex(available);
  const models = [...available.models];
  for (const m of f.models) {
    if (index.get(m.agent)?.has(m.model) === true) continue;
    models.push({ agent: m.agent, model: m.model, tokens: 0 });
    index.set(m.agent, (index.get(m.agent) ?? new Set<string>()).add(m.model));
  }
  return { agents, models, accounts: withKeys(available.accounts, f.accounts), plans: withKeys(available.plans, f.plans) };
}

const positive = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
const capped = (n: number): number => Math.min(n, Number.MAX_VALUE);

/** Each agent's tokens in the period, ignoring the filters, in `available` order. */
export function availableAgentTotals(available: Stats["available"]): Map<string, number> {
  const totals = new Map<string, number>(available.agents.map((a) => [a, 0]));
  for (const m of available.models) totals.set(m.agent, capped((totals.get(m.agent) ?? 0) + positive(m.tokens)));
  return totals;
}

/** Every token in the period, ignoring the filters: the base for "N% of all tokens in this period". */
export function availableTotal(available: Stats["available"]): number {
  return available.models.reduce((sum, m) => capped(sum + positive(m.tokens)), 0);
}
