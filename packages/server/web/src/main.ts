import { presetRange, type Stats } from "@teamusage/shared";
import { checkRange, fetchStats, login } from "./api.js";
import { localIsoDate, longDate } from "./format.js";
import { loadLang, locale, pickLang, saveLang, t, type Lang, type MessageKey } from "./i18n.js";
import { applyStaticText, renderStats } from "./render.js";

/** Wires state and events. All drawing goes through `paint()`, so a language switch re-renders everything. */

type Preset = 30 | 90 | 180;
type Message = { key: MessageKey; vars?: Record<string, string | number> };

const PRESETS: readonly Preset[] = [30, 90, 180];

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const ui = {
  sub: byId("sub"),
  range: byId("range"),
  from: byId<HTMLInputElement>("from"),
  to: byId<HTMLInputElement>("to"),
  rangeMsg: byId("range-msg"),
  lang: byId("lang"),
  status: byId("status"),
  statusText: byId("status-text"),
  retry: byId<HTMLButtonElement>("retry"),
  login: byId("login"),
  loginForm: byId<HTMLFormElement>("login-form"),
  invite: byId<HTMLInputElement>("invite"),
  loginMsg: byId("login-msg"),
  stats: byId("stats"),
};

const state: {
  lang: Lang;
  preset: Preset | null;
  from: string;
  to: string;
  view: "stats" | "login";
  stats: Stats | null;
  request: AbortController | null;
  status: Message | null;
  rangeMsg: Message | null;
  loginMsg: Message | null;
} = {
  lang: pickLang(loadLang(), navigator.language),
  preset: null,
  from: "",
  to: "",
  view: "stats",
  stats: null,
  request: null,
  status: null,
  rangeMsg: null,
  loginMsg: null,
};

const today = () => localIsoDate(new Date());

function showMessage(el: HTMLElement, msg: Message | null): void {
  el.hidden = msg === null;
  el.textContent = msg === null ? "" : t(state.lang, msg.key, msg.vars);
}

function paint(): void {
  const { lang } = state;
  applyStaticText(document, lang);
  for (const b of ui.range.querySelectorAll<HTMLElement>("button[data-days]")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.days) === state.preset));
  }
  for (const b of ui.lang.querySelectorAll<HTMLElement>("button[data-lang]")) {
    b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  }
  ui.sub.textContent = state.from && state.to ? `${longDate(state.from, locale(lang))} – ${longDate(state.to, locale(lang))}` : "";
  showMessage(ui.rangeMsg, state.rangeMsg);
  showMessage(ui.statusText, state.status);
  ui.status.hidden = state.status === null;
  showMessage(ui.loginMsg, state.loginMsg);
  ui.login.hidden = state.view !== "login";
  ui.stats.hidden = state.view === "login";
  if (state.stats !== null) ui.stats.replaceChildren(renderStats(document, state.stats, lang, today()));
}

function setBusy(busy: boolean): void {
  ui.stats.classList.toggle("loading", busy);
  ui.stats.setAttribute("aria-busy", String(busy));
}

/** Loads the current range. The previous numbers stay on screen, dimmed, until the answer arrives. */
async function load(): Promise<void> {
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  setBusy(true);
  const res = await fetchStats(state.from, state.to, request.signal);
  if (state.request !== request) return; // a newer request took over
  state.request = null;
  setBusy(false);
  switch (res.kind) {
    case "ok":
      state.stats = res.stats;
      state.view = "stats";
      state.status = null;
      break;
    case "unauthorized":
      state.view = "login";
      state.status = null;
      break;
    case "network":
      state.status = { key: "netError" };
      break;
    case "error":
      state.status = { key: "loadFailed", vars: { error: res.message } };
      break;
    case "aborted":
      return;
  }
  paint();
}

function selectPreset(days: Preset): void {
  const r = presetRange(days, today());
  state.preset = days;
  state.from = r.from;
  state.to = r.to;
  state.rangeMsg = null;
  ui.from.value = r.from;
  ui.to.value = r.to;
  paint();
  void load();
}

function onCustomRange(): void {
  const from = ui.from.value;
  const to = ui.to.value;
  const check = checkRange(from, to);
  if (check === "incomplete") return;
  if (check !== "ok") {
    state.rangeMsg = { key: check === "order" ? "rangeOrder" : "rangeTooLong" };
    paint();
    return;
  }
  state.preset = null;
  state.from = from;
  state.to = to;
  state.rangeMsg = null;
  paint();
  void load();
}

async function onLogin(event: Event): Promise<void> {
  event.preventDefault();
  // The code lives only in this local variable and the request body.
  const code = ui.invite.value;
  ui.invite.value = "";
  if (code === "") return;
  const submit = ui.loginForm.querySelector<HTMLButtonElement>("button[type=submit]");
  if (submit) submit.disabled = true;
  const res = await login(code);
  if (submit) submit.disabled = false;
  switch (res.kind) {
    case "ok":
      state.loginMsg = null;
      paint();
      await load();
      return;
    case "wrong":
      state.loginMsg = { key: "loginWrong" };
      break;
    case "tooMany": {
      const minutes = Math.max(1, Math.ceil(res.retryAfterSec / 60));
      state.loginMsg = minutes === 1 ? { key: "loginTooMany1" } : { key: "loginTooMany", vars: { n: minutes } };
      break;
    }
    case "network":
      state.loginMsg = { key: "netError" };
      break;
    case "error":
      state.loginMsg = { key: "loginFailed" };
      break;
  }
  paint();
  ui.invite.focus();
}

ui.range.addEventListener("click", (e) => {
  const button = (e.target as Element | null)?.closest<HTMLElement>("button[data-days]");
  const days = Number(button?.dataset.days);
  if (PRESETS.includes(days as Preset)) selectPreset(days as Preset);
});
ui.from.addEventListener("change", onCustomRange);
ui.to.addEventListener("change", onCustomRange);
ui.lang.addEventListener("click", (e) => {
  const value = (e.target as Element | null)?.closest<HTMLElement>("button[data-lang]")?.dataset.lang;
  if (value !== "en" && value !== "ru") return;
  state.lang = value;
  saveLang(value);
  paint();
});
ui.retry.addEventListener("click", () => void load());
ui.loginForm.addEventListener("submit", (e) => void onLogin(e));

selectPreset(90);
