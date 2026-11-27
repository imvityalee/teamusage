import { dashboardPath, teamPath } from "./team-param.js";

/** The header's "Dashboard | Team" links of an owner or admin (`#team-nav`), shared by the dashboard and the team page. */

export type TeamNav = { dashboard: string; team: string };

/** The two links of the team `team`, a checked public id; throws a RangeError for any other value. */
export const teamNav = (team: string): TeamNav => ({ dashboard: dashboardPath(team), team: teamPath(team) });

/** A link to `href`, or no link at all. */
function link(a: HTMLElement, href: string | undefined): void {
  if (href === undefined) a.removeAttribute("href");
  else a.setAttribute("href", href);
}

/** Shows the nav with its two links, or hides it (null). */
export function renderTeamNav(doc: Document, nav: TeamNav | null): void {
  (doc.getElementById("team-nav") as HTMLElement).hidden = nav === null;
  link(doc.getElementById("nav-dashboard") as HTMLElement, nav?.dashboard);
  link(doc.getElementById("nav-team") as HTMLElement, nav?.team);
}
