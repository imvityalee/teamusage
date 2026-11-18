import { describe, expect, test } from "vitest";
import { matchMembers } from "./search.js";

const MEMBERS = [
  { id: 1, name: "Alice Archer", email: "alice@example.com" },
  { id: 2, name: "Bao Nguyen", email: "bao@corp.example" },
  { id: 3, name: "Анна Смирнова", email: "anna@example.ru" },
  { id: 4, name: "Dot.Com (ops)", email: "ops+dot@example.com" },
];
const ids = (list: { id: number }[]) => list.map((m) => m.id);

describe("matchMembers", () => {
  test("matches a substring of the name or of the email, ignoring case", () => {
    expect(ids(matchMembers(MEMBERS, "archer"))).toEqual([1]);
    expect(ids(matchMembers(MEMBERS, "NGUY"))).toEqual([2]);
    expect(ids(matchMembers(MEMBERS, "corp.EX"))).toEqual([2]);
    expect(ids(matchMembers(MEMBERS, "example.com"))).toEqual([1, 4]);
  });

  test("trims the query, and an empty query returns everyone in order", () => {
    expect(ids(matchMembers(MEMBERS, "  bao  "))).toEqual([2]);
    expect(ids(matchMembers(MEMBERS, ""))).toEqual([1, 2, 3, 4]);
    expect(ids(matchMembers(MEMBERS, "   "))).toEqual([1, 2, 3, 4]);
  });

  test("does not change the list it is given", () => {
    const list = [...MEMBERS];
    matchMembers(list, "bao");
    expect(list).toEqual(MEMBERS);
  });

  test("regular expression and markup characters are taken literally", () => {
    expect(ids(matchMembers(MEMBERS, "."))).toEqual([1, 2, 3, 4]); // every email has a dot
    expect(ids(matchMembers(MEMBERS, "t.c"))).toEqual([4]);
    expect(ids(matchMembers(MEMBERS, "*"))).toEqual([]);
    expect(ids(matchMembers(MEMBERS, "("))).toEqual([4]);
    expect(ids(matchMembers(MEMBERS, "(ops)"))).toEqual([4]);
    expect(ids(matchMembers(MEMBERS, "+"))).toEqual([4]);
    expect(ids(matchMembers(MEMBERS, "<b>"))).toEqual([]);
    expect(ids(matchMembers(MEMBERS, "a.*e"))).toEqual([]);
    expect(ids(matchMembers(MEMBERS, "[a-z]"))).toEqual([]);
    expect(ids(matchMembers(MEMBERS, "\\"))).toEqual([]);
    expect(() => matchMembers(MEMBERS, "((")).not.toThrow();
  });

  test("Cyrillic names match regardless of case", () => {
    expect(ids(matchMembers(MEMBERS, "анна"))).toEqual([3]);
    expect(ids(matchMembers(MEMBERS, "СМИРН"))).toEqual([3]);
    expect(ids(matchMembers([{ id: 5, name: "ЁЖИК", email: "e@x" }], "ёжик"))).toEqual([5]);
  });
});
