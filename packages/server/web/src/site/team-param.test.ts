import { describe, expect, test } from "vitest";
import { dashboardPath, isTeamId, teamParam, teamPath } from "./team-param.js";

const ID = "0123456789abcdef";

describe("teamParam", () => {
  test.each<[string, string | null]>([
    [`?team=${ID}`, ID],
    [`?x=1&team=${ID}`, ID],
    [`?team=${ID}&team=${ID}`, null],
    [`?team=${ID}&team=fedcba9876543210`, null],
    ["?team=0123456789abcde", null],
    ["?team=0123456789abcdef0", null],
    ["?team=0123456789ABCDEF", null],
    ["?team=0123456789abcdeg", null],
    ["?team=", null],
    ["?other=1", null],
    ["", null],
  ])("teamParam(%j) is %j", (search, expected) => expect(teamParam(search)).toBe(expected));
});

describe("teamPath and dashboardPath", () => {
  test("build the page's path from a checked id", () => {
    expect(teamPath(ID)).toBe(`/team?team=${ID}`);
    expect(dashboardPath(ID)).toBe(`/dashboard?team=${ID}`);
  });

  test.each(["x", "", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "../team?team=0123456789abcdef", `${ID}&admin=1`])(
    "an id that is not 16 lowercase hex characters (%j) throws a RangeError",
    (id) => {
      expect(() => teamPath(id)).toThrow(RangeError);
      expect(() => dashboardPath(id)).toThrow(RangeError);
      expect(isTeamId(id)).toBe(false);
    },
  );
});
