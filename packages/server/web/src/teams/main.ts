import { initials } from "../format.js";
import type { Lang } from "../lang.js";
import { request } from "../site/http.js";
import { applyText, languageSwitch, translator } from "../site/i18n.js";
import { me, signOut, type MeAnswer } from "../site/session.js";
import { formView } from "./form-view.js";
import { drawTeams, paintOwned } from "./list-view.js";
import { strings } from "./strings.js";
import { teamsView, type TeamsView } from "./teams.js";

/** `/teams`, where GitHub sign-in lands: asks who is signed in, then shows a sign-in panel, the team picker or the form to name a team. */

const t = translator(strings);
const byId = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const ui = {
  views: Array.from(document.querySelectorAll<HTMLElement>("[data-view]")),
  account: byId("account"),
  login: byId("login"),
  initials: byId("initials"),
  signInNotice: byId("signin-notice"),
  memberText: byId("member-text"),
  teamList: byId("team-list"),
  ownedLine: byId("owned-line"),
  createLink: byId("create-link"),
  backToTeams: byId("back-to-teams"),
};

/** The notice of a sign-in that did not finish is read once and then taken out of the address, so a reload does not repeat it. */
const signInFailed = new URLSearchParams(location.search).get("error") === "signin";
if (location.search !== "") history.replaceState(null, "", location.pathname + location.hash);

let lang: Lang = languageSwitch(document, (next) => {
  lang = next;
  paint();
});
/** Null until `me()` has answered. */
let session: MeAnswer | null = null;
let view: TeamsView | "loading" = "loading";

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

function paintAccount(): void {
  const user = session?.kind === "me" && session.me.kind === "user" ? session.me : null;
  ui.account.hidden = user === null;
  ui.login.textContent = user === null ? "" : `@${user.login}`;
  ui.initials.textContent = user === null ? "" : initials(user.login.replace(/[-_]+/g, " "));
}

function paint(): void {
  applyText(document, strings, lang, "title");
  for (const el of ui.views) el.hidden = el.dataset.view !== view;
  ui.signInNotice.hidden = !(signInFailed && view === "signedOut");
  ui.memberText.textContent =
    session?.kind === "me" && session.me.kind === "member" ? t(lang, "memberText", { team: session.me.team.name }) : "";
  const teams = teamsOf(session);
  drawTeams(ui.teamList, teams, t, lang);
  paintOwned(ui.ownedLine, ui.createLink, teams.filter((team) => team.role === "owner").length, t, lang);
  ui.backToTeams.hidden = teams.length === 0;
  paintAccount();
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

byId("sign-out").addEventListener("click", () => void signOut().then(() => location.assign("/")));
byId("retry").addEventListener("click", () => void load());
window.addEventListener("hashchange", route);
void load();
