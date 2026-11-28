import type { Stats } from "@teamusage/shared";
import { accountPlanName } from "./accounts.js";
import { agentIcon, agentName, OTHER_SERIES, SERIES, otherAgentsIcon } from "./agents.js";
import { dailyAgentTotals, buckets, drawChart, presentSeries, WEEKLY_AFTER_DAYS } from "./chart.js";
import { counted, h, icon, type Child } from "./dom.js";
import { membersPanel, newTable, type MembersTable } from "./dashboard/members-panel.js";
import { byAccountPlanOf, lastSync, pct, STALE_DAYS, sumOf } from "./dashboard/member-facts.js";
import { isActive, NO_FILTERS, type Filters } from "./filters.js";
import { compact, daysSince, full, initials, longDate, shortDate, usd } from "./format.js";
import { count, locale, messages, t, type Lang, type MessageKey } from "./i18n.js";
import { nOfM, tile, tiles } from "./render.tiles.js";

/**
 * Builds the page body from a Stats. Every value, from the server or not, goes in as a text node or an attribute
 * value; nothing here is ever parsed as HTML. Classes come from fixed lists, never from server values, and inline
 * styles carry only numbers.
 */

const isKey = (k: string | null): k is MessageKey => k !== null && Object.hasOwn(messages.en, k);

/** Fills every `data-i18n` (text) and `data-i18n-label` (aria-label) element, the title and `<html lang>`. */
export function applyStaticText(doc: Document, lang: Lang): void {
  doc.documentElement.lang = lang;
  doc.title = t(lang, "title");
  for (const el of doc.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    if (isKey(key)) el.textContent = t(lang, key);
  }
  for (const el of doc.querySelectorAll("[data-i18n-label]")) {
    const key = el.getAttribute("data-i18n-label");
    if (isKey(key)) el.setAttribute("aria-label", t(lang, key));
  }
}

function headCell(doc: Document, label: string, left: boolean, sorted: boolean): HTMLElement {
  const attrs: Record<string, string> = { scope: "col" };
  if (left) attrs.class = "l";
  if (sorted) attrs["aria-sort"] = "descending";
  return h(doc, "th", attrs, label, ...(sorted ? [h(doc, "span", { class: "sort", "aria-hidden": "true" }, "↓")] : []));
}

function panel(doc: Document, heading: Child[], headingId: string, ...children: Child[]): HTMLElement {
  return h(doc, "section", { class: "panel", "aria-labelledby": headingId }, h(doc, "h2", { id: headingId }, ...heading), ...children);
}

/** The agent's tile and name, for tables and the legend. */
const agentLabel = (doc: Document, agent: string): HTMLElement =>
  h(doc, "span", { class: "agent" }, agentIcon(doc, agent), h(doc, "span", { class: "agent-name" }, agentName(agent)));

function modelsTable(doc: Document, stats: Stats, lang: Lang): HTMLElement {
  // Largest first, as the API sends them; a stable sort keeps the API order for ties.
  const rows = [...stats.models].sort((a, b) => b.total - a.total);
  const body = rows.map((m) => {
    const model = h(doc, "td", { class: "l" }, h(doc, "span", { class: "model-name" }, m.model));
    if (m.unpriced) model.append(h(doc, "span", { class: "unpriced", title: t(lang, "unpricedHint") }, t(lang, "unpriced")));
    return h(
      doc,
      "tr",
      {},
      h(doc, "td", { class: "l" }, agentLabel(doc, m.agent)),
      model,
      ...[m.input, m.output, m.cacheCreate, m.cacheRead].map((n) => h(doc, "td", {}, full(n))),
      h(doc, "td", { class: "strong" }, full(m.total)),
      h(doc, "td", {}, usd(m.costUsd)),
    );
  });
  const keys = ["colAgent", "colModel", "colInput", "colOutput", "colCacheCreate", "colCacheRead", "colTokens", "colCost"] as const;
  const head = h(doc, "thead", {}, h(doc, "tr", {}, ...keys.map((k, i) => headCell(doc, t(lang, k), i < 2, k === "colTokens"))));
  return h(doc, "table", { id: "models" }, head, h(doc, "tbody", {}, ...body));
}

function chartPanel(doc: Document, stats: Stats, lang: Lang): HTMLElement {
  const loc = locale(lang);
  const names = [...SERIES.map(agentName), t(lang, "otherAgents")];
  const legend = h(
    doc,
    "div",
    { class: "legend" },
    ...presentSeries(dailyAgentTotals(stats.daily)).map((i) =>
      h(doc, "span", {}, i === OTHER_SERIES ? otherAgentsIcon(doc) : agentIcon(doc, SERIES[i] as string), h(doc, "span", { class: "legend-name" }, names[i] ?? "")),
    ),
  );
  const chart = drawChart(doc, buckets(stats.daily), {
    names,
    label: (iso) => shortDate(iso, loc),
    ariaLabel: t(lang, "chartAlt", { from: longDate(stats.from, loc), to: longDate(stats.to, loc), total: full(stats.totals.tokens) }),
  });
  const weekly = stats.daily.length > WEEKLY_AFTER_DAYS;
  return h(
    doc,
    "section",
    { class: "panel", "aria-labelledby": "chart-heading" },
    h(doc, "div", { class: "panel-head" }, h(doc, "h2", { id: "chart-heading" }, t(lang, weekly ? "chartWeekly" : "chartDaily")), legend),
    chart,
  );
}

/** Nothing to show: with a filter on, says so and offers Clear filters (`#empty-clear`, wired by main). */
function emptyState(doc: Document, lang: Lang, filters: Filters): HTMLElement {
  if (!isActive(filters)) return h(doc, "div", { class: "panel empty" }, t(lang, "empty"));
  return h(
    doc,
    "div",
    { class: "panel empty" },
    h(doc, "p", {}, t(lang, "emptyFiltered")),
    h(doc, "button", { type: "button", id: "empty-clear", class: "link" }, t(lang, "clearFilters")),
  );
}

const modelsPanel = (doc: Document, stats: Stats, lang: Lang) =>
  panel(doc, [t(lang, "models")], "models-heading", h(doc, "div", { class: "scroll" }, modelsTable(doc, stats, lang)));

/** The Active members sub-line: what the members counted did, naming the narrowest filter that is on. */
function activeSub(f: Filters): MessageKey {
  if (!isActive(f)) return "sentUsage";
  if (f.models.length > 0) return "usedSelectedModels";
  if (f.agents.length > 0) return "usedSelectedAgents";
  if (f.accounts.length > 0) return "usedSelectedAccounts";
  return "usedSelectedPlans";
}

/** The team view: tiles, then the chart and tables, or the empty state when nothing matches. */
export function renderStats(doc: Document, stats: Stats, lang: Lang, today: string, opts: { query?: string; filters?: Filters; table?: MembersTable } = {}): DocumentFragment {
  const filters = opts.filters ?? NO_FILTERS;
  const days = Math.max(1, stats.daily.length);
  const active = tile(
    doc,
    t(lang, "tileActiveMembers"),
    nOfM(doc, lang, stats.totals.activeMembers, stats.totals.memberCount),
    t(lang, activeSub(filters)),
  );
  const out = doc.createDocumentFragment();
  out.append(tiles(doc, stats, lang, active, { filters, view: "team", firstSub: t(lang, "perDay", { n: compact(stats.totals.tokens / days) }) }));
  if (stats.totals.tokens <= 0) {
    out.append(emptyState(doc, lang, filters));
    return out;
  }
  out.append(chartPanel(doc, stats, lang), membersPanel(doc, stats, lang, today, { query: opts.query ?? "", filtered: isActive(filters), table: opts.table ?? newTable() }), modelsPanel(doc, stats, lang));
  return out;
}

/** The way back to the team view. */
export function renderBackLink(doc: Document, lang: Lang): HTMLElement {
  return h(doc, "nav", { class: "crumbs", "aria-label": t(lang, "breadcrumb") }, h(doc, "a", { class: "back", href: "#/" }, icon(doc, "left"), t(lang, "allMembers")));
}

/** Above the filter bar on a member's page: the way back, the avatar, the name and one line about them. */
export function renderMemberHead(doc: Document, stats: Stats, id: number, lang: Lang, today: string): HTMLElement {
  const member = stats.members.find((m) => m.id === id);
  const parts: string[] = [];
  if (member) {
    const sync = lastSync(lang, member.lastSyncAt, today);
    parts.push(member.email, count(lang, "machines", member.machines), sync.days === null ? t(lang, "neverSyncedLine") : t(lang, "lastSyncLine", { when: sync.text }));
  }
  return h(
    doc,
    "div",
    { class: "page-head-in" },
    renderBackLink(doc, lang),
    h(
      doc,
      "div",
      { class: "member-head" },
      h(doc, "span", { class: "avatar big", "aria-hidden": "true" }, initials(member?.name ?? "")),
      h(doc, "div", { class: "member-id" }, h(doc, "h2", { id: "member-heading" }, member?.name ?? "—"), h(doc, "p", { class: "member-sub" }, parts.join(" · "))),
    ),
  );
}

function machineStatus(doc: Document, lang: Lang, at: string | null, today: string): { pill: HTMLElement; note: string } {
  const days = at === null ? null : daysSince(at, today);
  const pill = (good: boolean, text: string) => h(doc, "span", { class: good ? "status-pill good" : "status-pill warn" }, icon(doc, good ? "check" : "warn"), text);
  if (days === null) return { pill: pill(false, t(lang, "neverSynced")), note: "" };
  if (days >= STALE_DAYS) return { pill: pill(false, count(lang, "noSyncDays", days)), note: t(lang, "notCounted") };
  const text = days === 0 ? t(lang, "syncedToday") : days === 1 ? t(lang, "syncedYesterday") : count(lang, "syncedDaysAgo", days);
  return { pill: pill(true, text), note: "" };
}

function machinesPanel(doc: Document, stats: Stats, lang: Lang, today: string): HTMLElement {
  const machines = stats.machines ?? [];
  const heading = counted(doc, lang, t(lang, "machinesHeading"), machines.length);
  if (machines.length === 0) return panel(doc, heading, "machines-heading", h(doc, "p", { class: "machines-none" }, t(lang, "noMachines")));
  const items = machines.map((m) => {
    const { pill, note } = machineStatus(doc, lang, m.lastSyncAt, today);
    const text = h(doc, "div", { class: "machine-text" }, h(doc, "span", { class: "machine-label" }, m.label));
    if (note) text.append(h(doc, "span", { class: "machine-note" }, note));
    return h(doc, "li", {}, h(doc, "span", { class: "machine-icon", "aria-hidden": "true" }, icon(doc, "machine")), text, pill);
  });
  return panel(doc, heading, "machines-heading", h(doc, "ul", { id: "machines", class: "machines" }, ...items));
}

/** "By account" on a member's page: name, tokens and share of the member's tokens, largest first; null when none. */
function accountsPanel(doc: Document, stats: Stats, id: number, lang: Lang): HTMLElement | null {
  const member = stats.members.find((m) => m.id === id);
  const parts = member === undefined ? [] : byAccountPlanOf(member);
  if (parts.length === 0) return null;
  const total = sumOf(parts);
  const items = parts.map(([key, plan, n]) =>
    h(
      doc,
      "li",
      {},
      h(doc, "span", { class: "acct-name" }, accountPlanName(key, plan, lang)),
      h(doc, "span", { class: "acct-tokens" }, full(n)),
      h(doc, "span", { class: "acct-share" }, `${pct(n, total)}%`),
    ),
  );
  return panel(doc, [t(lang, "byAccount")], "accounts-heading", h(doc, "ul", { id: "accounts", class: "accounts" }, ...items));
}

/** One member's page below the filter bar: tiles, the chart, their agents and models, accounts, and their machines. */
export function renderMember(
  doc: Document,
  stats: Stats,
  id: number,
  lang: Lang,
  today: string,
  opts: { filters?: Filters; teamTokens?: number | null } = {},
): DocumentFragment {
  const filters = opts.filters ?? NO_FILTERS;
  const activeDays = stats.daily.filter((d) => Object.values(d.byAgent).reduce((a, n) => a + n, 0) > 0).length;
  // The share of the team only when it is known for this period; otherwise no guess.
  const team = opts.teamTokens ?? null;
  const firstSub = team !== null && team > 0 ? t(lang, "teamShare", { n: pct(stats.totals.tokens, team) }) : "";
  const out = doc.createDocumentFragment();
  out.append(
    tiles(doc, stats, lang, tile(doc, t(lang, "tileActiveDays"), nOfM(doc, lang, activeDays, stats.daily.length), t(lang, "activeDaysSub")), {
      filters,
      view: "member",
      firstSub,
    }),
  );
  if (stats.totals.tokens <= 0) {
    out.append(emptyState(doc, lang, filters), machinesPanel(doc, stats, lang, today));
    return out;
  }
  out.append(chartPanel(doc, stats, lang), modelsPanel(doc, stats, lang));
  const accounts = accountsPanel(doc, stats, id, lang);
  if (accounts) out.append(accounts);
  out.append(machinesPanel(doc, stats, lang, today));
  return out;
}

/** The member asked for does not exist. */
export function renderNotFound(doc: Document, lang: Lang): DocumentFragment {
  const out = doc.createDocumentFragment();
  out.append(h(doc, "div", { class: "panel empty" }, t(lang, "notFound")));
  return out;
}
