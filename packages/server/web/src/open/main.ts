import { initials } from "../format.js";
import type { Lang } from "../i18n.js";
import { request } from "../site/http.js";
import { applyText, languageSwitch } from "../site/i18n.js";
import { me } from "../site/session.js";
import { opener, tokenOf, type OpenView } from "./open.js";
import { strings } from "./strings.js";

/** `/open`: reads the link's token, takes it out of the address before any request, and draws what the opener decides. */

/** How long the link's opening runs before its text is drawn, so a normal opening shows no flash of text. */
const OPENING_DELAY_MS = 400;

const token = tokenOf(location.hash);
history.replaceState(null, "", "/open");

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const ui = {
  views: Array.from(document.querySelectorAll<HTMLElement>("[data-view]")),
  parts: Array.from(document.querySelectorAll<HTMLElement>("[data-views]")),
  login: byId("login"),
  initials: byId("initials"),
  githubLine: byId("gh-line"),
  codeLine: byId("code-line"),
};

let lang: Lang = languageSwitch(document, (next) => {
  lang = next;
  paint();
});
/** True once the opening has run for OPENING_DELAY_MS. */
let openingDrawn = false;
let openingTimer: ReturnType<typeof setTimeout> | undefined;

const go = (path: "/" | "/dashboard" | "/teams"): void => location.replace(path);
const state = opener({ token, me, request, go });

/** Starts the delay of the opening's text when the view becomes "opening", and drops it when the view moves on. */
function timeOpening(view: OpenView): void {
  if (view !== "opening") {
    clearTimeout(openingTimer);
    openingTimer = undefined;
    openingDrawn = false;
  } else if (openingTimer === undefined) {
    openingTimer = setTimeout(() => {
      openingDrawn = true;
      paint();
    }, OPENING_DELAY_MS);
  }
}

/** A part of the page is shown in the views it names; of the two sign-in lines, the one this server offers. */
function partShown(el: HTMLElement, view: OpenView): boolean {
  if (!(el.dataset.views ?? "").split(" ").includes(view)) return false;
  if (el === ui.githubLine) return !state.noAccounts;
  if (el === ui.codeLine) return state.noAccounts;
  return true;
}

function paint(): void {
  const { view } = state;
  applyText(document, strings, lang, "title");
  for (const el of ui.views) el.hidden = el.dataset.view !== view || (view === "opening" && !openingDrawn);
  for (const el of ui.parts) el.hidden = !partShown(el, view);
  const login = state.login ?? "";
  ui.login.textContent = `@${login}`;
  ui.initials.textContent = initials(login.replace(/[-_]+/g, " "));
}

function onViewChange(): void {
  timeOpening(state.view);
  paint();
}

state.onChange(onViewChange);
byId("open-member").addEventListener("click", () => void state.open());
byId("retry").addEventListener("click", () => void state.open());
// The link is left to expire: nothing is sent.
byId("stay").addEventListener("click", () => go("/teams"));
onViewChange();
