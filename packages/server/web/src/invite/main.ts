import { initials } from "../format.js";
import type { Lang } from "../lang.js";
import { request } from "../site/http.js";
import { applyText, languageSwitch, translator } from "../site/i18n.js";
import { me, signInDidNotFinish, signOut } from "../site/session.js";
import { listsView, showView } from "../site/views.js";
import { expiryDay } from "./answers.js";
import { inviter, takeToken } from "./invite.js";
import { strings } from "./strings.js";

/** `/invite`: takes the invitation's token out of the address before any request, then draws what the inviter decides. */

const token = takeToken(location.hash, sessionStorage);
/** The notice of a sign-in that did not finish is read once; the address loses it with the token. */
let signInFailed = signInDidNotFinish(location.search);
history.replaceState(null, "", "/invite");

const t = translator(strings);
const byId = <E extends HTMLElement>(id: string) => document.getElementById(id) as E;
const ui = {
  views: Array.from(document.querySelectorAll<HTMLElement>("[data-view]")),
  parts: Array.from(document.querySelectorAll<HTMLElement>("[data-views]")),
  title: byId("invite-title"),
  roleNote: byId("role-note"),
  expiryNote: byId("expiry-note"),
  signInNotice: byId("signin-notice"),
  switchLine: byId("switch-line"),
  signIn: byId("sign-in"),
  signOutError: byId("signout-error"),
  login: byId("login"),
  initials: byId("initials"),
  useAnother: byId<HTMLButtonElement>("use-another"),
  accept: byId<HTMLButtonElement>("accept"),
  hasRoleText: byId("has-role-text"),
  retry: byId<HTMLButtonElement>("retry"),
};

let lang: Lang = languageSwitch(document, (next) => {
  lang = next;
  paint();
});

const state = inviter({ token, storage: sessionStorage, me, request, signOut, go: (path) => location.replace(path), onChange: () => paint() });

/** The heading, the role's note and the last day, from the preview. */
function paintInvite(): void {
  const { preview } = state;
  const team = preview?.team.name ?? "";
  ui.title.textContent = preview === null ? "" : t(lang, preview.role === "admin" ? "joinAdmin" : "joinViewer", { team });
  ui.roleNote.textContent = preview === null ? "" : t(lang, preview.role === "admin" ? "roleAdmin" : "roleViewer");
  ui.expiryNote.textContent = preview === null ? "" : t(lang, "expiryNote", { day: expiryDay(preview.expiresAt, lang) });
  ui.hasRoleText.textContent = t(lang, "hasRoleText", { login: state.login ?? "", team });
}

/** The signed-in account and the button that gives it the role. */
function paintAccount(): void {
  const login = state.login ?? "";
  ui.login.textContent = `@${login}`;
  ui.initials.textContent = initials(login.replace(/[-_]+/g, " "));
  ui.accept.textContent = t(lang, "acceptAs", { login });
}

/** While a press is answered both buttons wait, so neither can send a second request. */
function paintBusy(): void {
  for (const b of [ui.accept, ui.useAnother]) {
    b.disabled = state.busy;
    b.setAttribute("aria-busy", String(state.busy));
  }
}

function paint(): void {
  const view = state.loading ? "loading" : state.view;
  applyText(document, strings, lang, "title");
  showView(ui.views, view);
  for (const el of ui.parts) el.hidden = !listsView(el, view);
  ui.signInNotice.hidden = !signInFailed;
  ui.switchLine.hidden = !state.switchAccount;
  ui.signOutError.hidden = !state.signOutFailed;
  paintInvite();
  paintAccount();
  paintBusy();
}

/** After a sign-out the GitHub button takes focus; after one that failed, the button that was pressed gets it back. */
async function useAnotherAccount(): Promise<void> {
  signInFailed = false;
  await state.useAnotherAccount();
  if (state.view === "signIn") ui.signIn.focus();
  else if (state.signOutFailed) ui.useAnother.focus();
}

/** A second failure hides the button that was pressed, which a browser answers by dropping focus, so it is put back. */
async function retry(): Promise<void> {
  await state.retry();
  if (state.view === "failed") ui.retry.focus();
}

ui.accept.addEventListener("click", () => void state.accept());
ui.useAnother.addEventListener("click", () => void useAnotherAccount());
ui.retry.addEventListener("click", () => void retry());
paint();
