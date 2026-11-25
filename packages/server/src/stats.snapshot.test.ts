import type { Stats } from "@teamusage/shared";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { Db } from "./db.js";
import { getStats } from "./stats.js";
import { Q, seed, seedAccounts, seedFilters, seedMix, seedPlans } from "./stats.fixture.js";

type Filters = Omit<Parameters<typeof getStats>[2], "from" | "to" | "memberId">;

// The seeds stamp `last_sync_at` with the clock; a fixed clock keeps the snapshot stable.
beforeAll(() => {
  vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00.000Z"), toFake: ["Date"] });
});
afterAll(() => {
  vi.useRealTimers();
});

/** No filter, each available agent, model, account and plan alone, and the first agent with the first model. */
function filterCases(base: Stats): [string, Filters][] {
  const [agent] = base.available.agents;
  const [model] = base.available.models;
  return [
    ["no filter", {}],
    ...base.available.agents.map((a): [string, Filters] => [`agent ${a}`, { agents: [a] }]),
    ...base.available.models.map((m): [string, Filters] => [`model ${m.agent}/${m.model}`, { models: [{ agent: m.agent, model: m.model }] }]),
    ...base.available.accounts.map((a): [string, Filters] => [`account ${a.key}`, { accounts: [a.key] }]),
    ...base.available.plans.map((p): [string, Filters] => [`plan ${p.key}`, { plans: [p.key] }]),
    ...(agent !== undefined && model !== undefined
      ? [[`agent ${agent} and model ${model.agent}/${model.model}`, { agents: [agent], models: [{ agent: model.agent, model: model.model }] }] as [string, Filters]]
      : []),
  ];
}

/** Every filter case for the team view and for each member's view, keyed by view and case. */
function allViews(db: Db, team: number): Record<string, Stats> {
  const base = getStats(db, team, Q);
  const views: [string, number | undefined][] = [["team", undefined], ...base.members.map((m): [string, number] => [`member ${m.id}`, m.id])];
  const results: Record<string, Stats> = {};
  for (const [view, memberId] of views) {
    for (const [name, filters] of filterCases(base)) {
      results[`${view} | ${name}`] = getStats(db, team, { ...Q, ...filters, ...(memberId === undefined ? {} : { memberId }) });
    }
  }
  return results;
}

const seeds = { seed, seedFilters, seedMix, seedAccounts, seedPlans };

for (const [name, make] of Object.entries(seeds)) {
  test(`${name}: every filter case, team and member views`, () => {
    const { db, team } = make();
    expect(allViews(db, team)).toMatchSnapshot();
  });
}
