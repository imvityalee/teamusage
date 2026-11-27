import { beforeEach, expect, test } from "vitest";
import { everythingOf, manageWorld, PEOPLE, type ManageWorld } from "./manage.fixture.js";
import { findUser } from "./users.js";

let w: ManageWorld;
beforeEach(async () => {
  w = await manageWorld();
});

test("in the world, the ids that could be mistaken for one another differ, and B's id is not 1", () => {
  const userId = (who: "bob" | "cyd" | "dee") => findUser(w.db, PEOPLE[who].githubId)?.id;
  const ids = [w.B.id, w.B.sam.memberId, w.B.tia.memberId, userId("bob"), userId("cyd"), userId("dee"), ...Object.values(PEOPLE).map((p) => p.githubId)];
  expect(ids.every((id) => typeof id === "number")).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(w.B.id).not.toBe(1);
  expect(everythingOf(w.db, w.B.id).usage).toHaveLength(4 + 3 + 2);
});
