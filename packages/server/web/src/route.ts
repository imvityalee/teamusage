/** The page's two views, kept in the URL fragment so reload and Back work. */

export type Route = { view: "team" } | { view: "member"; id: number };

/** Same rule as the server: a positive integer of at most ten digits, no leading zero. */
const ID = /^[1-9][0-9]{0,9}$/;
const MEMBER = /^#\/member\/([1-9][0-9]{0,9})$/;

export function isMemberId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && ID.test(String(v));
}

/** "#/member/12" → member 12. Anything else, malformed or not, is the team view. */
export function parseRoute(hash: string): Route {
  const m = MEMBER.exec(hash);
  const id = m ? Number(m[1]) : NaN;
  return isMemberId(id) ? { view: "member", id } : { view: "team" };
}

/** The link to a member's page, built only from a valid numeric id. */
export function memberHref(id: number): string {
  if (!isMemberId(id)) throw new RangeError("invalid member id");
  return `#/member/${id}`;
}
