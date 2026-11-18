import type { Stats } from "@teamusage/shared";

/**
 * The agent and model filters. They live only in memory: they are never stored and never put in the URL, and
 * reach the server only as `agent` and `model` query parameters (see `toQuery`).
 * Agent ids and model names are compared as plain strings, through Map and Set only.
 */

export interface ModelRef {
  agent: string;
  model: string;
}

export interface Filters {
  agents: string[];
  models: ModelRef[];
}

export const NO_FILTERS: Filters = Object.freeze({ agents: Object.freeze([]), models: Object.freeze([]) }) as unknown as Filters;

/** The server's limits; the page never asks for more. */
export const MAX_AGENTS = 20;
export const MAX_MODELS = 50;

/**
 * Whether a model can be filtered on. The server reads `<agent>:<model>` up to the first colon, so a model of an
 * agent whose id has a colon would be read as a different pair.
 */
export function canFilterModel(ref: ModelRef): boolean {
  return !String(ref.agent).includes(":");
}

/** Query parameters, agents first in selection order, then models as `<agent>:<model>`. */
export function toQuery(f: Filters): [string, string][] {
  return [
    ...f.agents.slice(0, MAX_AGENTS).map((a): [string, string] => ["agent", a]),
    ...f.models
      .filter(canFilterModel)
      .slice(0, MAX_MODELS)
      .map((m): [string, string] => ["model", `${m.agent}:${m.model}`]),
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
  return {
    agents: f.agents.filter((a) => agents.has(a)),
    models: f.models.filter((m) => models.get(m.agent)?.has(m.model) === true),
  };
}

export function isActive(f: Filters): boolean {
  return f.agents.length > 0 || f.models.length > 0;
}

/** Drives a button label: "All agents" when nothing or everything is selected, otherwise "N agents". */
export function summary(selected: number, total: number): "all" | "some" {
  return selected === 0 || selected === total ? "all" : "some";
}

export function equalFilters(a: Filters, b: Filters): boolean {
  return (
    a.agents.length === b.agents.length &&
    a.agents.every((x, i) => x === b.agents[i]) &&
    a.models.length === b.models.length &&
    a.models.every((x, i) => sameModel(x, b.models[i] as ModelRef))
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
  return { filters: { agents, models }, limited: false };
}

/** Adds or removes an exact (agent, model) pair. */
export function toggleModel(f: Filters, ref: ModelRef): Toggled {
  if (!canFilterModel(ref)) return { filters: f, limited: false };
  const has = f.models.some((m) => sameModel(m, ref));
  if (!has && f.models.length >= MAX_MODELS) return { filters: f, limited: true };
  const models = has ? f.models.filter((m) => !sameModel(m, ref)) : [...f.models, { agent: ref.agent, model: ref.model }];
  return { filters: { agents: f.agents, models }, limited: false };
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
