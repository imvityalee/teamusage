import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import {
  availableAgentTotals,
  availableTotal,
  canFilterModel,
  cleanAvailable,
  anyFilterEmptied,
  equalFilters,
  isActive,
  LIMITS,
  NO_FILTERS,
  prune,
  toggleAgent,
  toggleKey,
  toggleModel,
  toQuery,
  withSelection,
  type Filters,
} from "./filters.js";

const available: Stats["available"] = {
  agents: ["claude", "codex", "x"],
  models: [
    { agent: "claude", model: "opus-4-7", tokens: 50 },
    { agent: "codex", model: "gpt-5", tokens: 30 },
    { agent: "claude", model: "sonnet-4-6", tokens: 20 },
    { agent: "x", model: "a:b", tokens: 1 },
  ],
  accounts: [
    { key: "team:Devcats", tokens: 80 },
    { key: "personal", tokens: 20 },
    { key: "unknown", tokens: 1 },
  ],
  plans: [],
};

describe("toQuery", () => {
  test("agents first in selection order, then models as <agent>:<model>, then one account per selected key", () => {
    const f: Filters = {
      agents: ["codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }, { agent: "codex", model: "gpt-5" }],
      accounts: ["team:Devcats", "unknown"],
      plans: [],
    };
    expect(toQuery(f)).toEqual([
      ["agent", "codex"],
      ["agent", "claude"],
      ["model", "claude:opus-4-7"],
      ["model", "codex:gpt-5"],
      ["account", "team:Devcats"],
      ["account", "unknown"],
    ]);
    expect(new URLSearchParams(toQuery(f)).toString()).toBe(
      "agent=codex&agent=claude&model=claude%3Aopus-4-7&model=codex%3Agpt-5&account=team%3ADevcats&account=unknown",
    );
  });

  test("an account key with an org containing a colon or markup is sent as it is", () => {
    expect(toQuery({ agents: [], models: [], accounts: ["team:a:b", "enterprise:<b>x</b>", "team:"], plans: [] })).toEqual([
      ["account", "team:a:b"],
      ["account", "enterprise:<b>x</b>"],
      ["account", "team:"],
    ]);
  });

  test("a model name containing a colon is kept whole after the first colon", () => {
    expect(toQuery({ agents: [], models: [{ agent: "x", model: "a:b" }], accounts: [], plans: [] })).toEqual([["model", "x:a:b"]]);
  });

  test("no filters, no parameters", () => {
    expect(toQuery(NO_FILTERS)).toEqual([]);
  });

  test("never more than the server's limits, even from a malformed state", () => {
    const f: Filters = {
      agents: Array.from({ length: 30 }, (_, i) => `a${i}`),
      models: Array.from({ length: 70 }, (_, i) => ({ agent: "a", model: `m${i}` })),
      accounts: Array.from({ length: 70 }, (_, i) => `team:o${i}`),
      plans: [],
    };
    const q = toQuery(f);
    expect(q.filter(([k]) => k === "agent")).toHaveLength(LIMITS.agents);
    expect(q.filter(([k]) => k === "model")).toHaveLength(LIMITS.models);
    expect(q.filter(([k]) => k === "account")).toHaveLength(LIMITS.accounts);
    expect([LIMITS.agents, LIMITS.models, LIMITS.accounts]).toEqual([20, 50, 50]);
  });
});

describe("prune", () => {
  test("drops selections that are no longer available and keeps the rest in order", () => {
    const f: Filters = {
      agents: ["gemini", "codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }, { agent: "claude", model: "gone" }, { agent: "codex", model: "opus-4-7" }],
      accounts: ["api", "team:Devcats", "personal", "team:"],
      plans: [],
    };
    expect(prune(f, available)).toEqual({
      agents: ["codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }],
      accounts: ["team:Devcats", "personal"],
      plans: [],
    });
  });

  test("an empty available clears everything; nothing selected stays nothing", () => {
    expect(prune({ agents: ["claude"], models: [{ agent: "claude", model: "opus-4-7" }], accounts: ["personal"], plans: [] }, { agents: [], models: [], accounts: [], plans: [] })).toEqual(NO_FILTERS);
    expect(prune(NO_FILTERS, available)).toEqual(NO_FILTERS);
  });

  test("ids that look like object keys are compared as plain strings", () => {
    const odd: Stats["available"] = { agents: ["__proto__"], models: [{ agent: "__proto__", model: "constructor", tokens: 1 }], accounts: [], plans: [] };
    const f: Filters = { agents: ["__proto__", "constructor"], models: [{ agent: "__proto__", model: "constructor" }, { agent: "toString", model: "x" }], accounts: [], plans: [] };
    expect(prune(f, odd)).toEqual({ agents: ["__proto__"], models: [{ agent: "__proto__", model: "constructor" }], accounts: [], plans: [] });
  });
});

describe("isActive, anyFilterEmptied, equalFilters", () => {
  test("isActive is true when either list has a selection", () => {
    expect(isActive(NO_FILTERS)).toBe(false);
    expect(isActive({ agents: ["claude"], models: [], accounts: [], plans: [] })).toBe(true);
    expect(isActive({ agents: [], models: [{ agent: "claude", model: "m" }], accounts: [], plans: [] })).toBe(true);
    expect(isActive({ agents: [], models: [], accounts: ["unknown"], plans: [] })).toBe(true);
  });

  test("anyFilterEmptied is true only when a filter that had selections has none left", () => {
    const before: Filters = { agents: ["a"], models: [], accounts: ["unknown"], plans: [] };
    expect(anyFilterEmptied(before, { ...before, accounts: [] })).toBe(true);
    expect(anyFilterEmptied(before, before)).toBe(false);
    expect(anyFilterEmptied(NO_FILTERS, NO_FILTERS)).toBe(false);
  });

  test("equalFilters compares contents, not identity", () => {
    expect(equalFilters({ agents: ["a"], models: [], accounts: [], plans: [] }, { agents: ["a"], models: [], accounts: [], plans: [] })).toBe(true);
    expect(equalFilters({ agents: ["a"], models: [], accounts: [], plans: [] }, { agents: ["b"], models: [], accounts: [], plans: [] })).toBe(false);
    expect(equalFilters({ agents: [], models: [{ agent: "a", model: "b:c" }], accounts: [], plans: [] }, { agents: [], models: [{ agent: "a:b", model: "c" }], accounts: [], plans: [] })).toBe(false);
    expect(equalFilters({ agents: [], models: [], accounts: ["api"], plans: [] }, { agents: [], models: [], accounts: ["api"], plans: [] })).toBe(true);
    expect(equalFilters({ agents: [], models: [], accounts: ["api"], plans: [] }, { agents: [], models: [], accounts: ["personal"], plans: [] })).toBe(false);
    expect(equalFilters({ agents: [], models: [], accounts: ["api"], plans: [] }, { agents: [], models: [], accounts: [], plans: [] })).toBe(false);
  });
});

describe("toggling", () => {
  test("toggleAgent adds and removes without touching the input", () => {
    const start: Filters = { agents: ["claude"], models: [], accounts: [], plans: [] };
    const added = toggleAgent(start, "codex");
    expect(added).toEqual({ filters: { agents: ["claude", "codex"], models: [], accounts: [], plans: [] }, limited: false });
    expect(start).toEqual({ agents: ["claude"], models: [], accounts: [], plans: [] });
    expect(toggleAgent(added.filters, "claude").filters).toEqual({ agents: ["codex"], models: [], accounts: [], plans: [] });
  });

  test("narrowing the agents drops selected models of agents that are no longer listed", () => {
    const f: Filters = { agents: [], models: [{ agent: "claude", model: "opus-4-7" }, { agent: "codex", model: "gpt-5" }], accounts: [], plans: [] };
    expect(toggleAgent(f, "codex").filters).toEqual({ agents: ["codex"], models: [{ agent: "codex", model: "gpt-5" }], accounts: [], plans: [] });
  });

  test("toggleModel adds and removes the exact (agent, model) pair", () => {
    const one = toggleModel(NO_FILTERS, { agent: "x", model: "a:b" });
    expect(one.filters.models).toEqual([{ agent: "x", model: "a:b" }]);
    expect(toggleModel(one.filters, { agent: "x", model: "a" }).filters.models).toHaveLength(2);
    expect(toggleModel(one.filters, { agent: "x", model: "a:b" }).filters).toEqual(NO_FILTERS);
  });

  test("a model of an agent whose id has a colon cannot be selected or sent", () => {
    // The server splits <agent>:<model> on the first colon, so "x:a" + "b" would ask for "x" + "a:b".
    expect(canFilterModel({ agent: "x:a", model: "b" })).toBe(false);
    expect(canFilterModel({ agent: "x", model: "a:b" })).toBe(true);
    expect(toggleModel(NO_FILTERS, { agent: "x:a", model: "b" })).toEqual({ filters: NO_FILTERS, limited: false });
    expect(toQuery({ agents: ["x:a"], models: [{ agent: "x:a", model: "b" }, { agent: "x", model: "a:b" }], accounts: [], plans: [] })).toEqual([
      ["agent", "x:a"],
      ["model", "x:a:b"],
    ]);
  });

  test("toggleKey(accounts) adds and removes a key and leaves agents and models alone", () => {
    const start: Filters = { agents: ["claude"], models: [{ agent: "claude", model: "opus-4-7" }], accounts: [], plans: [] };
    const added = toggleKey(start, "accounts", "team:Devcats");
    expect(added).toEqual({ filters: { ...start, accounts: ["team:Devcats"], plans: [] }, limited: false });
    expect(start.accounts).toEqual([]);
    const two = toggleKey(added.filters, "accounts", "unknown").filters;
    expect(two.accounts).toEqual(["team:Devcats", "unknown"]);
    expect(toggleKey(two, "accounts", "team:Devcats").filters.accounts).toEqual(["unknown"]);
    // Agents and models keep the selected accounts.
    expect(toggleAgent(two, "codex").filters.accounts).toEqual(["team:Devcats", "unknown"]);
    expect(toggleModel(two, { agent: "claude", model: "x" }).filters.accounts).toEqual(["team:Devcats", "unknown"]);
  });

  test("adding past the limit stops and says so; removing still works", () => {
    let f: Filters = NO_FILTERS;
    for (let i = 0; i < LIMITS.agents; i++) f = toggleAgent(f, `a${i}`).filters;
    const over = toggleAgent(f, "one-too-many");
    expect(over.limited).toBe(true);
    expect(over.filters).toEqual(f);
    expect(toggleAgent(f, "a3").filters.agents).toHaveLength(LIMITS.agents - 1);

    let m: Filters = NO_FILTERS;
    for (let i = 0; i < LIMITS.models; i++) m = toggleModel(m, { agent: "a", model: `m${i}` }).filters;
    const overM = toggleModel(m, { agent: "a", model: "extra" });
    expect(overM.limited).toBe(true);
    expect(overM.filters.models).toHaveLength(LIMITS.models);

    let a: Filters = NO_FILTERS;
    for (let i = 0; i < LIMITS.accounts; i++) a = toggleKey(a, "accounts", `team:o${i}`).filters;
    const overA = toggleKey(a, "accounts", "personal");
    expect(overA.limited).toBe(true);
    expect(overA.filters).toEqual(a);
    expect(toggleKey(a, "accounts", "team:o3").filters.accounts).toHaveLength(LIMITS.accounts - 1);
  });
});

describe("totals from available", () => {
  test("per agent and overall, without a request", () => {
    expect([...availableAgentTotals(available)]).toEqual([["claude", 70], ["codex", 30], ["x", 1]]);
    expect(availableTotal(available)).toBe(101);
    expect(availableTotal({ agents: [], models: [], accounts: [], plans: [] })).toBe(0);
  });

  test("ids like __proto__ are plain keys and broken numbers count as zero", () => {
    const odd = {
      agents: ["__proto__", "constructor"],
      models: [
        { agent: "__proto__", model: "a", tokens: 2 },
        { agent: "constructor", model: "b", tokens: Number.NaN },
        { agent: "__proto__", model: "c", tokens: "5" as unknown as number },
      ],
      accounts: [],
      plans: [],
    };
    expect([...availableAgentTotals(odd)]).toEqual([["__proto__", 2], ["constructor", 0]]);
    expect(availableTotal(odd)).toBe(2);
  });

  test("never Infinity", () => {
    const big = { agents: ["a"], models: [{ agent: "a", model: "m", tokens: Number.MAX_VALUE }, { agent: "a", model: "n", tokens: Number.MAX_VALUE }], accounts: [], plans: [] };
    expect(availableTotal(big)).toBe(Number.MAX_VALUE);
    expect(availableAgentTotals(big).get("a")).toBe(Number.MAX_VALUE);
  });
});

describe("cleanAvailable accounts", () => {
  test("keeps valid account entries and drops malformed ones", () => {
    const raw = {
      agents: ["claude"],
      models: [],
      accounts: [
        { key: "team:D", tokens: 100 },
        { key: "team:__proto__", tokens: 3 },
        { key: "unknown", tokens: 0 },
        { key: "boss", tokens: 5 },
        { key: "personal", tokens: -1 },
        { key: "api", tokens: Number.NaN },
        { key: "api", tokens: "5" },
        { key: 7, tokens: 5 },
        { key: "team:a\nb", tokens: 5 },
        null,
        "personal",
      ],
    };
    expect(cleanAvailable(raw).accounts).toEqual([
      { key: "team:D", tokens: 100 },
      { key: "team:__proto__", tokens: 3 },
      { key: "unknown", tokens: 0 },
    ]);
  });

  test("a missing or non-array accounts list is empty", () => {
    expect(cleanAvailable({ agents: [], models: [] }).accounts).toEqual([]);
    expect(cleanAvailable({ agents: [], models: [], accounts: { key: "api", tokens: 1 } }).accounts).toEqual([]);
    expect(cleanAvailable(null).accounts).toEqual([]);
  });
});

describe("withSelection", () => {
  test("a selected account the period lacks is added at zero tokens, once, after the period's accounts", () => {
    const f: Filters = { agents: [], models: [], accounts: ["api", "personal", "api", "enterprise:Acme"], plans: [] };
    expect(withSelection(available, f).accounts).toEqual([
      { key: "team:Devcats", tokens: 80 },
      { key: "personal", tokens: 20 },
      { key: "unknown", tokens: 1 },
      { key: "api", tokens: 0 },
      { key: "enterprise:Acme", tokens: 0 },
    ]);
    expect(withSelection(available, NO_FILTERS).accounts).toEqual(available.accounts);
  });

  test("keys that look like object keys are compared as plain strings", () => {
    const odd: Stats["available"] = { agents: [], models: [], accounts: [{ key: "team:__proto__", tokens: 3 }], plans: [] };
    expect(withSelection(odd, { agents: [], models: [], accounts: ["team:__proto__", "team:constructor"], plans: [] }).accounts).toEqual([
      { key: "team:__proto__", tokens: 3 },
      { key: "team:constructor", tokens: 0 },
    ]);
  });
});

describe("plans filter", () => {
  test("query has plan= after accounts, capped at LIMITS.plans", () => {
    expect(toQuery({ agents: ["claude"], models: [], accounts: ["personal"], plans: ["claude:pro", "none"] })).toEqual([
      ["agent", "claude"],
      ["account", "personal"],
      ["plan", "claude:pro"],
      ["plan", "none"],
    ]);
    const many = toQuery({ ...NO_FILTERS, plans: Array.from({ length: 70 }, (_, i) => `claude:p${i}`) });
    expect(many.filter(([k]) => k === "plan")).toHaveLength(LIMITS.plans);
  });

  test("toggleKey(plans) adds, removes, respects the limit; isActive and equalFilters see plans", () => {
    const added = toggleKey(NO_FILTERS, "plans", "claude:pro");
    expect(added).toEqual({ filters: { ...NO_FILTERS, plans: ["claude:pro"] }, limited: false });
    expect(toggleKey(added.filters, "plans", "claude:pro").filters.plans).toEqual([]);
    let f: Filters = NO_FILTERS;
    for (let i = 0; i < LIMITS.plans; i++) f = toggleKey(f, "plans", `claude:p${i}`).filters;
    expect(toggleKey(f, "plans", "none")).toEqual({ filters: f, limited: true });
    expect(isActive(added.filters)).toBe(true);
    expect(equalFilters(added.filters, NO_FILTERS)).toBe(false);
    expect(equalFilters(added.filters, toggleKey(NO_FILTERS, "plans", "claude:pro").filters)).toBe(true);
  });

  test("prune, cleanAvailable and withSelection carry plans", () => {
    const available: Stats["available"] = { agents: [], models: [], accounts: [], plans: [{ key: "claude:pro", tokens: 5 }] };
    expect(prune({ ...NO_FILTERS, plans: ["none", "claude:pro"] }, available).plans).toEqual(["claude:pro"]);
    const raw = {
      agents: [], models: [], accounts: [],
      plans: [{ key: "claude:pro", tokens: 5 }, { key: "none", tokens: 1 }, { key: "claude:gold", tokens: 1 }, { key: "codex:plus", tokens: "x" }, { key: "codex:plus", tokens: -1 }, null, 3],
    };
    expect(cleanAvailable(raw).plans).toEqual([{ key: "claude:pro", tokens: 5 }, { key: "none", tokens: 1 }]);
    expect(cleanAvailable({ agents: [], models: [] }).plans).toEqual([]);
    expect(withSelection(available, { ...NO_FILTERS, plans: ["none", "claude:pro", "none"] }).plans).toEqual([
      { key: "claude:pro", tokens: 5 },
      { key: "none", tokens: 0 },
    ]);
  });
});
