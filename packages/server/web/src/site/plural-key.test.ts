import { expect, test } from "vitest";
import { pluralKey } from "./plural-key.js";

test("the key of a counted noun follows the language's own forms", () => {
  const ru = [0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 101, 111].map((n) => pluralKey("ru", "team", n));
  expect(ru).toEqual([
    "team_many", "team_one", "team_few", "team_few", "team_many", "team_many",
    "team_many", "team_one", "team_few", "team_many", "team_one", "team_many",
  ]);
  expect([0, 1, 2, 5].map((n) => pluralKey("en", "team", n))).toEqual(["team_many", "team_one", "team_many", "team_many"]);
});
