import { localIsoDate } from "@teamusage/shared";
import type { Lang } from "../lang.js";
import { paintAccount } from "../site/account.js";
import type { ApiResult } from "../site/http.js";
import { applyText, languageSwitch } from "../site/i18n.js";
import { me } from "../site/session.js";
import { signOutButton } from "../site/sign-out.js";
import { renderTeamNav, teamNav } from "../site/team-nav.js";
import { dashboardPath, teamParam } from "../site/team-param.js";
import { showView } from "../site/views.js";
import { accessCard } from "./access-card.js";
import { getTeam, type TeamInfo } from "./api.js";
import type { Card, TeamContext } from "./card.js";
import { codeCard, type CodeCard } from "./code-card.js";
import { deleteCard } from "./delete-card.js";
import { failureText } from "./failure.js";
import { inviteMessage } from "./invite-message.js";
import { startView, type TeamPageView } from "./page-view.js";
import { membersCard, type MembersCard } from "./members-card.js";
import { removalFlow, type RemovalFlow } from "./removal-flow.js";
import { rolesCard } from "./roles-card.js";
import { strings, tt } from "./strings.js";
import { titleRow } from "./title-row.js";

/**
 * `/team?team=<id>`: reads the session and the team, then shows the cards to an owner or admin, or one panel. This
 * file only wires: each card is a module that takes the page's `TeamContext` and returns its element.
 */

const team = teamParam(location.search);
const byId = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const ui = {
  views: Array.from(document.querySelectorAll<HTMLElement>("[data-view]")),
  failedText: byId("failed-text"),
  retry: byId<HTMLButtonElement>("retry"),
  signIn: byId("sign-in"),
  viewerDashboard: byId("viewer-dashboard"),
  cards: byId("cards"),
};

let lang: Lang = languageSwitch(document, (next) => {
  lang = next;
  paint();
});
let view: TeamPageView | "loading" = team === null ? "notFound" : "loading";
let login: string | null = null;
let info: TeamInfo | null = null;
/** The answer that left the page `failed`. */
let failure: ApiResult<unknown> = { kind: "failed" };
let retrying = false;
let cards: Card[] = [];
/** The code card among `cards`: its code is dropped with them. */
let code: (CodeCard & Card) | null = null;
/** What the page does around a removal, with the members card it reads again. */
let removal: RemovalFlow | null = null;
let members: MembersCard | null = null;

const signOut = signOutButton(document, () => tt(lang, "signOutFailed"));

const ctx: TeamContext = {
  doc: document,
  lang: () => lang,
  team: () => info as TeamInfo,
  update(next) {
    info = next;
    paint();
  },
  signedOut: showSignedOut,
  reload: async () => {
    if (team !== null) await load(team);
  },
  go: (path) => location.replace(path),
};

/** The cards of an owner or admin, in the order of board 3. A card is added here with one line. */
function mountCards(githubId: number): void {
  const title = titleRow(ctx);
  code = codeCard(ctx);
  const roles = rolesCard(ctx, githubId);
  const today = () => localIsoDate(new Date());
  removal = removalFlow(ctx, { today, members: () => members, code: () => code });
  members = membersCard(ctx, { today, onRemove: removal.open, above: removal.status });
  cards = [title, code, inviteMessage(ctx), accessCard(ctx), roles, members, deleteCard(ctx)];
  ui.cards.replaceChildren(...cards.map((card) => card.element));
  title.element.after(members.summary);
}

/** Drops the cards, and with them the code they may hold. */
function dropCards(): void {
  code?.hide();
  code = null;
  removal = members = null;
  cards = [];
  ui.cards.replaceChildren();
}

function paint(): void {
  applyText(document, strings, lang, "title");
  if (view === "page" && info !== null) document.title = tt(lang, "teamTitle", { team: info.name });
  showView(ui.views, view);
  renderTeamNav(document, view === "page" && team !== null ? teamNav(team) : null);
  paintAccount(document, view === "signedOut" ? null : login);
  ui.failedText.textContent = failureText(lang, failure);
  ui.retry.disabled = retrying;
  if (team !== null) ui.viewerDashboard.setAttribute("href", dashboardPath(team));
  signOut.paint();
  for (const card of cards) card.paint();
  removal?.paint();
}

/** Reads the session and the team together; nothing else is asked before both have answered. */
async function load(team: string): Promise<void> {
  const [session, result] = await Promise.all([me(), getTeam(team)]);
  login = session.kind === "me" && session.me.kind === "user" ? session.me.login : null;
  view = startView(team, session, result);
  failure = session.kind === "me" || session.kind === "none" ? result : { kind: "failed" };
  info = result.kind === "ok" && (view === "page" || view === "viewer") ? result.value.team : null;
  dropCards();
  if (view === "page" && session.kind === "me" && session.me.kind === "user") mountCards(session.me.githubId);
  paint();
}

/** A 401 from any request: the sign-in panel, with focus on its GitHub button. */
function showSignedOut(): void {
  dropCards();
  view = "signedOut";
  paint();
  ui.signIn.focus();
}

/** One load at a time: Try again stays on screen, disabled, until the answer; a second failure gives it focus back. */
async function retry(): Promise<void> {
  if (team === null || retrying) return;
  retrying = true;
  paint();
  await load(team);
  retrying = false;
  paint();
  if (view === "failed") ui.retry.focus();
}

ui.retry.addEventListener("click", () => void retry());
paint();
if (team !== null) void load(team);
