import { expect, test } from "vitest";
import type { ApiResult } from "../site/http.js";
import type { MeAnswer } from "../site/session.js";
import type { TeamInfo } from "./api.js";
import { startView, teamPageView } from "./page-view.js";

const T = "0f1e2d3c4b5a6978";
const team = (role: TeamInfo["role"]): ApiResult<{ team: TeamInfo }> => ({ kind: "ok", value: { team: { id: T, name: "Acme", role, dashboardAccess: "members" } } });
const refused = (status: number, error = ""): ApiResult<never> => ({ kind: "refused", status, error });

test.each<[string, string | null, ApiResult<{ team: TeamInfo }> | null, ReturnType<typeof teamPageView>]>([
  ["no valid id", null, null, "notFound"],
  ["a 404", T, refused(404, "team not found"), "notFound"],
  ["a 403", T, refused(403, "your role does not allow this"), "notFound"],
  ["a 401", T, { kind: "unauthorized" }, "signedOut"],
  ["a viewer", T, team("viewer"), "viewer"],
  ["an admin", T, team("admin"), "page"],
  ["an owner", T, team("owner"), "page"],
  ["an answer about another team", T, { kind: "ok", value: { team: { id: "1111111111111111", name: "B", role: "owner", dashboardAccess: "members" } } }, "failed"],
  ["an answer the page cannot read", T, { kind: "ok", value: { team: { id: T } } } as ApiResult<{ team: TeamInfo }>, "failed"],
  ["a 5xx", T, { kind: "failed" }, "failed"],
  ["a network error", T, { kind: "network" }, "failed"],
  ["another refusal", T, refused(503, "busy"), "failed"],
])("%s → %s", (_name, id, result, view) => {
  expect(teamPageView(id, result)).toBe(view);
});

const user: MeAnswer = { kind: "me", me: { kind: "user", githubId: 7, login: "acme-admin", teams: [] } };

test.each<[string, MeAnswer, ReturnType<typeof startView>]>([
  ["a session that could not be read", { kind: "failed" }, "failed"],
  ["a server with no accounts", { kind: "noAccounts" }, "failed"],
  ["nobody", { kind: "none" }, "signedOut"],
  ["a member's session", { kind: "me", me: { kind: "member", team: { id: T, name: "Acme" }, memberId: 4 } }, "signedOut"],
  ["a GitHub user", user, "page"],
])("the session of %s: %s", (_name, session, view) => {
  expect(startView(T, session, team("owner"))).toBe(view);
});
