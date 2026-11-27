import { isTeamName } from "../../../src/hosted-teams.js";
import { describe, expect, test } from "vitest";
import type { ApiResult } from "../site/http.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { checkForm, createOutcome } from "./create-form.js";

describe("checkForm", () => {
  test.each<[string, string, string | null, "name" | "access" | null]>([
    ["an empty name", "", "members", "name"],
    ["spaces only", "     ", "members", "name"],
    ["60 characters", "a".repeat(60), "admins", null],
    ["61 characters", "a".repeat(61), "admins", "name"],
    ["60 characters and spaces around", `  ${"a".repeat(60)}  `, "members", null],
    ["a good name and no choice", "Acme", null, "access"],
    ["a good name and a choice nobody offers", "Acme", "everyone", "access"],
    ["no name and no choice: the name comes first", "", null, "name"],
  ])("%s", (_what, name, access, expected) => expect(checkForm(name, access)).toBe(expected));

  test("agrees with the server's isTeamName on the same inputs", () => {
    const inputs = [
      "",
      " ",
      "\n",
      "a",
      "a".repeat(60),
      "a".repeat(61),
      `${"a".repeat(60)} `,
      " ".repeat(5) + "a",
      "🦊".repeat(30),
      "🦊".repeat(31),
      "🦊 Kitsune",
      worstCase.teamName,
      `${worstCase.teamName}я`,
      "two\nlines",
      "tab\there",
      "nul\u0000",
      "del\u007f",
      "тридцать ".repeat(7),
    ];
    for (const name of inputs) expect(checkForm(name, "members") === null, JSON.stringify(name)).toBe(isTeamName(name));
  });
});

describe("createOutcome", () => {
  const refused = (status: number, error: string): ApiResult<{ team: { id: string } }> => ({ kind: "refused", status, error });
  const MOST = "you already own 5 teams";

  test.each<[string, ApiResult<{ team: { id: string } }>, ReturnType<typeof createOutcome>]>([
    ["201", { kind: "ok", value: { team: { id: "0123456789abcdef" } } }, { kind: "created", team: "0123456789abcdef" }],
    ["a 201 whose team id is not an id", { kind: "ok", value: { team: { id: "../x" } } }, { kind: "error", error: "failed" }],
    ["a 201 with no team", { kind: "ok", value: {} as { team: { id: string } } }, { kind: "error", error: "failed" }],
    ["401", { kind: "unauthorized" }, { kind: "signedOut" }],
    ["409, the owner's limit", refused(409, MOST), { kind: "error", error: "ownsMost" }],
    ["409 of another text", refused(409, "something else"), { kind: "error", error: "failed" }],
    ["503, sign-ups paused", refused(503, "sign-ups are paused"), { kind: "error", error: "paused" }],
    ["503 of another text", refused(503, ""), { kind: "error", error: "failed" }],
    ["400, invalid name", refused(400, "invalid name"), { kind: "error", error: "name" }],
    ["400, another text", refused(400, "invalid dashboardAccess"), { kind: "error", error: "failed" }],
    ["a 500", { kind: "failed" }, { kind: "error", error: "failed" }],
    ["a network error", { kind: "network" }, { kind: "error", error: "network" }],
  ])("%s", (_what, result, expected) => expect(createOutcome(result)).toEqual(expected));
});
