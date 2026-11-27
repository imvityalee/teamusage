import { describe, expect, test } from "vitest";
import { INVITE_DAYS } from "../../../src/admin-invites.js";
import { MAX_ADMINS_AND_VIEWERS as SERVER_MAX } from "../../../src/team-roles.js";
import { acceptedPath, expiryDay, isPreview, MAX_ADMINS_AND_VIEWERS, viewAfterRefusal } from "./answers.js";
import { strings } from "./strings.js";

const DAY = "2026-12-04T12:00:00.000Z";

describe("the server's own values", () => {
  test("the limit of admins and viewers is the server's", () => {
    expect(MAX_ADMINS_AND_VIEWERS).toBe(SERVER_MAX);
  });

  test("the page's text names the server's limit and the days an invitation works", () => {
    expect(strings.en.teamFullTitle).toContain(`${SERVER_MAX} admins and viewers`);
    expect(strings.ru.teamFullTitle).toContain(`${SERVER_MAX} `);
    expect(strings.en.notValidText).toContain(`${INVITE_DAYS} days`);
    expect(strings.ru.notValidText).toContain(`${INVITE_DAYS} дней`);
  });
});

describe("isPreview", () => {
  test.each(["admin", "viewer"])("takes a preview of a %s's invitation", (role) => {
    expect(isPreview({ team: { name: "Acme" }, role, expiresAt: DAY })).toBe(true);
  });

  test.each([
    null,
    "x",
    {},
    { team: { name: 1 }, role: "admin", expiresAt: DAY },
    { team: null, role: "admin", expiresAt: DAY },
    { team: { name: "Acme" }, role: "owner", expiresAt: DAY },
    { team: { name: "Acme" }, role: "admin", expiresAt: "soon" },
    { team: { name: "Acme" }, role: "admin" },
  ])("refuses %j", (value) => {
    expect(isPreview(value)).toBe(false);
  });
});

describe("acceptedPath", () => {
  test("an admin goes to the team page, a viewer to the dashboard", () => {
    expect(acceptedPath({ team: { id: "2222222222222222", role: "admin" } })).toBe("/team?team=2222222222222222");
    expect(acceptedPath({ team: { id: "2222222222222222", role: "viewer" } })).toBe("/dashboard?team=2222222222222222");
  });

  test.each([null, {}, { team: { id: "../x", role: "admin" } }, { team: { id: "2222222222222222", role: "owner" } }, { team: { id: 7, role: "viewer" } }])(
    "an answer that does not name a team and its role (%j) leads to the list of teams",
    (value) => {
      expect(acceptedPath(value)).toBe("/teams#all");
    },
  );
});

describe("viewAfterRefusal", () => {
  test.each([
    [{ kind: "unauthorized" } as const, "signIn"],
    [{ kind: "refused", status: 404, error: "this invite is no longer valid" } as const, "notValid"],
    [{ kind: "refused", status: 409, error: "you already have a role in this team" } as const, "hasRole"],
    [{ kind: "refused", status: 409, error: "this team has reached its limit of 50 admins and viewers" } as const, "teamFull"],
    [{ kind: "refused", status: 409, error: "this team has reached its limit of 49 admins and viewers" } as const, "failed"],
    [{ kind: "refused", status: 403, error: "you already have a role in this team" } as const, "failed"],
    [{ kind: "refused", status: 503, error: "" } as const, "failed"],
    [{ kind: "network" } as const, "failed"],
    [{ kind: "failed" } as const, "failed"],
  ])("%j leads to %s", (answer, view) => {
    expect(viewAfterRefusal(answer)).toBe(view);
  });
});

test("the last day is written in the page's language", () => {
  expect(expiryDay(DAY, "en")).toBe("Dec 4, 2026");
  expect(expiryDay(DAY, "ru")).toBe("4 дек. 2026 г.");
});
