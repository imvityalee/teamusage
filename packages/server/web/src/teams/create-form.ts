import type { ApiResult } from "../site/http.js";
import { isTeamNameInput } from "../site/team-name.js";
import { isTeamId } from "../site/team-param.js";
import { MAX_OWNED } from "./teams.js";

/** The "Name your team" form: what is wrong with it before it is sent, and what the server's answer means. */

/** The server's own texts of the refusals the page knows (`src/routes-teams.ts`). */
const OWNS_MOST = `you already own ${MAX_OWNED} teams`;
const SIGN_UPS_PAUSED = "sign-ups are paused";
const INVALID_NAME = "invalid name";

/** What is wrong with the form before it is sent: the name (empty or over the server's limit once trimmed), the choice (none made), or nothing. */
export function checkForm(name: string, access: string | null): "name" | "access" | null {
  if (!isTeamNameInput(name)) return "name";
  return access === "members" || access === "admins" ? null : "access";
}

export type CreateError = "name" | "ownsMost" | "paused" | "failed" | "network";
export type CreateOutcome = { kind: "created"; team: string } | { kind: "signedOut" } | { kind: "error"; error: CreateError };

const error = (e: CreateError): CreateOutcome => ({ kind: "error", error: e });

/** What the answer to `POST /api/teams` means. Only the new team's id is read from a 201; its code is never looked at. */
export function createOutcome(result: ApiResult<{ team: { id: string } }>): CreateOutcome {
  switch (result.kind) {
    case "ok": {
      const id = result.value?.team?.id;
      return typeof id === "string" && isTeamId(id) ? { kind: "created", team: id } : error("failed");
    }
    case "unauthorized":
      return { kind: "signedOut" };
    case "network":
      return error("network");
    case "failed":
      return error("failed");
    case "refused":
      if (result.status === 409 && result.error === OWNS_MOST) return error("ownsMost");
      if (result.status === 503 && result.error === SIGN_UPS_PAUSED) return error("paused");
      if (result.status === 400 && result.error === INVALID_NAME) return error("name");
      return error("failed");
  }
}
