import { describe, expect, test } from "vitest";
import { codexAuthPath, readCodexAccount } from "./codex-account.js";

const jwt = (payload: unknown, raw = false) =>
  `h.${Buffer.from(raw ? (payload as string) : JSON.stringify(payload)).toString("base64url")}.s`;
const claim = (plan: unknown) => jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "acc" }, email: "a@b.c" });
const auth = (o: object) => JSON.stringify(o);
const read = (text: string | null, env: NodeJS.ProcessEnv = {}) =>
  readCodexAccount({
    env,
    home: "/h",
    readFile: () => {
      if (text === null) throw new Error("ENOENT");
      return text;
    },
  });
const withPlan = (p: unknown) => auth({ OPENAI_API_KEY: null, tokens: { id_token: claim(p), access_token: "x" } });

describe("codexAuthPath", () => {
  test("default, absolute CODEX_HOME, relative ignored", () => {
    expect(codexAuthPath({}, "/h")).toBe("/h/.codex/auth.json");
    expect(codexAuthPath({ CODEX_HOME: "/c" }, "/h")).toBe("/c/auth.json");
    expect(codexAuthPath({ CODEX_HOME: "rel" }, "/h")).toBe("/h/.codex/auth.json");
    expect(codexAuthPath({ CODEX_HOME: "" }, "/h")).toBe("/h/.codex/auth.json");
  });
});

describe("readCodexAccount", () => {
  test("plans", () => {
    expect(read(withPlan("plus"))).toEqual({ kind: "personal", plan: "plus" });
    expect(read(withPlan("free"))).toEqual({ kind: "personal", plan: "free" });
    expect(read(withPlan("pro"))).toEqual({ kind: "personal", plan: "pro" });
    expect(read(withPlan("team"))).toEqual({ kind: "team", plan: "business" });
    expect(read(withPlan("business"))).toEqual({ kind: "team", plan: "business" });
    expect(read(withPlan("enterprise"))).toEqual({ kind: "enterprise", plan: "enterprise" });
    expect(read(withPlan("edu"))).toEqual({ kind: "enterprise", plan: "edu" });
  });
  test("unknown plan gives null", () => {
    expect(read(withPlan("weird"))).toBeNull();
    expect(read(withPlan(5))).toBeNull();
  });
  test("API key only", () => {
    expect(read(auth({ OPENAI_API_KEY: "sk-x" }))).toEqual({ kind: "api" });
    expect(read(auth({ OPENAI_API_KEY: "sk-x", tokens: {} }))).toEqual({ kind: "api" });
    expect(read(auth({ OPENAI_API_KEY: "" }))).toBeNull();
    expect(read(auth({ OPENAI_API_KEY: null }))).toBeNull();
  });
  test("tokens and API key: plan claim wins", () => {
    expect(read(auth({ OPENAI_API_KEY: "sk-x", tokens: { id_token: claim("plus") } }))).toEqual({
      kind: "personal",
      plan: "plus",
    });
  });
  test("problems give null", () => {
    expect(read(null)).toBeNull();
    expect(read("{nope")).toBeNull();
    expect(read("[]")).toBeNull();
    expect(read(auth({ tokens: { id_token: "a.b" } }))).toBeNull();
    expect(read(auth({ tokens: { id_token: jwt("not json", true) } }))).toBeNull();
    expect(read(auth({ tokens: { id_token: jwt({ "https://api.openai.com/auth": "x" }) } }))).toBeNull();
    expect(read(auth({ tokens: { id_token: jwt({}) } }))).toBeNull();
  });
  test("reads from the resolved path", () => {
    let seen = "";
    readCodexAccount({ env: { CODEX_HOME: "/c" }, home: "/h", readFile: (p) => ((seen = p), "{}") });
    expect(seen).toBe("/c/auth.json");
  });
  test("returns only kind and plan", () => {
    const r = read(withPlan("team"));
    expect(Object.keys(r ?? {}).sort()).toEqual(["kind", "plan"]);
    expect(JSON.stringify(r)).not.toMatch(/acc|a@b\.c/);
  });
});
