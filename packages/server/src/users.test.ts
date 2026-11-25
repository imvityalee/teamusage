import { beforeEach, expect, test } from "vitest";
import { openDb, type Db } from "./db.js";
import { ensureUser, findUser } from "./users.js";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

const userRows = () => db.prepare("select github_id, login from users").all();

test("a user is unknown until ensureUser creates the row", () => {
  expect(findUser(db, 7)).toBeNull();
  const ann = ensureUser(db, { githubId: 7, login: "ann" });
  expect(ann).toEqual({ id: ann.id, githubId: 7, login: "ann" });
  expect(findUser(db, 7)).toEqual(ann);
  expect(findUser(db, 8)).toBeNull();
});

test("ensureUser twice with one GitHub id returns the same id and adds no row", () => {
  const first = ensureUser(db, { githubId: 7, login: "ann" });
  const second = ensureUser(db, { githubId: 7, login: "ann" });
  expect(second).toEqual(first);
  expect(userRows()).toEqual([{ github_id: 7, login: "ann" }]);
});

test("a changed login is stored", () => {
  const first = ensureUser(db, { githubId: 7, login: "ann" });
  const renamed = ensureUser(db, { githubId: 7, login: "ann-renamed" });
  expect(renamed).toEqual({ id: first.id, githubId: 7, login: "ann-renamed" });
  expect(findUser(db, 7)).toEqual(renamed);
  expect(userRows()).toEqual([{ github_id: 7, login: "ann-renamed" }]);
});
