import { expect, test } from "vitest";
import type { Db } from "../db.js";
import { runSteps, STEPS } from "../migrate.js";
import { legacyWithData } from "./legacy.fixture.js";

const version = (db: Db) => db.pragma("user_version", { simple: true });

test("a version 2 database swaps the usage indexes for the ordered ones and keeps its rows", () => {
  const db = legacyWithData();
  runSteps(db, STEPS.slice(0, 2));
  const rows = () => db.prepare("select * from usage order by date, agent, model").all();
  const before = rows();
  runSteps(db, STEPS.slice(0, 3));
  expect(version(db)).toBe(3);
  const names = (db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'usage' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((r) => r.name);
  expect(names).toEqual(["usage_by_day", "usage_by_member"]);
  expect(rows()).toEqual(before);
});
