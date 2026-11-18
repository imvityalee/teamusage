import { describe, expect, test } from "vitest";
import { accountKey, parseAccountKey, validateAccount } from "./account.js";

describe("accountKey", () => {
  test("keys", () => {
    expect(accountKey({ kind: "team", org: "Devcats" })).toBe("team:Devcats");
    expect(accountKey({ kind: "team" })).toBe("team:");
    expect(accountKey({ kind: "personal" })).toBe("personal");
    expect(accountKey({ kind: "api" })).toBe("api");
    expect(accountKey(null)).toBe("unknown");
    expect(accountKey(undefined)).toBe("unknown");
  });
});
describe("parseAccountKey", () => {
  test("valid", () => {
    expect(parseAccountKey("team:a:b")).toEqual({ kind: "team", org: "a:b" });
    expect(parseAccountKey("enterprise:")).toEqual({ kind: "enterprise", org: "" });
    expect(parseAccountKey("unknown")).toEqual({ kind: "unknown", org: null });
    expect(parseAccountKey("personal")).toEqual({ kind: "personal", org: null });
  });
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
  ])("rejects %j", (a) => expect(typeof validateAccount(a)).toBe("string"));
  test("accepts and drops extra keys", () => {
    expect(validateAccount({ kind: "team", org: "Devcats", extra: 1 })).toEqual({ kind: "team", org: "Devcats" });
    expect(validateAccount({ kind: "personal" })).toEqual({ kind: "personal" });
    expect(validateAccount({ kind: "team", org: "x".repeat(100) })).toEqual({ kind: "team", org: "x".repeat(100) });
  });
});
