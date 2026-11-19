import { describe, expect, test } from "vitest";
import { accountKey, parseAccountKey, parsePlanKey, planKey, planShortName, plansFor, validateAccount } from "./account.js";

describe("accountKey", () => {
  test("keys", () => {
    expect(accountKey({ kind: "team", org: "Devcats" })).toBe("team:Devcats");
    expect(accountKey({ kind: "team" })).toBe("team:");
    expect(accountKey({ kind: "personal" })).toBe("personal");
    expect(accountKey({ kind: "api" })).toBe("api");
    expect(accountKey(null)).toBe("unknown");
    expect(accountKey(undefined)).toBe("unknown");
  });
  test("agent aware", () => {
    expect(accountKey(null, "codex")).toBe("other");
    expect(accountKey(undefined, "gemini")).toBe("other");
    expect(accountKey({ kind: "team" }, "codex")).toBe("chatgpt:team");
    expect(accountKey({ kind: "personal" }, "codex")).toBe("chatgpt:personal");
    expect(accountKey({ kind: "team", org: "O" }, "claude")).toBe("team:O");
  });
});
describe("parseAccountKey", () => {
  test("valid", () => {
    expect(parseAccountKey("team:a:b")).toEqual({ kind: "team", org: "a:b", agent: "claude" });
    expect(parseAccountKey("enterprise:")).toEqual({ kind: "enterprise", org: "", agent: "claude" });
    expect(parseAccountKey("unknown")).toEqual({ kind: "unknown", org: null, agent: "claude" });
    expect(parseAccountKey("personal")).toEqual({ kind: "personal", org: null, agent: "claude" });
    expect(parseAccountKey("api")).toEqual({ kind: "api", org: null, agent: "claude" });
    expect(parseAccountKey("other")).toEqual({ kind: "other", org: null, agent: null });
    expect(parseAccountKey("chatgpt:personal")).toEqual({ kind: "personal", org: null, agent: "codex" });
    expect(parseAccountKey("chatgpt:api")).toEqual({ kind: "api", org: null, agent: "codex" });
  });
  test.each(["chatgpt:boss", "chatgpt:", "chatgpt", "chatgpt:team:x", "other:x"])("malformed %j", (k) =>
    expect(parseAccountKey(k)).toBeUndefined());
  test.each(["personal:x", "boss", "team", "team:" + "x".repeat(101), "team:a\u0007"])("malformed %j", (k) =>
    expect(parseAccountKey(k)).toBeUndefined());
});
describe("validateAccount", () => {
  test.each([
    [{ kind: "personal", org: "x" }],
    [{ kind: "api", org: "x" }],
    [{ kind: "team", org: "x".repeat(101) }],
    [{ kind: "team", org: "a\nb" }],
    [{ kind: "team", org: 5 }],
    [{ kind: "vip" }],
    [null],
    [[]],
  ])("rejects %j", (a) => expect(typeof validateAccount(a, "claude")).toBe("string"));
  test("accepts and drops extra keys", () => {
    expect(validateAccount({ kind: "team", org: "Devcats", extra: 1 }, "claude")).toEqual({ kind: "team", org: "Devcats" });
    expect(validateAccount({ kind: "personal" }, "claude")).toEqual({ kind: "personal" });
    expect(validateAccount({ kind: "team", org: "x".repeat(100) }, "claude")).toEqual({ kind: "team", org: "x".repeat(100) });
  });
});

describe("validateAccount with agent and plan", () => {
  test("org is never allowed on codex", () => {
    expect(validateAccount({ kind: "team", org: "X" }, "codex")).toBe("org is not allowed for this account kind");
  });
  test("unlabelled agents", () => {
    expect(validateAccount({ kind: "personal" }, "gemini")).toBe("account on an unlabelled agent's record");
  });
  test("plans", () => {
    expect(validateAccount({ kind: "personal", plan: "plus" }, "claude")).toBe("invalid account plan");
    expect(validateAccount({ kind: "personal", plan: "plus" }, "codex")).toEqual({ kind: "personal", plan: "plus" });
    expect(validateAccount({ kind: "personal", plan: 5 }, "codex")).toBe("invalid account plan");
    const l = { kind: "team", org: "O!Bank Team", plan: "team_premium" };
    expect(validateAccount(l, "claude")).toEqual(l);
  });
});
describe("plans", () => {
  test("plansFor", () => {
    expect(plansFor("claude")).toContain("max_5x");
    expect(plansFor("codex")).toContain("plus");
    expect(plansFor("gemini")).toEqual([]);
  });
  test("planKey", () => {
    expect(planKey("codex", "plus")).toBe("codex:plus");
    expect(planKey("claude", null)).toBe("none");
    expect(planKey("claude", undefined)).toBe("none");
  });
  test("parsePlanKey", () => {
    expect(parsePlanKey("none")).toEqual({ agent: null, plan: null });
    expect(parsePlanKey("claude:max_5x")).toEqual({ agent: "claude", plan: "max_5x" });
    expect(parsePlanKey("codex:plus")).toEqual({ agent: "codex", plan: "plus" });
    expect(parsePlanKey("claude:plus")).toBeUndefined();
    expect(parsePlanKey("x:pro")).toBeUndefined();
    expect(parsePlanKey("claude:")).toBeUndefined();
  });
  test("planShortName", () => {
    expect(["free", "pro", "max_5x", "max_20x", "team_standard", "team_premium", "plus", "business", "edu"].map((p) => planShortName(p as never))).toEqual([
      "Free", "Pro", "Max 5x", "Max 20x", "Standard", "Premium", "Plus", "Business", "Edu",
    ]);
    expect(planShortName("enterprise")).toBe("");
    expect(planShortName(null)).toBe("");
    expect(planShortName(undefined)).toBe("");
  });
});
