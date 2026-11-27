import { h } from "../dom.js";
import type { Lang } from "../lang.js";
import { SIGN_IN_PATH } from "../site/session.js";
import { YOUR_TEAMS, type Panel } from "./chrome.js";
import { dt, type DashKey } from "./strings.js";

/** What the dashboard shows instead of the statistics on a hosted server: nobody signed in, or a team that is not theirs. */

/** GitHub sign-in lands on `/teams`, where the person picks the team whose dashboard to open. */
const GITHUB_SIGN_IN = `${SIGN_IN_PATH}?${new URLSearchParams({ to: "teams" })}`;

/** An element holding the message of `key`, marked with it so that `applyDashText` can rewrite it in place. */
type Keyed = (tag: string, key: DashKey, attrs?: Record<string, string>) => HTMLElement;

function signedOut(doc: Document, keyed: Keyed): HTMLElement[] {
  return [
    keyed("h2", "signedOutTitle"),
    h(doc, "div", { class: "actions" }, keyed("a", "signInGithub", { class: "btn", href: GITHUB_SIGN_IN })),
    h(doc, "p", { class: "aside" }, keyed("span", "memberPrompt"), " ", keyed("a", "openFromAgent", { href: "/open" })),
  ];
}

function noTeam(doc: Document, keyed: Keyed): HTMLElement[] {
  return [keyed("h2", "noTeam"), h(doc, "p", { class: "aside" }, keyed("a", "yourTeams", { href: YOUR_TEAMS }))];
}

/**
 * The panel, in a wrapper that announces it: it can appear without a navigation, after a 401 or a 404. Its texts carry
 * `data-dash`, so a language switch rewrites them in place instead of drawing a new panel that is announced again.
 */
export function renderSignedOut(doc: Document, lang: Lang, panel: Panel): HTMLElement {
  const keyed: Keyed = (tag, key, attrs = {}) => h(doc, tag, { ...attrs, "data-dash": key }, dt(lang, key));
  return h(doc, "div", { role: "alert" }, ...(panel === "signedOut" ? signedOut(doc, keyed) : noTeam(doc, keyed)));
}
