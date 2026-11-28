import { checkRange, localIsoDate, MAX_RANGE_DAYS, presetRange, type Stats } from "@teamusage/shared";
import { fetchStats } from "./api.js";
import { busyRetry } from "./dashboard/busy-retry.js";
import type { Chrome } from "./dashboard/chrome.js";
import { dashboardFrame, type View } from "./dashboard/frame.js";
import { sourceOf, type Source } from "./dashboard/source.js";
import { dashboardStart } from "./dashboard/start.js";
import type { Text } from "./dashboard/strings.js";
import { FILTER_TEXT, fitPopover, renderChips, renderFilterControls, type FilterBarHandlers } from "./filterbar.js";
import {
  anyFilterEmptied,
  availableTotal,
  equalFilters,
  isActive,
  LIMITS,
  NO_FILTERS,
  prune,
  toggleAgent,
  toggleKey,
  toggleModel,
  type FilterKind,
  type Filters,
  type Toggled,
} from "./filters.js";
import { rangeText } from "./format.js";
import { loadLang, pickLang, saveLang, t, type Lang, type MessageKey } from "./i18n.js";
import { applyMemberSearch, newTable, type MembersTable } from "./dashboard/members-panel.js";
import { applyStaticText, renderBackLink, renderMember, renderMemberHead, renderNotFound, renderStats } from "./render.js";
import { parseRoute, type Route } from "./route.js";

/** Wires state and events. The source is chosen once at start; all drawing goes through `paint()`, so a language switch re-renders everything. */

type Preset = 30 | 90 | 180;
type Message = { key: MessageKey; vars?: Record<string, string | number> };
const say = (key: MessageKey, vars?: Message["vars"]): Text => (lang) => t(lang, key, vars);
/**
 * What `#stats` shows: the answer for the route and filters it was loaded for, which may lag the URL and the
 * filter bar while loading.
 */
type Shown =
  | { kind: "team"; stats: Stats; filters: Filters }
  | { kind: "member"; id: number; stats: Stats; filters: Filters }
  | { kind: "notFound" };

const PRESETS: readonly Preset[] = [30, 90, 180];
const NOTHING: Stats["available"] = { agents: [], models: [], accounts: [], plans: [] };

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
  stats: byId("stats"),
  pageHead: byId("page-head"),
  filterbar: byId("filterbar"),
  filterControls: byId("filter-controls"),
  chips: byId("chips"),
};

const state: {
  lang: Lang;
  preset: Preset | null;
  from: string;
  to: string;
  view: View;
  source: Source;
  /** The header; null until the session is read. */
  chrome: Chrome | null;
  route: Route;
  shown: Shown | null;
  /** The member search text. It lives only here and in the input: never sent, stored or put in the URL. */
  query: string;
  /** The members table's order and page; kept here so a repaint of the same statistics gives them back. */
  members: MembersTable;
  /** The agent, model, account and plan filters. Only here: sent as query parameters, never stored or put in the URL. */
  filters: Filters;
  open: FilterKind | null;
  /** The models search text: a plain substring match on the rows already drawn; never sent or stored. */
  modelQuery: string;
  note: Message | null;
  /** The team's unfiltered total for the last team period loaded, for "N% of the team's tokens". */
  team: { from: string; to: string; tokens: number } | null;
  request: AbortController | null;
  status: Text | null;
  rangeMsg: Message | null;
} = {
  lang: pickLang(loadLang(), navigator.language),
  preset: null,
  from: "",
  to: "",
  view: "waiting",
  source: sourceOf(location),
  chrome: null,
  route: parseRoute(location.hash),
  shown: null,
  query: "",
  members: newTable(),
  filters: NO_FILTERS,
  open: null,
  modelQuery: "",
  note: null,
  team: null,
  request: null,
  status: null,
  rangeMsg: null,
};

const today = () => localIsoDate(new Date());

function showMessage(el: HTMLElement, msg: Message | null): void {
  el.hidden = msg === null;
  el.textContent = msg === null ? "" : t(state.lang, msg.key, msg.vars);
}

/** Which button or field had focus inside a re-drawn area, so the same one gets it back. */
type FocusMemo = { zone: HTMLElement; index: number; id: string; selection: [number | null, number | null] | null } | null;
const FOCUSABLE = "button, input";

function rememberFocus(zones: HTMLElement[]): FocusMemo {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return null;
  const zone = zones.find((z) => z.contains(active));
  if (!zone) return null;
  const input = active as HTMLInputElement;
  return {
    zone,
    index: [...zone.querySelectorAll(FOCUSABLE)].indexOf(active),
    id: active.id,
    selection: active.tagName === "INPUT" && input.type === "search" ? [input.selectionStart, input.selectionEnd] : null,
  };
}

/** True while the page itself moves focus, so that move is not taken for the user leaving a popover. */
let movingFocus = false;

function focusQuietly(el: HTMLElement | null | undefined): void {
  if (!el) return;
  movingFocus = true;
  try {
    el.focus();
  } finally {
    movingFocus = false;
  }
}

function restoreFocus(memo: FocusMemo): void {
  if (memo === null) return;
  const all = [...memo.zone.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const target = (memo.id ? document.getElementById(memo.id) : null) ?? all[Math.min(memo.index, all.length - 1)] ?? document.getElementById("agents-btn");
  if (!target) return;
  focusQuietly(target);
  if (memo.selection && target instanceof HTMLInputElement) target.setSelectionRange(memo.selection[0], memo.selection[1]);
}

function availableShown(): Stats["available"] {
  const { shown } = state;
  return shown === null || shown.kind === "notFound" ? NOTHING : shown.stats.available;
}

/** The filter buttons, the open popover and the chips. */
function paintFilters(): void {
  const memo = rememberFocus([ui.filterControls, ui.chips]);
  const model = { available: availableShown(), filters: state.filters, open: state.open, modelQuery: state.modelQuery, note: state.note };
  ui.filterControls.replaceChildren(renderFilterControls(document, model, state.lang, handlers));
  const chips = renderChips(document, state.filters, state.lang, handlers);
  ui.chips.replaceChildren(...chips);
  ui.chips.hidden = chips.length === 0;
  restoreFocus(memo);
  fitPopover(ui.filterControls);
}

function teamTokensFor(stats: Stats): number | null {
  const { team } = state;
  return team !== null && team.from === stats.from && team.to === stats.to ? team.tokens : null;
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
  ui.sub.textContent = state.from && state.to ? rangeText(state.from, state.to, lang === "ru" ? "ru-RU" : "en-GB") : "";
  showMessage(ui.rangeMsg, state.rangeMsg);
  ui.statusText.textContent = state.status?.(lang) ?? "";
  ui.status.hidden = state.status === null;
  frame.paint(state.view, state.chrome);
  ui.stats.hidden = state.view !== "stats" && !(state.view === "waiting" && state.status === null);
  ui.filterbar.hidden = state.view !== "stats";
  ui.pageHead.hidden = state.view !== "stats";
  paintFilters();
  const { shown } = state;
  if (shown === null) return;
  // A load can finish while someone types in the search box; give them back the box they were typing in.
  const active = document.activeElement as HTMLInputElement | null;
  const typing = active?.id === "member-search" ? ([active.selectionStart, active.selectionEnd] as const) : null;
  switch (shown.kind) {
    case "team":
      ui.pageHead.replaceChildren();
      ui.stats.replaceChildren(renderStats(document, shown.stats, lang, today(), { query: state.query, filters: shown.filters, table: state.members }));
      break;
    case "member": {
      ui.pageHead.replaceChildren(renderMemberHead(document, shown.stats, shown.id, lang, today()));
      ui.stats.replaceChildren(
        renderMember(document, shown.stats, shown.id, lang, today(), { filters: shown.filters, teamTokens: teamTokensFor(shown.stats) }),
      );
      const name = shown.stats.members.find((m) => m.id === shown.id)?.name;
      if (name !== undefined && state.view === "stats") document.title = t(lang, "memberTitle", { name });
      break;
    }
    case "notFound":
      ui.pageHead.replaceChildren(renderBackLink(document, lang));
      ui.stats.replaceChildren(renderNotFound(document, lang));
      break;
  }
  const search = document.getElementById("member-search") as HTMLInputElement | null;
  if (typing && search) {
    search.focus();
    search.setSelectionRange(typing[0], typing[1]);
  }
}

function setBusy(busy: boolean): void {
  ui.stats.classList.toggle("loading", busy);
  ui.stats.setAttribute("aria-busy", String(busy));
}

/** Loads the current range, route and filters. The previous view stays on screen, dimmed, until the answer arrives. */
async function load(): Promise<void> {
  state.request?.abort();
  const request = new AbortController();
  state.request = request;
  const isRetry = retryBusy.begin();
  setBusy(true);
  const route = state.route;
  const filters = state.filters;
  const res = await fetchStats(state.from, state.to, request.signal, route.view === "member" ? route.id : undefined, filters, state.source);
  if (state.request !== request) return; // a newer request took over
  state.request = null;
  setBusy(false);
  switch (res.kind) {
    case "ok": {
      if (route.view === "member") {
        // A member's `available` is only theirs: the selection is shown as it was sent, never pruned against it.
        // A member with nothing for it gets the filtered empty state and its Clear filters action.
        state.query = "";
        state.shown = { kind: "member", id: route.id, stats: res.stats, filters };
      } else {
        // On the team view, a selection that no longer exists in this period is dropped. When that empties a
        // list, the answer was narrowed by a filter that is now gone, so ask again.
        const pruned = prune(filters, res.stats.available);
        state.filters = pruned;
        if (anyFilterEmptied(filters, pruned)) {
          void load();
          return;
        }
        state.team = { from: res.stats.from, to: res.stats.to, tokens: availableTotal(res.stats.available) };
        state.shown = { kind: "team", stats: res.stats, filters: pruned };
      }
      state.view = "stats";
      state.status = null;
      break;
    }
    case "notFound":
      state.query = "";
      state.shown = { kind: "notFound" };
      state.view = "stats";
      state.status = null;
      break;
    case "unauthorized":
      // A hosted team's dashboard is never opened with a code.
      return state.source.kind === "hosted" ? start.showPanel("signedOut") : start.showLogin();
    case "noTeam":
      return start.showPanel("noTeam");
    case "busy":
      state.status = retryBusy.answer(res.retryAfterSec, isRetry);
      keepFiltersOfShown();
      break;
    case "network":
      state.status = say("netError");
      keepFiltersOfShown();
      break;
    case "error":
      state.status = say("loadFailed", { error: res.message });
      keepFiltersOfShown();
      break;
    case "aborted":
      return;
  }
  paint();
}

/** After a failed load, the bar and chips go back to the selection the data on screen was loaded with. */
function keepFiltersOfShown(): void {
  const { shown } = state;
  if (shown !== null && shown.kind !== "notFound") state.filters = shown.filters;
}

/** A new filter applies at once: one request, with the usual abort of the one before. */
function setFilters(next: Filters): void {
  state.note = null;
  if (equalFilters(next, state.filters)) {
    paintFilters();
    return;
  }
  state.filters = next;
  paintFilters();
  void load();
}

function applyToggle(result: Toggled, kind: FilterKind): void {
  if (result.limited) {
    state.note = { key: FILTER_TEXT[kind].limit, vars: { n: LIMITS[kind] } };
    paintFilters();
    return;
  }
  setFilters(result.filters);
}

function closePopover(focusButton: boolean): void {
  const kind = state.open;
  if (kind === null) return;
  state.open = null;
  state.note = null;
  state.modelQuery = "";
  paintFilters();
  if (focusButton) focusQuietly(document.getElementById(`${kind}-btn`));
}

const handlers: FilterBarHandlers = {
  toggleOpen(kind) {
    if (state.open === kind) {
      closePopover(false);
      return;
    }
    state.open = kind;
    state.note = null;
    state.modelQuery = "";
    paintFilters();
    // Focus stays on the button that opened it; Tab then moves into the popover.
    focusQuietly(document.getElementById(`${kind}-btn`));
  },
  toggleAgent: (id) => applyToggle(toggleAgent(state.filters, id), "agents"),
  toggleModel: (ref) => applyToggle(toggleModel(state.filters, ref), "models"),
  toggleKey: (kind, key) => applyToggle(toggleKey(state.filters, kind, key), kind),
  showAll: (kind) => setFilters({ ...state.filters, [kind]: [] }),
  modelQuery: (query) => {
    state.modelQuery = query;
  },
  clear: () => {
    state.open = null;
    state.modelQuery = "";
    setFilters(NO_FILTERS);
  },
};

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
  if (check === "invalid") return; // a date field is still empty or half typed
  if (check !== "ok") {
    state.rangeMsg = check === "order" ? { key: "rangeOrder" } : { key: "rangeTooLong", vars: { n: MAX_RANGE_DAYS } };
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
// Filters the rows already on the page; no request.
ui.stats.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement | null;
  if (input?.id !== "member-search" || state.shown?.kind !== "team") return;
  state.query = input.value;
  applyMemberSearch(document, ui.stats, state.shown.stats, state.lang, today(), state.query, isActive(state.shown.filters));
});
// "Clear filters" in the empty state.
ui.stats.addEventListener("click", (e) => {
  if ((e.target as Element | null)?.closest?.("#empty-clear")) handlers.clear();
});

// Popovers: Escape closes and gives focus back to the button; a click or focus outside closes.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || state.open === null) return;
  e.preventDefault();
  closePopover(true);
});
function closeIfOutside(e: Event): void {
  if (state.open === null || movingFocus) return;
  const target = e.target as Node | null;
  // A target that is no longer in the page was inside a part that was just re-drawn.
  if (!target || !target.isConnected) return;
  const wrapper = document.getElementById(`${state.open}-btn`)?.parentElement;
  if (wrapper?.contains(target)) return;
  closePopover(false);
}
document.addEventListener("click", closeIfOutside);
document.addEventListener("focusin", closeIfOutside);
window.addEventListener("resize", () => fitPopover(ui.filterControls));

// Member links, the back link and the browser's Back arrive here (a reload reads the fragment at start).
// The fragment is parsed into a route, never used as is.
window.addEventListener("hashchange", () => {
  const route = parseRoute(location.hash);
  const same = route.view === state.route.view && (route.view === "team" || (state.route.view === "member" && route.id === state.route.id));
  if (same) return;
  state.route = route;
  void load();
});

const retryBusy = busyRetry(() => void load());
const frame = dashboardFrame(document, { lang: () => state.lang, signedIn: load, leaving: () => start.clearShown() });
const start = dashboardStart(document, state, { paint, ready: () => selectPreset(90), load: () => void load() });
void start.begin();
