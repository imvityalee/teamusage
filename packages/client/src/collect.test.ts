import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_AGENT_CHARS, MAX_COST_USD, MAX_MODEL_CHARS, MAX_TOKENS, validateBatch } from "@teamusage/shared";
import { CollectError, runCcusage, toRecords } from "./collect.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ccusage-daily.json", import.meta.url), "utf8"));

const day = (breakdowns: unknown[], extra: object = {}) => ({
  daily: [{ period: "2026-02-01", agents: [{ agent: "claude", modelBreakdowns: breakdowns, ...extra }] }],
});
const bd = (over: object = {}) => ({
  modelName: "m", inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, cost: 0.5, ...over,
});

describe("toRecords", () => {
  const records = toRecords(fixture);

  it("flattens the fixture into one record per day, agent and model", () => {
    expect(records).toHaveLength(4);
    expect(records.map((r) => [r.date, r.agent, r.model])).toEqual([
      ["2026-01-02", "claude", "model-a"],
      ["2026-01-02", "claude", "model-b"],
      ["2026-01-02", "codex", "model-c"],
      ["2026-01-03", "claude", "model-a"],
    ]);
  });

  it("computes total as the sum of the four token fields, ignoring cacheCreation1hTokens", () => {
    for (const r of records) expect(r.total).toBe(r.input + r.output + r.cacheCreate + r.cacheRead);
    expect(records[0]).toMatchObject({ input: 400, output: 80, cacheCreate: 20, cacheRead: 30, total: 530 });
  });

  it("rounds cost to 6 decimals", () => {
    expect(records[0]?.costUsd).toBe(0.021235);
  });

  it("marks unpriced models", () => {
    expect(records[2]).toMatchObject({ unpriced: true, costUsd: 0 });
    expect(records[0]?.unpriced).toBe(false);
  });

  it("produces records that pass validateBatch", () => {
    expect(validateBatch({ records }).ok).toBe(true);
  });

  it("returns [] for no days", () => {
    expect(toRecords({ daily: [] })).toEqual([]);
  });

  it("throws CollectError on unexpected shapes", () => {
    expect(() => toRecords({})).toThrow(CollectError);
    expect(() => toRecords(null)).toThrow(CollectError);
    expect(() => toRecords({ daily: [{ period: "2026-01-02" }] })).toThrow(CollectError);
    expect(() => toRecords({ daily: [{ period: "bad", agents: [] }] })).toThrow(CollectError);
  });

  it("merges breakdowns sharing a model name within a day and agent", () => {
    const out = toRecords(day([bd({ cost: 0.25 }), bd({ cost: 0.5, missingPricing: true })]));
    expect(out).toEqual([
      { date: "2026-02-01", agent: "claude", model: "m", input: 2, output: 4, cacheCreate: 6, cacheRead: 8, total: 20, costUsd: 0.75, unpriced: true },
    ]);
  });

  it("skips all-zero breakdowns", () => {
    const zero = bd({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    expect(toRecords(day([zero]))).toEqual([]);
  });

  it.each([["missing", undefined], ["negative", -1], ["fractional", 1.5], ["string", "3"]])(
    "throws on a %s token field",
    (_n, value) => {
      const b: Record<string, unknown> = bd();
      if (value === undefined) delete b.outputTokens;
      else b.outputTokens = value;
      expect(() => toRecords(day([b]))).toThrow(CollectError);
    },
  );

  it("throws on an invalid cost", () => {
    expect(() => toRecords(day([bd({ cost: -1 })]))).toThrow(CollectError);
    expect(() => toRecords(day([bd({ cost: "x" })]))).toThrow(CollectError);
  });

  it("never passes unknown properties through", () => {
    const secret = "/Users/someone/private";
    const out = toRecords(day([bd({ projectPath: secret, extra: { a: secret } })], { path: secret }));
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(Object.keys(out[0]!).sort()).toEqual(
      ["agent", "cacheCreate", "cacheRead", "costUsd", "date", "input", "model", "output", "total", "unpriced"],
    );
  });
});

describe("toRecords upload bounds", () => {
  const LIMIT = "unexpected ccusage output: token counts or cost above the upload limits";
  const agents = (...entries: { agent: string; breakdowns: unknown[] }[]) => ({
    daily: [{ period: "2026-02-01", agents: entries.map((e) => ({ agent: e.agent, modelBreakdowns: e.breakdowns })) }],
  });

  it("truncates a long model name to MAX_MODEL_CHARS and the result passes validateBatch", () => {
    const out = toRecords(day([bd({ modelName: "m".repeat(5000) })]));
    expect(out[0]?.model).toBe("m".repeat(MAX_MODEL_CHARS));
    expect(validateBatch({ records: out }).ok).toBe(true);
  });

  it("truncates a long agent name to MAX_AGENT_CHARS and the result passes validateBatch", () => {
    const out = toRecords(agents({ agent: "a".repeat(500), breakdowns: [bd()] }));
    expect(out[0]?.agent).toBe("a".repeat(MAX_AGENT_CHARS));
    expect(validateBatch({ records: out }).ok).toBe(true);
  });

  it("removes control characters from agent and model names", () => {
    const out = toRecords(agents({ agent: "cl\u0000au\u001bde\u007f", breakdowns: [bd({ modelName: "mo\ndel\t" })] }));
    expect(out[0]).toMatchObject({ agent: "claude", model: "model" });
    expect(validateBatch({ records: out }).ok).toBe(true);
  });

  it("does not split a surrogate pair when truncating", () => {
    const out = toRecords(day([bd({ modelName: "m".repeat(MAX_MODEL_CHARS - 1) + "\u{1F600}" })]));
    expect(out[0]?.model).toBe("m".repeat(MAX_MODEL_CHARS - 1));
    expect(validateBatch({ records: out }).ok).toBe(true);
  });

  it("merges two models that become the same name after truncation, summing tokens and cost", () => {
    const base = "m".repeat(MAX_MODEL_CHARS);
    const out = toRecords(day([bd({ modelName: `${base}-a`, cost: 0.25 }), bd({ modelName: `${base}-b`, cost: 0.5 })]));
    expect(out).toEqual([
      { date: "2026-02-01", agent: "claude", model: base, input: 2, output: 4, cacheCreate: 6, cacheRead: 8, total: 20, costUsd: 0.75, unpriced: false },
    ]);
  });

  it("merges two agents that become the same name after truncation", () => {
    const base = "a".repeat(MAX_AGENT_CHARS);
    const out = toRecords(agents({ agent: `${base}-x`, breakdowns: [bd()] }, { agent: `${base}-y`, breakdowns: [bd()] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ agent: base, model: "m", total: 20, costUsd: 1 });
  });

  it("throws on a name that is empty once control characters are removed", () => {
    expect(() => toRecords(day([bd({ modelName: "\u0000\n" })]))).toThrow(CollectError);
  });

  it.each(["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"])(
    "accepts %s at MAX_TOKENS and throws a fixed CollectError above it",
    (field) => {
      expect(toRecords(day([bd({ [field]: MAX_TOKENS })]))).toHaveLength(1);
      const e = (() => {
        try {
          toRecords(day([bd({ [field]: MAX_TOKENS + 1 })]));
        } catch (x) {
          return x;
        }
      })();
      expect(e).toBeInstanceOf(CollectError);
      expect((e as Error).message).toBe(LIMIT);
    },
  );

  it("accepts cost at MAX_COST_USD and throws a fixed CollectError above it", () => {
    expect(toRecords(day([bd({ cost: MAX_COST_USD })]))[0]?.costUsd).toBe(MAX_COST_USD);
    expect(() => toRecords(day([bd({ cost: MAX_COST_USD + 1 })]))).toThrow(LIMIT);
  });

  it("throws when merging pushes a token count or the cost over its cap", () => {
    expect(() => toRecords(day([bd({ inputTokens: MAX_TOKENS }), bd({ inputTokens: 1 })]))).toThrow(LIMIT);
    expect(() => toRecords(day([bd({ cost: MAX_COST_USD }), bd({ cost: 1 })]))).toThrow(LIMIT);
  });
});

describe("runCcusage", () => {
  const stub = (code: string) => ({ command: [process.execPath, "-e", code, "--"], timeoutMs: 5000 });

  it("resolves to the parsed JSON and passes the expected args", async () => {
    const res = await runCcusage("2026-11-16", stub("console.log(JSON.stringify({args: process.argv.slice(1)}))"));
    expect(res).toEqual({ args: ["daily", "--by-agent", "--json", "--since", "20261116"] });
  });

  it("omits --since when not given", async () => {
    const res = await runCcusage(undefined, stub("console.log(JSON.stringify(process.argv.slice(1)))"));
    expect(res).toEqual(["daily", "--by-agent", "--json"]);
  });

  it("rejects on a non-zero exit, without leaking child output", async () => {
    const err = await runCcusage(undefined, stub("console.error('/secret/path'); console.log('/secret/out'); process.exit(1)")).then(() => new Error("resolved"), (e: Error) => e);
    expect(err).toBeInstanceOf(CollectError);
    expect(err.message).not.toContain("secret");
  });

  it("rejects on empty stdout", async () => {
    await expect(runCcusage(undefined, stub("process.exit(0)"))).rejects.toThrow(CollectError);
  });

  it("rejects on non-JSON stdout, without leaking it", async () => {
    const err = await runCcusage(undefined, stub("console.log('garbage /secret')")).then(() => new Error("resolved"), (e: Error) => e);
    expect(err).toBeInstanceOf(CollectError);
    expect(err.message).not.toContain("secret");
  });

  it("rejects on timeout", async () => {
    const err = await runCcusage(undefined, { ...stub("setInterval(() => {}, 1000)"), timeoutMs: 200 }).then(() => new Error("resolved"), (e: Error) => e);
    expect(err).toBeInstanceOf(CollectError);
    expect(err.message).toBe("ccusage timed out");
  });

  it("rejects when the command does not exist", async () => {
    await expect(runCcusage(undefined, { command: ["/nonexistent/teamusage-cmd"] })).rejects.toThrow(CollectError);
  });

  it("rejects when output exceeds maxBytes", async () => {
    const err = await runCcusage(undefined, { ...stub("process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000)"), maxBytes: 1000 }).then(() => new Error("resolved"), (e: Error) => e);
    expect(err).toBeInstanceOf(CollectError);
    expect(err.message).toBe("ccusage output too large");
  });

  it.each(["bad", "2026-1-1"])("rejects (not throws) on invalid since %s", async (since) => {
    const p = runCcusage(since);
    await expect(p).rejects.toThrow(CollectError);
  });
});
