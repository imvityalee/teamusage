import { describe, expect, test } from "vitest";
import type { UsageRecord } from "@teamusage/shared";
import { claudeConfigPath, labelRecords, readClaudeAccount } from "./account.js";

const read = (json: string | null) =>
  readClaudeAccount({
    env: {},
    home: "/h",
    readFile: () => {
      if (json === null) throw new Error("ENOENT");
      return json;
    },
  });
const login = (organizationType: string, organizationName?: string) =>
  JSON.stringify({ oauthAccount: { organizationType, organizationName, emailAddress: "a@b.c", accountUuid: "u-1" } });

describe("claudeConfigPath", () => {
  test("uses the home directory by default", () => {
    expect(claudeConfigPath({}, "/home/ann")).toBe("/home/ann/.claude.json");
  });
  test("uses CLAUDE_CONFIG_DIR when it is an absolute path", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/cfg/claude" }, "/home/ann")).toBe("/cfg/claude/.claude.json");
  });
  test("ignores an empty or relative CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "" }, "/home/ann")).toBe("/home/ann/.claude.json");
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "rel/dir" }, "/home/ann")).toBe("/home/ann/.claude.json");
  });
  test("reads from the resolved path", () => {
    let seen = "";
    readClaudeAccount({ env: { CLAUDE_CONFIG_DIR: "/cfg" }, home: "/h", readFile: (p) => ((seen = p), "{}") });
    expect(seen).toBe("/cfg/.claude.json");
  });
});

describe("readClaudeAccount", () => {
  test("team and enterprise carry the organisation name", () => {
    expect(read(login("claude_team", "Devcats"))).toEqual({ kind: "team", org: "Devcats" });
    expect(read(login("claude_enterprise", "Big Co"))).toEqual({ kind: "enterprise", org: "Big Co" });
  });
  test("pro, max and free are personal and never carry an organisation", () => {
    for (const t of ["claude_pro", "claude_max", "claude_free"]) {
      expect(read(login(t, "Someone's Org"))).toEqual({ kind: "personal" });
    }
  });
  test("inherited Object property names as organizationType give no label", () => {
    for (const t of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(read(login(t, "Devcats"))).toBeNull();
    }
    expect(read('{"oauthAccount":{"organizationType":"__proto__","organizationName":"X"}}')).toBeNull();
  });
  test("a throwing home resolver or file reader gives no label", () => {
    const boom = () => {
      throw new Error("no home");
    };
    expect(readClaudeAccount({ env: {}, home: boom, readFile: () => "{}" })).toBeNull();
    expect(readClaudeAccount({ env: {}, home: () => "/h", readFile: boom })).toBeNull();
  });
  test("a file without oauthAccount is an API login", () => {
    expect(read("{}")).toEqual({ kind: "api" });
  });
  test("unknown type, missing file, invalid JSON and a malformed oauthAccount give no label", () => {
    expect(read(login("claude_vip", "X"))).toBeNull();
    expect(read(null)).toBeNull();
    expect(read("{not json")).toBeNull();
    expect(read('{"oauthAccount":"x"}')).toBeNull();
    expect(read("[]")).toBeNull();
  });
  test("the organisation name is trimmed and stripped of control characters", () => {
    expect(read(login("claude_team", "  De\u0007v  "))).toEqual({ kind: "team", org: "Dev" });
  });
  test("the organisation name is cut to 100 characters", () => {
    expect((read(login("claude_team", "x".repeat(300))) as { org: string }).org).toHaveLength(100);
  });
  test("a blank organisation name leaves no org", () => {
    expect(read(login("claude_team", "   "))).toEqual({ kind: "team" });
    expect(read(login("claude_team"))).toEqual({ kind: "team" });
  });
  test("only kind and org are returned", () => {
    const a = read(login("claude_team", "Devcats"))!;
    expect(Object.keys(a).sort()).toEqual(["kind", "org"]);
    expect(JSON.stringify(a)).not.toContain("a@b.c");
    expect(JSON.stringify(a)).not.toContain("u-1");
  });
});

describe("labelRecords", () => {
  const r = (date: string, agent: string, extra: object = {}): UsageRecord =>
    ({ date, agent, model: "m", input: 1, output: 1, cacheCreate: 0, cacheRead: 0, total: 2, costUsd: 0, unpriced: false, ...extra }) as UsageRecord;
  const acct = { kind: "team", org: "Devcats" } as const;

  test("labels only today and yesterday", () => {
    const out = labelRecords(
      [r("2026-11-18", "claude"), r("2026-11-17", "claude"), r("2026-11-16", "claude"), r("2026-11-18", "codex")],
      acct,
      "2026-11-18",
    );
    expect(out[0]!.account).toEqual(acct);
    expect(out[1]!.account).toEqual(acct);
    expect(out[2]!.account).toBeUndefined();
    expect(out[3]!.account).toBeUndefined();
  });
  test("yesterday crosses month boundaries", () => {
    expect(labelRecords([r("2026-10-31", "claude")], acct, "2026-11-01")[0]!.account).toEqual(acct);
  });
  test("removes any existing account and adds no key without a label", () => {
    const out = labelRecords([r("2026-11-18", "claude", { account: { kind: "api" } })], null, "2026-11-18");
    expect("account" in out[0]!).toBe(false);
    const old = labelRecords([r("2026-11-01", "claude", { account: { kind: "api" } })], acct, "2026-11-18");
    expect("account" in old[0]!).toBe(false);
  });
});
