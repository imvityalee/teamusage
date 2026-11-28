/** A team's public id: 16 lowercase hex characters. The only team value an address or a link may be built from. */
const TEAM_ID = /^[a-f0-9]{16}$/;

export const isTeamId = (value: string): boolean => TEAM_ID.test(value);

/** An invite's public id: the same 16 lowercase hex characters as a team's (`isPublicId` of the server), under the name that says what is checked. */
export const isPublicId = isTeamId;

/** The team's public id in `?team=`; null when it is missing, repeated or not 16 lowercase hex characters. */
export function teamParam(search: string): string | null {
  const values = new URLSearchParams(search).getAll("team");
  const [only] = values;
  return values.length === 1 && only !== undefined && isTeamId(only) ? only : null;
}

function pathOf(page: string, team: string): string {
  if (!isTeamId(team)) throw new RangeError("a team's public id is 16 lowercase hex characters");
  return `${page}?${new URLSearchParams({ team })}`;
}

/** "/team?team=<id>"; throws a RangeError for an id that is not 16 lowercase hex characters. */
export const teamPath = (team: string): string => pathOf("/team", team);

/** "/dashboard?team=<id>"; throws a RangeError for an id that is not 16 lowercase hex characters. */
export const dashboardPath = (team: string): string => pathOf("/dashboard", team);
