import type { Stats } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import {
  agentTotals,
  availableTotal,
  canFilterModel,
  equalFilters,
  isActive,
  MAX_AGENTS,
  MAX_MODELS,
  NO_FILTERS,
  prune,
  summary,
  toggleAgent,
  toggleModel,
  toQuery,
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
};

describe("toQuery", () => {
  test("agents first in selection order, then models as <agent>:<model>", () => {
    const f: Filters = {
      agents: ["codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }, { agent: "codex", model: "gpt-5" }],
    };
    expect(toQuery(f)).toEqual([
      ["agent", "codex"],
      ["agent", "claude"],
      ["model", "claude:opus-4-7"],
      ["model", "codex:gpt-5"],
    ]);
    expect(new URLSearchParams(toQuery(f)).toString()).toBe(
      "agent=codex&agent=claude&model=claude%3Aopus-4-7&model=codex%3Agpt-5",
    );
  });

  test("a model name containing a colon is kept whole after the first colon", () => {
    expect(toQuery({ agents: [], models: [{ agent: "x", model: "a:b" }] })).toEqual([["model", "x:a:b"]]);
  });

  test("no filters, no parameters", () => {
    expect(toQuery(NO_FILTERS)).toEqual([]);
  });

  test("never more than the server's limits, even from a malformed state", () => {
    const f: Filters = {
      agents: Array.from({ length: 30 }, (_, i) => `a${i}`),
      models: Array.from({ length: 70 }, (_, i) => ({ agent: "a", model: `m${i}` })),
    };
    const q = toQuery(f);
    expect(q.filter(([k]) => k === "agent")).toHaveLength(MAX_AGENTS);
    expect(q.filter(([k]) => k === "model")).toHaveLength(MAX_MODELS);
    expect([MAX_AGENTS, MAX_MODELS]).toEqual([20, 50]);
  });
});

describe("prune", () => {
  test("drops selections that are no longer available and keeps the rest in order", () => {
    const f: Filters = {
      agents: ["gemini", "codex", "claude"],
      models: [{ agent: "claude", model: "opus-4-7" }, { agent: "claude", model: "gone" }, { agent: "codex", model: "opus-4-7" }],
    };
    expect(prune(f, available)).toEqual({ agents: ["codex", "claude"], models: [{ agent: "claude", model: "opus-4-7" }] });
  });

  test("an empty available clears everything; nothing selected stays nothing", () => {
    expect(prune({ agents: ["claude"], models: [{ agent: "claude", model: "opus-4-7" }] }, { agents: [], models: [] })).toEqual(NO_FILTERS);
    expect(prune(NO_FILTERS, available)).toEqual(NO_FILTERS);
  });

  test("ids that look like object keys are compared as plain strings", () => {
    const odd: Stats["available"] = { agents: ["__proto__"], models: [{ agent: "__proto__", model: "constructor", tokens: 1 }] };
    const f: Filters = { agents: ["__proto__", "constructor"], models: [{ agent: "__proto__", model: "constructor" }, { agent: "toString", model: "x" }] };
    expect(prune(f, odd)).toEqual({ agents: ["__proto__"], models: [{ agent: "__proto__", model: "constructor" }] });
  });
});

describe("isActive, summary, equalFilters", () => {
  test("isActive is true when either list has a selection", () => {
    expect(isActive(NO_FILTERS)).toBe(false);
    expect(isActive({ agents: ["claude"], models: [] })).toBe(true);
    expect(isActive({ agents: [], models: [{ agent: "claude", model: "m" }] })).toBe(true);
  });

  test("summary is all only when nothing is selected, so the button never says All while chips show", () => {
    expect(summary(0, 5)).toBe("all");
    expect(summary(2, 5)).toBe("some");
    expect(summary(5, 5)).toBe("some");
    expect(summary(0, 0)).toBe("all");
    expect(summary(3, 2)).toBe("some");
  });

  test("equalFilters compares contents, not identity", () => {
    expect(equalFilters({ agents: ["a"], models: [] }, { agents: ["a"], models: [] })).toBe(true);
    expect(equalFilters({ agents: ["a"], models: [] }, { agents: ["b"], models: [] })).toBe(false);
    expect(equalFilters({ agents: [], models: [{ agent: "a", model: "b:c" }] }, { agents: [], models: [{ agent: "a:b", model: "c" }] })).toBe(false);
  });
});

describe("toggling", () => {
  test("toggleAgent adds and removes without touching the input", () => {
    const start: Filters = { agents: ["claude"], models: [] };
    const added = toggleAgent(start, "codex");
    expect(added).toEqual({ filters: { agents: ["claude", "codex"], models: [] }, limited: false });
    expect(start).toEqual({ agents: ["claude"], models: [] });
    expect(toggleAgent(added.filters, "claude").filters).toEqual({ agents: ["codex"], models: [] });
  });

  test("narrowing the agents drops selected models of agents that are no longer listed", () => {
    const f: Filters = { agents: [], models: [{ agent: "claude", model: "opus-4-7" }, { agent: "codex", model: "gpt-5" }] };
    expect(toggleAgent(f, "codex").filters).toEqual({ agents: ["codex"], models: [{ agent: "codex", model: "gpt-5" }] });
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
    expect(toQuery({ agents: ["x:a"], models: [{ agent: "x:a", model: "b" }, { agent: "x", model: "a:b" }] })).toEqual([
      ["agent", "x:a"],
      ["model", "x:a:b"],
    ]);
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
  });
});

describe("totals from available", () => {
  test("per agent and overall, without a request", () => {
    expect([...agentTotals(available)]).toEqual([["claude", 70], ["codex", 30], ["x", 1]]);
    expect(availableTotal(available)).toBe(101);
    expect(availableTotal({ agents: [], models: [] })).toBe(0);
  });

  test("ids like __proto__ are plain keys and broken numbers count as zero", () => {
    const odd = {
      agents: ["__proto__", "constructor"],
      models: [
        { agent: "__proto__", model: "a", tokens: 2 },
        { agent: "constructor", model: "b", tokens: Number.NaN },
        { agent: "__proto__", model: "c", tokens: "5" as unknown as number },
      ],
    };
    expect([...agentTotals(odd)]).toEqual([["__proto__", 2], ["constructor", 0]]);
    expect(availableTotal(odd)).toBe(2);
  });

  test("never Infinity", () => {
    const big = { agents: ["a"], models: [{ agent: "a", model: "m", tokens: Number.MAX_VALUE }, { agent: "a", model: "n", tokens: Number.MAX_VALUE }] };
    expect(availableTotal(big)).toBe(Number.MAX_VALUE);
    expect(agentTotals(big).get("a")).toBe(Number.MAX_VALUE);
  });
});
