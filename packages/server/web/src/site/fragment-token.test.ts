import { describe, expect, test } from "vitest";
import { isToken, tokenOf } from "./fragment-token.js";

const TOKEN = "0123456789abcdef".repeat(4);

describe("tokenOf", () => {
  test("reads 64 hex characters after #", () => {
    expect(tokenOf(`#${TOKEN}`)).toBe(TOKEN);
  });

  test.each(["", "#", "#abc", `#${"g".repeat(64)}`, `#${"a".repeat(63)}`, `#${"a".repeat(65)}`, `#/x/${"a".repeat(64)}`, `#${"A".repeat(64)}`, `${"a".repeat(64)}`])(
    "tokenOf(%j) is null",
    (hash) => {
      expect(tokenOf(hash)).toBeNull();
    },
  );
});

test("isToken takes 64 lowercase hex characters and nothing else", () => {
  expect(isToken(TOKEN)).toBe(true);
  expect(isToken(`${TOKEN}\n`)).toBe(false);
  expect(isToken(TOKEN.toUpperCase())).toBe(false);
});
