import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { SIGN_IN_PATH } from "../site/session.js";
import { YOUR_TEAMS, type Panel } from "./chrome.js";
import { dt } from "./strings.js";

/** What the dashboard shows instead of the statistics on a hosted server: nobody signed in, or a team that is not theirs. */

/** GitHub sign-in lands on `/teams`, where the person picks the team whose dashboard to open. */
const GITHUB_SIGN_IN = `${SIGN_IN_PATH}?${new URLSearchParams({ to: "teams" })}`;

function signedOut(doc: Document, lang: Lang): HTMLElement[] {
  return [
    h(doc, "h2", {}, dt(lang, "signedOutTitle")),
    h(doc, "div", { class: "actions" }, h(doc, "a", { class: "btn", href: GITHUB_SIGN_IN }, dt(lang, "signInGithub"))),
    h(doc, "p", { class: "aside" }, dt(lang, "memberPrompt"), " ", h(doc, "a", { href: "/open" }, dt(lang, "openFromAgent"))),
  ];
}

function noTeam(doc: Document, lang: Lang): HTMLElement[] {
  return [h(doc, "h2", {}, dt(lang, "noTeam")), h(doc, "p", { class: "aside" }, h(doc, "a", { href: YOUR_TEAMS }, dt(lang, "yourTeams")))];
}

/** The panel, in a wrapper that announces it: it can appear without a navigation, after a 401 or a 404. */
export function renderSignedOut(doc: Document, lang: Lang, panel: Panel): HTMLElement {
  const content = panel === "signedOut" ? signedOut(doc, lang) : noTeam(doc, lang);
  return h(doc, "div", { role: "alert" }, ...content);
}
