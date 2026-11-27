import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import type { Me, MeAnswer } from "../site/session.js";
import { dashboardPath, isTeamId, teamPath } from "../site/team-param.js";
import type { Source } from "./source.js";
import { applyDashText, dt } from "./strings.js";

/** The dashboard's header for its source and session: the team's name, the nav, the account and the demo's chip. */

export type Chrome = {
  teamName: string | null;
  nav: { dashboard: string; team: string } | null; // for an owner or admin
  /** `login` is a GitHub user's; null is a member's session, which reads "Signed in from your agent". */
  account: { login: string | null; teams: boolean; signOut: boolean } | null;
  sample: boolean; // the demo
  /** The team the statistics name: a GitHub user's team; null for a member's session (its own team), the demo and self-hosted. */
  team: string | null;
};

export type Panel = "signedOut" | "noTeam";

/** A session the page could read: `failed` and `noAccounts` never reach the header, they show the error with Retry. */
export type ReadSession = Extract<MeAnswer, { kind: "me" | "none" }>;

/** The header of a self-hosted server, and of nobody. */
export const PLAIN: Chrome = { teamName: null, nav: null, account: null, sample: false, team: null };

/** Where a GitHub user picks a team: the list of their teams. */
export const YOUR_TEAMS = "/teams#all";

type UserTeam = Extract<Me, { kind: "user" }>["teams"][number];

/** The team of a GitHub user's session the dashboard shows: the one `?team=` names when it is theirs; without `?team=`, their only team. */
function userTeam(team: string | null, teams: readonly UserTeam[]): UserTeam | undefined {
  const usable = teams.filter((t) => isTeamId(t.id));
  if (team !== null) return usable.find((t) => t.id === team);
  return usable.length === 1 ? usable[0] : undefined;
}

/** The header of this source and session, or what to do instead of drawing the dashboard. The one place a hosted team is decided. */
export function chromeOf(source: Source, session: ReadSession | null): Chrome | { go: string } | { panel: Panel } {
  if (source.kind === "selfHosted") return PLAIN;
  if (source.kind === "demo") return { ...PLAIN, sample: true };
  if (session === null || session.kind === "none") return { panel: "signedOut" };
  const { me } = session;
  if (me.kind === "member") return { ...PLAIN, teamName: me.team.name, account: { login: null, teams: false, signOut: true } };
  const team = userTeam(source.team, me.teams);
  if (team === undefined) return source.team === null ? { go: YOUR_TEAMS } : { panel: "noTeam" };
  const manages = team.role === "owner" || team.role === "admin";
  return {
    teamName: team.name,
    nav: manages ? { dashboard: dashboardPath(team.id), team: teamPath(team.id) } : null,
    account: { login: me.login, teams: true, signOut: true },
    sample: false,
    team: team.id,
  };
}

const byId = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;

/** A link to `href`, or no link at all. */
function link(a: HTMLElement, href: string | undefined): void {
  if (href === undefined) a.removeAttribute("href");
  else a.setAttribute("href", href);
}

function renderNav(doc: Document, nav: Chrome["nav"]): void {
  byId(doc, "team-nav").hidden = nav === null;
  link(byId(doc, "nav-dashboard"), nav?.dashboard);
  link(byId(doc, "nav-team"), nav?.team);
}

function renderAccount(doc: Document, account: Chrome["account"], lang: Lang): void {
  byId(doc, "account").hidden = account === null;
  byId(doc, "account-text").textContent = account === null ? "" : account.login === null ? dt(lang, "fromAgent") : `@${account.login}`;
  byId(doc, "your-teams").hidden = !account?.teams;
  byId(doc, "sign-out").hidden = !account?.signOut;
}

/** On a hosted server or the demo the brand links to `/`; a self-hosted dashboard keeps it as plain text. */
export function linkBrand(doc: Document): void {
  const brand = doc.querySelector("header .brand");
  brand?.replaceChildren(h(doc, "a", { class: "brand-link", href: "/" }, brand.textContent ?? ""));
}

/** Draws `chrome` into the header; the team's name and the login go in as text. */
export function renderChrome(doc: Document, chrome: Chrome, lang: Lang): void {
  applyDashText(doc, lang);
  byId(doc, "team-name").hidden = chrome.teamName === null;
  byId(doc, "team-name-text").textContent = chrome.teamName ?? "";
  renderNav(doc, chrome.nav);
  renderAccount(doc, chrome.account, lang);
  byId(doc, "sample").hidden = !chrome.sample;
}
