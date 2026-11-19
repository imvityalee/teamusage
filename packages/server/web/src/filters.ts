import { MAX_ACCOUNTS, parseAccountKey, type Stats } from "@teamusage/shared";

/**
 * The agent, model and account filters. They live only in memory: they are never stored and never put in the URL,
 * and reach the server only as `agent`, `model` and `account` query parameters (see `toQuery`).
 * Agent ids, model names and account keys are compared as plain strings, through Map and Set only.
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
}

export const NO_FILTERS: Filters = Object.freeze({
  agents: Object.freeze([]),
  models: Object.freeze([]),
  accounts: Object.freeze([]),
}) as unknown as Filters;

/** The server's limits; the page never asks for more. */
export const MAX_AGENTS = 20;
export const MAX_MODELS = 50;
export { MAX_ACCOUNTS };

/**
 * Whether a model can be filtered on. The server reads `<agent>:<model>` up to the first colon, so a model of an
 * agent whose id has a colon would be read as a different pair.
 */
export function canFilterModel(ref: ModelRef): boolean {
  return !String(ref.agent).includes(":");
}

/** Query parameters, agents first in selection order, then models as `<agent>:<model>`, then account keys. */
export function toQuery(f: Filters): [string, string][] {
  return [
    ...f.agents.slice(0, MAX_AGENTS).map((a): [string, string] => ["agent", a]),
    ...f.models
      .filter(canFilterModel)
      .slice(0, MAX_MODELS)
      .map((m): [string, string] => ["model", `${m.agent}:${m.model}`]),
    ...f.accounts.slice(0, MAX_ACCOUNTS).map((k): [string, string] => ["account", k]),
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

/** Drops selections that are not in `available`; keeps the rest in order. */
export function prune(f: Filters, available: Stats["available"]): Filters {
  const agents = new Set(available.agents);
  const models = modelIndex(available);
  const accounts = new Set(available.accounts.map((a) => a.key));
  return {
    agents: f.agents.filter((a) => agents.has(a)),
    models: f.models.filter((m) => models.get(m.agent)?.has(m.model) === true),
    accounts: f.accounts.filter((k) => accounts.has(k)),
  };
}

export function isActive(f: Filters): boolean {
  return f.agents.length > 0 || f.models.length > 0 || f.accounts.length > 0;
}

/**
 * Drives a button label: "All agents" only when nothing is selected, otherwise "N agents", even when every item is
 * ticked, so the button never says "All" while chips are showing. `total` is kept for callers' clarity.
 */
export function summary(selected: number, _total: number): "all" | "some" {
  return selected === 0 ? "all" : "some";
}

export function equalFilters(a: Filters, b: Filters): boolean {
  return (
    a.agents.length === b.agents.length &&
    a.agents.every((x, i) => x === b.agents[i]) &&
    a.models.length === b.models.length &&
    a.models.every((x, i) => sameModel(x, b.models[i] as ModelRef)) &&
    a.accounts.length === b.accounts.length &&
    a.accounts.every((x, i) => x === b.accounts[i])
  );
}

export interface Toggled {
  filters: Filters;
  /** True when the change was refused because the list is full. */
  limited: boolean;
}

/** Adds or removes an agent. While agents are selected, selected models of other agents are dropped. */
export function toggleAgent(f: Filters, id: string): Toggled {
  const has = f.agents.includes(id);
  if (!has && f.agents.length >= MAX_AGENTS) return { filters: f, limited: true };
  const agents = has ? f.agents.filter((a) => a !== id) : [...f.agents, id];
  const listed = new Set(agents);
  const models = agents.length === 0 ? f.models : f.models.filter((m) => listed.has(m.agent));
  return { filters: { ...f, agents, models }, limited: false };
}

/** Adds or removes an exact (agent, model) pair. */
export function toggleModel(f: Filters, ref: ModelRef): Toggled {
  if (!canFilterModel(ref)) return { filters: f, limited: false };
  const has = f.models.some((m) => sameModel(m, ref));
  if (!has && f.models.length >= MAX_MODELS) return { filters: f, limited: true };
  const models = has ? f.models.filter((m) => !sameModel(m, ref)) : [...f.models, { agent: ref.agent, model: ref.model }];
  return { filters: { ...f, models }, limited: false };
}

/** Adds or removes an account key. Agents and models are left as they are. */
export function toggleAccount(f: Filters, key: string): Toggled {
  const has = f.accounts.includes(key);
  if (!has && f.accounts.length >= MAX_ACCOUNTS) return { filters: f, limited: true };
  const accounts = has ? f.accounts.filter((k) => k !== key) : [...f.accounts, key];
  return { filters: { ...f, accounts }, limited: false };
}

/**
 * The filter lists from an answer, keeping only well-formed entries: agent ids that are strings, and models with a
 * string agent and model and a finite, non-negative total, and accounts with a well-formed key and such a total.
 * Anything else is dropped, so a `null` cannot make `prune` throw and no total can show as NaN.
 */
export function cleanAvailable(raw: unknown): Stats["available"] {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as { agents?: unknown; models?: unknown; accounts?: unknown };
  const agents = Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === "string") : [];
  const models = (Array.isArray(r.models) ? r.models : []).flatMap((m: unknown) => {
    if (typeof m !== "object" || m === null) return [];
    const { agent, model, tokens: n } = m as { agent?: unknown; model?: unknown; tokens?: unknown };
    if (typeof agent !== "string" || typeof model !== "string" || typeof n !== "number" || !Number.isFinite(n) || n < 0) return [];
    return [{ agent, model, tokens: n }];
  });
  // Same rules for accounts; the key must also be a well-formed account key.
  const accounts = (Array.isArray(r.accounts) ? r.accounts : []).flatMap((a: unknown) => {
    if (typeof a !== "object" || a === null) return [];
    const { key, tokens: n } = a as { key?: unknown; tokens?: unknown };
    if (typeof key !== "string" || parseAccountKey(key) === undefined) return [];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return [];
    return [{ key, tokens: n }];
  });
  return { agents, models, accounts, plans: [] }; // plans: a later task
}

/**
 * The period's items plus every selected item they lack, at zero, so a selection is always listed and can be
 * unticked (for example on a member's page, whose `available` is that member's).
 */
export function withSelection(available: Stats["available"], f: Filters): Stats["available"] {
  const agents = [...available.agents];
  const seen = new Set(agents);
  for (const a of f.agents) {
    if (!seen.has(a)) {
      agents.push(a);
      seen.add(a);
    }
  }
  const index = modelIndex(available);
  const models = [...available.models];
  for (const m of f.models) {
    if (index.get(m.agent)?.has(m.model) === true) continue;
    models.push({ agent: m.agent, model: m.model, tokens: 0 });
    index.set(m.agent, (index.get(m.agent) ?? new Set<string>()).add(m.model));
  }
  const accounts = [...available.accounts];
  const keys = new Set(accounts.map((a) => a.key));
  for (const key of f.accounts) {
    if (keys.has(key)) continue;
    accounts.push({ key, tokens: 0 });
    keys.add(key);
  }
  return { agents, models, accounts, plans: [] }; // plans: a later task
}

const tokens = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);
const capped = (n: number): number => Math.min(n, Number.MAX_VALUE);

/** Each agent's tokens in the period, ignoring the filters, in `available` order. */
export function agentTotals(available: Stats["available"]): Map<string, number> {
  const totals = new Map<string, number>(available.agents.map((a) => [a, 0]));
  for (const m of available.models) totals.set(m.agent, capped((totals.get(m.agent) ?? 0) + tokens(m.tokens)));
  return totals;
}

/** Every token in the period, ignoring the filters: the base for "N% of all tokens in this period". */
export function availableTotal(available: Stats["available"]): number {
  return available.models.reduce((sum, m) => capped(sum + tokens(m.tokens)), 0);
}
