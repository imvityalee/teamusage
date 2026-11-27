import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import type { Me } from "../site/session.js";
import { dashboardPath, isTeamId, teamPath } from "../site/team-param.js";
import type { translator } from "../site/i18n.js";
import { atMostLine, MAX_OWNED, ownedLine, sortTeams } from "./teams.js";
import type { TeamsKey } from "./strings.js";

/** The list of teams: one row for each, drawn as text, and the line that counts the teams one owns. */

type Team = Extract<Me, { kind: "user" }>["teams"][number];
type T = ReturnType<typeof translator<TeamsKey>>;

const ROLE_KEY = { owner: "roleOwner", admin: "roleAdmin", viewer: "roleViewer" } as const;

function linkButton(doc: Document, href: string, label: string, primary: boolean): HTMLElement {
  return h(doc, "a", { class: `btn ${primary ? "primary" : "quiet"}`, href }, label);
}

/** A viewer opens the dashboard only; an owner or an admin also opens the team page. Every address is built from the checked id. */
function row(doc: Document, team: Team, t: T, lang: Lang): HTMLElement {
  const links = [linkButton(doc, dashboardPath(team.id), t(lang, "dashboard"), true)];
  if (team.role !== "viewer") links.unshift(linkButton(doc, teamPath(team.id), t(lang, "teamPage"), false));
  return h(
    doc,
    "li",
    { class: "team-row" },
    h(doc, "div", { class: "team-main" }, h(doc, "div", { class: "team-name" }, team.name), h(doc, "span", { class: "badge" }, t(lang, ROLE_KEY[team.role]))),
    h(doc, "div", { class: "team-links" }, ...links),
  );
}

/** Replaces the rows of `list` with one row for each team that has a real id, by name. */
export function drawTeams(list: HTMLElement, teams: Team[], t: T, lang: Lang): void {
  const doc = list.ownerDocument;
  list.replaceChildren(...sortTeams(teams.filter((team) => isTeamId(team.id)), lang).map((team) => row(doc, team, t, lang)));
}

/** Puts the count line and the "Create a team" link in their state: at the most, the link gives way to the line that says so. */
export function paintOwned(line: HTMLElement, link: HTMLElement, owned: number, t: T, lang: Lang): void {
  const atMost = owned >= MAX_OWNED;
  const { key, vars } = atMost ? atMostLine(lang, owned) : ownedLine(lang, owned, MAX_OWNED);
  line.textContent = t(lang, key, vars);
  link.hidden = atMost;
}
