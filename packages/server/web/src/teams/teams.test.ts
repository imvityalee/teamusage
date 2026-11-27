import { describe, expect, test } from "vitest";
import { MAX_TEAMS_PER_USER } from "../../../src/hosted-teams.js";
import type { Me, MeAnswer } from "../site/session.js";
import { atMostLine, MAX_OWNED, ownedLine, sortTeams, teamsView } from "./teams.js";

type Team = Extract<Me, { kind: "user" }>["teams"][number];
const MEMBER: MeAnswer = { kind: "me", me: { kind: "member", team: { id: "3333333333333333", name: "Data" }, memberId: 4 } };
const OWNED: Team = { id: "1111111111111111", name: "Acme", role: "owner", dashboardAccess: "members" };
const VIEWED: Team = { id: "2222222222222222", name: "Zed", role: "viewer", dashboardAccess: "admins" };
const ADMIN: Team = { ...OWNED, id: "4444444444444444", role: "admin" };
const user = (teams: Team[]): MeAnswer => ({ kind: "me", me: { kind: "user", githubId: 9_104_227, login: "bob", teams } });

describe("teamsView", () => {
  test.each<[string, MeAnswer, string, ReturnType<typeof teamsView>]>([
    ["nobody", { kind: "none" }, "", { view: "signedOut" }],
    ["a member's session", MEMBER, "", { view: "member" }],
    ["a member's session, #new", MEMBER, "#new", { view: "member" }],
    ["no team", user([]), "", { view: "create" }],
    ["no team, #all", user([]), "#all", { view: "create" }],
    ["an owner of one team", user([OWNED]), "", { go: "/team?team=1111111111111111" }],
    ["an admin of one team", user([ADMIN]), "", { go: "/team?team=4444444444444444" }],
    ["a viewer of one team", user([VIEWED]), "", { go: "/dashboard?team=2222222222222222" }],
    ["one team, #all", user([OWNED]), "#all", { view: "list" }],
    ["one team, #new", user([OWNED]), "#new", { view: "create" }],
    ["one team, a fragment of no meaning", user([OWNED]), "#x", { go: "/team?team=1111111111111111" }],
    ["two teams", user([OWNED, VIEWED]), "", { view: "list" }],
    ["two teams, #new", user([OWNED, ADMIN]), "#new", { view: "create" }],
    ["a session that could not be read", { kind: "failed" }, "", { view: "failed" }],
    ["a server with no accounts", { kind: "noAccounts" }, "", { view: "failed" }],
  ])("%s", (_name, session, hash, expected) => expect(teamsView(session, hash)).toEqual(expected));
});

describe("sortTeams", () => {
  const team = (id: string, name: string) => ({ id, name });

  test("Russian names sort in Russian order, English names in English order", () => {
    const ru = sortTeams([team("a", "Яблоко"), team("b", "Ёлка"), team("c", "Арбуз"), team("d", "Берёза")], "ru").map((t) => t.name);
    expect(ru).toEqual(["Арбуз", "Берёза", "Ёлка", "Яблоко"]);
    const en = sortTeams([team("a", "beta"), team("b", "Alpha"), team("c", "alpine")], "en").map((t) => t.name);
    expect(en).toEqual(["Alpha", "alpine", "beta"]);
  });

  test("equal names go by id, and the input is not changed", () => {
    const input = [team("c", "Same"), team("a", "Same"), team("b", "Same")];
    expect(sortTeams(input, "en").map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(input.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });
});

describe("the count of owned teams", () => {
  test("MAX_OWNED is the server's own limit", () => {
    expect(MAX_OWNED).toBe(MAX_TEAMS_PER_USER);
  });

  test.each<["en" | "ru", number, number, string]>([
    ["en", 1, 1, "owned_one"],
    ["en", 1, 5, "owned_many"],
    ["en", 0, 21, "owned_many"],
    ["ru", 1, 1, "owned_one"],
    ["ru", 2, 2, "owned_few"],
    ["ru", 1, 5, "owned_many"],
    ["ru", 1, 21, "owned_one"],
    ["ru", 1, 22, "owned_few"],
    ["ru", 1, 11, "owned_many"],
  ])("%s: %i of %i teams uses %s, the noun agreeing with the limit", (lang, owned, max, key) => {
    expect(ownedLine(lang, owned, max)).toEqual({ key, vars: { n: owned, max } });
  });
});

describe("the line at the most", () => {
  test.each<["en" | "ru", number, string]>([
    ["en", 1, "atMost_one"],
    ["en", 5, "atMost_many"],
    ["ru", 1, "atMost_one"],
    ["ru", 3, "atMost_few"],
    ["ru", 5, "atMost_many"],
    ["ru", 21, "atMost_one"],
  ])("%s: %i teams uses %s", (lang, owned, key) => {
    expect(atMostLine(lang, owned)).toEqual({ key, vars: { n: owned } });
  });
});
