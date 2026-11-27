import type { Lang } from "../lang.js";
import { pluralKey, type PluralKey } from "../site/plural-key.js";
import type { MeAnswer } from "../site/session.js";
import { dashboardPath, teamPath } from "../site/team-param.js";

/** What `/teams` decides: a view to draw, or a place to send the browser instead. */

export type TeamsView = "signedOut" | "member" | "list" | "create" | "failed";

/** Most teams one account may own: the server's own limit (`MAX_TEAMS_PER_USER`, which a test compares). */
export const MAX_OWNED = 5;

/** What `/teams` shows for this session and fragment, or where it sends the browser instead. */
export function teamsView(session: MeAnswer, hash: string): { view: TeamsView } | { go: string } {
  if (session.kind === "none") return { view: "signedOut" };
  if (session.kind !== "me") return { view: "failed" };
  if (session.me.kind === "member") return { view: "member" };
  const { teams } = session.me;
  const [only] = teams;
  if (teams.length === 0 || hash === "#new") return { view: "create" };
  if (teams.length === 1 && only !== undefined && hash !== "#all") {
    return { go: only.role === "viewer" ? dashboardPath(only.id) : teamPath(only.id) };
  }
  return { view: "list" };
}

/** The teams by name in the language's own order; equal names by id. A new array. */
export function sortTeams<T extends { id: string; name: string }>(teams: T[], lang: Lang): T[] {
  const collator = new Intl.Collator(lang);
  return [...teams].sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The line "You own {n} of {max} teams.": its key, with the noun agreeing with the limit, and its values. */
export function ownedLine(lang: Lang, owned: number, max: number): { key: PluralKey<"owned">; vars: { n: number; max: number } } {
  return { key: pluralKey(lang, "owned", max), vars: { n: owned, max } };
}

/** The line "You own {n} teams, the most one account can.": its key, with the noun agreeing with n, and its values. */
export function atMostLine(lang: Lang, owned: number): { key: PluralKey<"atMost">; vars: { n: number } } {
  return { key: pluralKey(lang, "atMost", owned), vars: { n: owned } };
}
