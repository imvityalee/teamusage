import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import {
  agentTotals,
  availableTotal,
  canFilterModel,
  cleanAvailable,
  equalFilters,
  isActive,
  MAX_ACCOUNTS,
  MAX_AGENTS,
  MAX_MODELS,
  NO_FILTERS,
  prune,
  summary,
  toggleAccount,
  toggleAgent,
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
    expect(toQuery({ agents: [], models: [], accounts: ["team:a:b", "enterprise:<b>x</b>", "team:"] })).toEqual([
      ["account", "team:a:b"],
      ["account", "enterprise:<b>x</b>"],
      ["account", "team:"],
    ]);
  });

  test("a model name containing a colon is kept whole after the first colon", () => {
    expect(toQuery({ agents: [], models: [{ agent: "x", model: "a:b" }], accounts: [] })).toEqual([["model", "x:a:b"]]);
  });

  test("no filters, no parameters", () => {
    expect(toQuery(NO_FILTERS)).toEqual([]);
  });

  test("never more than the server's limits, even from a malformed state", () => {
    const f: Filters = {
      agents: Array.from({ length: 30 }, (_, i) => `a${i}`),
      models: Array.from({ length: 70 }, (_, i) => ({ agent: "a", model: `m${i}` })),
      accounts: Array.from({ length: 70 }, (_, i) => `team:o${i}`),
    };
    const q = toQuery(f);
    expect(q.filter(([k]) => k === "agent")).toHaveLength(MAX_AGENTS);
    expect(q.filter(([k]) => k === "model")).toHaveLength(MAX_MODELS);
    expect(q.filter(([k]) => k === "account")).toHaveLength(MAX_ACCOUNTS);
    expect([MAX_AGENTS, MAX_MODELS, MAX_ACCOUNTS]).toEqual([20, 50, 50]);
  });
});

describe("prune", () => {
  test("drops selections that are no longer available and keeps the rest in order", () => {
    const f: Filters = {
      agents: ["gemini", "codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }, { agent: "claude", model: "gone" }, { agent: "codex", model: "opus-4-7" }],
      accounts: ["api", "team:Devcats", "personal", "team:"],
    };
    expect(prune(f, available)).toEqual({
      agents: ["codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }],
      accounts: ["team:Devcats", "personal"],
    });
  });

  test("an empty available clears everything; nothing selected stays nothing", () => {
    expect(prune({ agents: ["claude"], models: [{ agent: "claude", model: "opus-4-7" }], accounts: ["personal"] }, { agents: [], models: [], accounts: [], plans: [] })).toEqual(NO_FILTERS);
    expect(prune(NO_FILTERS, available)).toEqual(NO_FILTERS);
  });

  test("ids that look like object keys are compared as plain strings", () => {
    const odd: Stats["available"] = { agents: ["__proto__"], models: [{ agent: "__proto__", model: "constructor", tokens: 1 }], accounts: [], plans: [] };
    const f: Filters = { agents: ["__proto__", "constructor"], models: [{ agent: "__proto__", model: "constructor" }, { agent: "toString", model: "x" }], accounts: [] };
    expect(prune(f, odd)).toEqual({ agents: ["__proto__"], models: [{ agent: "__proto__", model: "constructor" }], accounts: [] });
  });
});

describe("isActive, summary, equalFilters", () => {
  test("isActive is true when either list has a selection", () => {
    expect(isActive(NO_FILTERS)).toBe(false);
    expect(isActive({ agents: ["claude"], models: [], accounts: [] })).toBe(true);
    expect(isActive({ agents: [], models: [{ agent: "claude", model: "m" }], accounts: [] })).toBe(true);
    expect(isActive({ agents: [], models: [], accounts: ["unknown"] })).toBe(true);
  });

  test("summary is all only when nothing is selected, so the button never says All while chips show", () => {
    expect(summary(0, 5)).toBe("all");
    expect(summary(2, 5)).toBe("some");
    expect(summary(5, 5)).toBe("some");
    expect(summary(0, 0)).toBe("all");
    expect(summary(3, 2)).toBe("some");
  });

  test("equalFilters compares contents, not identity", () => {
    expect(equalFilters({ agents: ["a"], models: [], accounts: [] }, { agents: ["a"], models: [], accounts: [] })).toBe(true);
    expect(equalFilters({ agents: ["a"], models: [], accounts: [] }, { agents: ["b"], models: [], accounts: [] })).toBe(false);
    expect(equalFilters({ agents: [], models: [{ agent: "a", model: "b:c" }], accounts: [] }, { agents: [], models: [{ agent: "a:b", model: "c" }], accounts: [] })).toBe(false);
    expect(equalFilters({ agents: [], models: [], accounts: ["api"] }, { agents: [], models: [], accounts: ["api"] })).toBe(true);
    expect(equalFilters({ agents: [], models: [], accounts: ["api"] }, { agents: [], models: [], accounts: ["personal"] })).toBe(false);
    expect(equalFilters({ agents: [], models: [], accounts: ["api"] }, { agents: [], models: [], accounts: [] })).toBe(false);
  });
});

describe("toggling", () => {
  test("toggleAgent adds and removes without touching the input", () => {
    const start: Filters = { agents: ["claude"], models: [], accounts: [] };
    const added = toggleAgent(start, "codex");
    expect(added).toEqual({ filters: { agents: ["claude", "codex"], models: [], accounts: [] }, limited: false });
    expect(start).toEqual({ agents: ["claude"], models: [], accounts: [] });
    expect(toggleAgent(added.filters, "claude").filters).toEqual({ agents: ["codex"], models: [], accounts: [] });
  });

  test("narrowing the agents drops selected models of agents that are no longer listed", () => {
    const f: Filters = { agents: [], models: [{ agent: "claude", model: "opus-4-7" }, { agent: "codex", model: "gpt-5" }], accounts: [] };
    expect(toggleAgent(f, "codex").filters).toEqual({ agents: ["codex"], models: [{ agent: "codex", model: "gpt-5" }], accounts: [] });
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
    expect(toQuery({ agents: ["x:a"], models: [{ agent: "x:a", model: "b" }, { agent: "x", model: "a:b" }], accounts: [] })).toEqual([
      ["agent", "x:a"],
      ["model", "x:a:b"],
    ]);
  });

  test("toggleAccount adds and removes a key and leaves agents and models alone", () => {
    const start: Filters = { agents: ["claude"], models: [{ agent: "claude", model: "opus-4-7" }], accounts: [] };
    const added = toggleAccount(start, "team:Devcats");
    expect(added).toEqual({ filters: { ...start, accounts: ["team:Devcats"] }, limited: false });
    expect(start.accounts).toEqual([]);
    const two = toggleAccount(added.filters, "unknown").filters;
    expect(two.accounts).toEqual(["team:Devcats", "unknown"]);
    expect(toggleAccount(two, "team:Devcats").filters.accounts).toEqual(["unknown"]);
    // Agents and models keep the selected accounts.
    expect(toggleAgent(two, "codex").filters.accounts).toEqual(["team:Devcats", "unknown"]);
    expect(toggleModel(two, { agent: "claude", model: "x" }).filters.accounts).toEqual(["team:Devcats", "unknown"]);
  });

  test("adding past the limit stops and says so; removing still works", () => {
    let f: Filters = NO_FILTERS;
    for (let i = 0; i < MAX_AGENTS; i++) f = toggleAgent(f, `a${i}`).filters;
    const over = toggleAgent(f, "one-too-many");
    expect(over.limited).toBe(true);
    expect(over.filters).toEqual(f);
    expect(toggleAgent(f, "a3").filters.agents).toHaveLength(MAX_AGENTS - 1);

    let m: Filters = NO_FILTERS;
    for (let i = 0; i < MAX_MODELS; i++) m = toggleModel(m, { agent: "a", model: `m${i}` }).filters;
    const overM = toggleModel(m, { agent: "a", model: "extra" });
    expect(overM.limited).toBe(true);
    expect(overM.filters.models).toHaveLength(MAX_MODELS);

    let a: Filters = NO_FILTERS;
    for (let i = 0; i < MAX_ACCOUNTS; i++) a = toggleAccount(a, `team:o${i}`).filters;
    const overA = toggleAccount(a, "personal");
    expect(overA.limited).toBe(true);
    expect(overA.filters).toEqual(a);
    expect(toggleAccount(a, "team:o3").filters.accounts).toHaveLength(MAX_ACCOUNTS - 1);
  });
});

describe("totals from available", () => {
  test("per agent and overall, without a request", () => {
    expect([...agentTotals(available)]).toEqual([["claude", 70], ["codex", 30], ["x", 1]]);
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
    expect([...agentTotals(odd)]).toEqual([["__proto__", 2], ["constructor", 0]]);
    expect(availableTotal(odd)).toBe(2);
  });

  test("never Infinity", () => {
    const big = { agents: ["a"], models: [{ agent: "a", model: "m", tokens: Number.MAX_VALUE }, { agent: "a", model: "n", tokens: Number.MAX_VALUE }], accounts: [], plans: [] };
    expect(availableTotal(big)).toBe(Number.MAX_VALUE);
    expect(agentTotals(big).get("a")).toBe(Number.MAX_VALUE);
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
    const f: Filters = { agents: [], models: [], accounts: ["api", "personal", "api", "enterprise:Acme"] };
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
    expect(withSelection(odd, { agents: [], models: [], accounts: ["team:__proto__", "team:constructor"] }).accounts).toEqual([
      { key: "team:__proto__", tokens: 3 },
      { key: "team:constructor", tokens: 0 },
    ]);
  });
});
