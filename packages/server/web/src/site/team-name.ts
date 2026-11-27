import { MAX_TEAM_NAME_CHARS, NAME_CONTROL_CHARS } from "@teamusage/shared";

/** True for a team name the server takes: 1 to MAX_TEAM_NAME_CHARS characters once trimmed, with no control character (a line break). */
export function isTeamNameInput(name: string): boolean {
  const length = name.trim().length;
  return length >= 1 && length <= MAX_TEAM_NAME_CHARS && !NAME_CONTROL_CHARS.test(name);
}
