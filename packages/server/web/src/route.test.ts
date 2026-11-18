import { describe, expect, test } from "vitest";
import { isMemberId, memberHref, parseRoute } from "./route.js";

describe("parseRoute", () => {
  test("a member fragment with a plain positive id is that member", () => {
    expect(parseRoute("#/member/12")).toEqual({ view: "member", id: 12 });
    expect(parseRoute("#/member/1")).toEqual({ view: "member", id: 1 });
    expect(parseRoute("#/member/9999999999")).toEqual({ view: "member", id: 9_999_999_999 });
  });

  test.each([
    "",
    "#",
    "#/",
    "#/member/",
    "#/member/0",
    "#/member/-3",
    "#/member/1.5",
    "#/member/abc",
    "#/member/12/extra",
    "#/member/01",
    "#/member/12345678901",
    "#/member/1e3",
    "#/member/0x1f",
    "#/member/12 ",
    "#/member/12?x=1",
    "#/member/%31",
    "#/Member/12",
    "/member/12",
    "#/member/12#/member/13",
  ])("%j is the team view", (hash) => {
    expect(parseRoute(hash)).toEqual({ view: "team" });
  });
});

describe("memberHref", () => {
  test("builds the fragment from the numeric id", () => {
    expect(memberHref(12)).toBe("#/member/12");
    expect(parseRoute(memberHref(9_999_999_999))).toEqual({ view: "member", id: 9_999_999_999 });
  });

  test("refuses anything that is not a valid member id", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 1e21, 12_345_678_901]) {
      expect(() => memberHref(bad)).toThrow(RangeError);
    }
    expect(() => memberHref("12" as unknown as number)).toThrow(RangeError);
  });
});

describe("isMemberId", () => {
  test("accepts only positive integers of at most ten digits", () => {
    expect(isMemberId(1)).toBe(true);
    expect(isMemberId(9_999_999_999)).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN, 1e21, "1", null, undefined, {}]) expect(isMemberId(bad)).toBe(false);
  });
});
