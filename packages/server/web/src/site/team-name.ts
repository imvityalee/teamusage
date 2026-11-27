import { MAX_TEAM_NAME_CHARS, NAME_CONTROL_CHARS } from "@teamusage/shared";

/** The server's refusal of a team name it does not take (`src/routes-teams.ts`, `src/routes-team-settings.ts`). */
export const INVALID_NAME = "invalid name";

/** True for a team name the server takes: 1 to MAX_TEAM_NAME_CHARS characters once trimmed, with no control character (a line break). */
export function isTeamNameInput(name: string): boolean {
  const length = name.trim().length;
  return length >= 1 && length <= MAX_TEAM_NAME_CHARS && !NAME_CONTROL_CHARS.test(name);
}

/** A field for a team's name: a phone neither capitalises nor corrects it, so a name typed as it is stays as it is. */
export const NAME_FIELD = { autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false" };
