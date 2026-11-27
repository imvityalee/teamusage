import type { Lang } from "../lang.js";
import { paintAccount } from "../site/account.js";
import { request } from "../site/http.js";
import { applyText, languageSwitch, translator } from "../site/i18n.js";
import { me, signInDidNotFinish, signOut, type MeAnswer } from "../site/session.js";
import { showView } from "../site/views.js";
import { formView } from "./form-view.js";
import { drawTeams, paintOwned } from "./list-view.js";
import { strings } from "./strings.js";
import { teamsView, type TeamsView } from "./teams.js";

/** `/teams`, where GitHub sign-in lands: asks who is signed in, then shows a sign-in panel, the team picker or the form to name a team. */

const t = translator(strings);
const byId = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const ui = {
  views: Array.from(document.querySelectorAll<HTMLElement>("[data-view]")),
  signInNotice: byId("signin-notice"),
  memberText: byId("member-text"),
  teamList: byId("team-list"),
  ownedLine: byId("owned-line"),
  createLink: byId("create-link"),
  backToTeams: byId("back-to-teams"),
  signOut: byId<HTMLButtonElement>("sign-out"),
  signOutError: byId("signout-error"),
  retry: byId("retry"),
};

/** The notice of a sign-in that did not finish is read once and then taken out of the address, so a reload does not repeat it. */
const signInFailed = signInDidNotFinish(location.search);
if (location.search !== "") history.replaceState(null, "", location.pathname + location.hash);

let lang: Lang = languageSwitch(document, (next) => {
  lang = next;
  paint();
});
/** Null until `me()` has answered. */
let session: MeAnswer | null = null;
let view: TeamsView | "loading" = "loading";
let signingOut = false;
let signOutFailed = false;

const form = formView({
  doc: document,
  t,
  lang: () => lang,
  request,
  assign: (path) => location.assign(path),
  onSignedOut: () => {
    session = { kind: "none" };
    route();
  },
});

/** The teams of a GitHub user's session; none for anyone else. */
function teamsOf(answer: MeAnswer | null) {
  return answer?.kind === "me" && answer.me.kind === "user" ? answer.me.teams : [];
}

function paint(): void {
  applyText(document, strings, lang, "title");
  showView(ui.views, view);
  ui.signInNotice.hidden = !(signInFailed && view === "signedOut");
  ui.memberText.textContent =
    session?.kind === "me" && session.me.kind === "member" ? t(lang, "memberText", { team: session.me.team.name }) : "";
  const teams = teamsOf(session);
  drawTeams(ui.teamList, teams, t, lang);
  paintOwned(ui.ownedLine, ui.createLink, teams.filter((team) => team.role === "owner").length, t, lang);
  ui.backToTeams.hidden = teams.length === 0;
  paintAccount(document, session?.kind === "me" && session.me.kind === "user" ? session.me.login : null);
  ui.signOut.disabled = signingOut;
  ui.signOut.setAttribute("aria-busy", String(signingOut));
  ui.signOutError.hidden = !signOutFailed;
  form.paint();
}

/** Shows the view this session and fragment call for, or moves the browser on: `replace` keeps Back from bouncing forward. */
function route(): void {
  if (session === null) return;
  const decision = teamsView(session, location.hash);
  if ("go" in decision) {
    location.replace(decision.go);
    return;
  }
  view = decision.view;
  paint();
}

async function load(): Promise<void> {
  session = null;
  view = "loading";
  paint();
  session = await me();
  route();
}

/** One request at a time: the button is disabled while it is out. If the session may still be there the person stays, with the button back and a sentence saying so. */
async function leave(): Promise<void> {
  signingOut = true;
  signOutFailed = false;
  paint();
  if (await signOut()) return location.assign("/");
  signingOut = false;
  signOutFailed = true;
  paint();
  ui.signOut.focus();
}

/** A second failure hides the button that was pressed, which a browser answers by dropping focus, so it is put back. */
async function retry(): Promise<void> {
  await load();
  if (view === "failed") ui.retry.focus();
}

ui.signOut.addEventListener("click", () => void leave());
ui.retry.addEventListener("click", () => void retry());
window.addEventListener("hashchange", route);
void load();
