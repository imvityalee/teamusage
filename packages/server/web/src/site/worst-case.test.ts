import { isDisplayName, isEmail, MAX_DISPLAY_NAME_CHARS, MAX_EMAIL_CHARS, MAX_TEAM_NAME_CHARS } from "@teamusage/shared";
import { describe, expect, test } from "vitest";
import { worstCase } from "./worst-case.fixture.js";

/** GitHub's own rule for a login: letters, digits and single inner hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const names = worstCase.people.map((p) => p.name);
const emails = worstCase.people.map((p) => p.email);

describe("every worst-case value is one the server accepts", () => {
  test.each(names)("the name %j is a display name", (name) => {
    expect(isDisplayName(name)).toBe(true);
  });

  test.each(emails)("the email %j is an email", (email) => {
    expect(isEmail(email)).toBe(true);
  });

  test("the team name is a display name within the team name's limit", () => {
    expect(isDisplayName(worstCase.teamName)).toBe(true);
    expect(worstCase.teamName.trim().length).toBeLessThanOrEqual(MAX_TEAM_NAME_CHARS);
  });

  test("the machine label is one /api/register accepts (a display name)", () => {
    expect(isDisplayName(worstCase.machineLabel)).toBe(true);
  });

  test("the login is a GitHub login", () => {
    expect(worstCase.login).toMatch(GITHUB_LOGIN);
  });
});

describe("the worst cases the plan names", () => {
  test("the names", () => {
    expect(names).toEqual(expect.arrayContaining(["Aleksandra Wiśniewska-Kowalczyk", "Jo", "Данияр Жумабеков"]));
    const longest = names.find((n) => n.length === 100);
    expect(longest).toContain(" ");
    expect(MAX_DISPLAY_NAME_CHARS).toBe(100);
    expect(names.some((n) => /^\p{Extended_Pictographic}/u.test(n))).toBe(true);
  });

  test("the emails", () => {
    expect(emails).toContain("bartholomew.fitzgerald@northwind-industries-holdings.example.com");
    const longest = emails.find((e) => e.length === 254);
    expect(longest?.slice(0, 64)).not.toContain(".");
    expect(MAX_EMAIL_CHARS).toBe(254);
  });

  test("the team name, the machine label and the login", () => {
    expect(worstCase.teamName).toHaveLength(60);
    expect(worstCase.teamName).toMatch(/^[\p{Script=Cyrillic} ]+$/u);
    expect(MAX_TEAM_NAME_CHARS).toBe(60);
    expect(worstCase.machineLabel).toBe("MAXIMILIAN-WORKSTATION-LINUX-01.engineering.corp.example");
    expect(worstCase.login).toHaveLength(39);
  });
});
