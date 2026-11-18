import type { Stats } from "@teamusage/shared";
import { agentIcon, agentName, OTHER_SERIES, SERIES, SERIES_CLASS, otherAgentsIcon, seriesOf } from "./agents.js";
import { agentTotals, buckets, drawChart, presentSeries, rankAgents, WEEKLY_AFTER_DAYS } from "./chart.js";
import { h, icon, type Child } from "./dom.js";
import { availableTotal, isActive, NO_FILTERS, type Filters } from "./filters.js";
import { compact, daysSince, full, initials, longDate, shortDate, usd } from "./format.js";
import { count, locale, matchCount, messages, t, type Lang, type MessageKey } from "./i18n.js";
import { isMemberId, memberHref } from "./route.js";
import { matchMembers } from "./search.js";

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

const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const STALE_DAYS = 7;

function tile(doc: Document, label: string, value: Child[], sub: string, hint?: string): HTMLElement {
  const v = h(doc, "div", { class: "v" }, ...value);
  if (hint) v.title = hint;
  return h(doc, "div", { class: "panel tile" }, h(doc, "div", { class: "k" }, label), v, h(doc, "div", { class: "s" }, sub));
}

/** "N of M", with the "of M" quieter. */
const nOfM = (doc: Document, lang: Lang, n: number, m: number): Child[] => [String(n), " ", h(doc, "span", { class: "of" }, t(lang, "ofN", { n: m }))];

function lastSync(lang: Lang, at: string | null, today: string): { text: string; days: number | null } {
  const days = at === null ? null : daysSince(at, today);
  if (days === null) return { text: "—", days };
  if (days === 0) return { text: t(lang, "today"), days };
  if (days === 1) return { text: t(lang, "yesterday"), days };
  return { text: count(lang, "daysAgo", days), days };
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

/** "Members 3": the heading with its count. */
const counted = (doc: Document, label: string, n: number): Child[] => [label, " ", h(doc, "span", { class: "n" }, String(n))];

/** A member's tokens by agent when the server sends them (newer servers), as a Map; null otherwise. */
function byAgentOf(m: Stats["members"][number]): Map<string, number> | null {
  const v = (m as { byAgent?: unknown }).byAgent;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out = new Map<string, number>();
  for (const [agent, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n) && n > 0) out.set(agent, n);
  return out;
}

/** The fixed five first in their order, then the others by tokens. */
function mixOrder(mix: Map<string, number>): [string, number][] {
  return [...mix].sort((a, b) => seriesOf(a[0]) - seriesOf(b[0]) || b[1] - a[1]);
}

/**
 * The agent-mix bar: its length is the member's share of the top member's tokens, its segments the member's
 * tokens by agent in agent colours. Without per-agent numbers it is a plain share bar.
 */
function mixBar(doc: Document, lang: Lang, m: Stats["members"][number], top: number, teamTokens: number): HTMLElement {
  const bar = h(doc, "div", { class: "mix-bar" });
  bar.style.width = `${top > 0 ? Number(((m.tokens / top) * 100).toFixed(1)) : 0}%`;
  const share = pct(m.tokens, teamTokens);
  const mix = byAgentOf(m);
  let label = t(lang, "shareLabel", { share });
  if (mix === null) {
    if (m.tokens > 0) bar.append(h(doc, "i", { class: "share" }));
  } else {
    const parts = mixOrder(mix);
    const total = parts.reduce((s, [, n]) => s + n, 0);
    // One segment per series, so all agents outside the fixed five share one grey segment.
    const bySeries = new Map<number, number>();
    for (const [agent, n] of parts) bySeries.set(seriesOf(agent), (bySeries.get(seriesOf(agent)) ?? 0) + n);
    for (const [series, n] of [...bySeries].sort((a, b) => a[0] - b[0])) {
      const seg = h(doc, "i", { class: SERIES_CLASS[series] as string });
      seg.style.flexGrow = (n / total).toFixed(4);
      bar.append(seg);
    }
    if (parts.length > 0) {
      label = t(lang, "mixLabel", { share, parts: parts.map(([agent, n]) => `${agentName(agent)} ${pct(n, total)}%`).join(", ") });
    }
  }
  return h(doc, "div", { class: "mix", role: "img", "aria-label": label }, bar);
}

function memberRows(doc: Document, stats: Stats, lang: Lang, today: string, shown: Stats["members"]): HTMLElement[] {
  // Bars scale to the top member of the whole team, so they do not jump while searching.
  const top = stats.members[0]?.tokens ?? 0;
  return shown.map((m) => {
    // The href comes from the numeric id alone; a name or any other string never reaches it.
    const name = isMemberId(m.id) ? h(doc, "a", { href: memberHref(m.id) }, m.name) : h(doc, "b", {}, m.name);
    const sync = lastSync(lang, m.lastSyncAt, today);
    const stale = sync.days !== null && sync.days >= STALE_DAYS;
    return h(
      doc,
      "tr",
      {},
      h(
        doc,
        "th",
        { scope: "row", class: "who" },
        h(
          doc,
          "span",
          { class: "who-in" },
          h(doc, "span", { class: "avatar", "aria-hidden": "true" }, initials(m.name)),
          h(doc, "span", { class: "who-text" }, name, h(doc, "span", { class: "email" }, m.email)),
        ),
      ),
      h(doc, "td", {}, full(m.tokens)),
      h(doc, "td", {}, usd(m.costUsd)),
      h(doc, "td", { class: "l" }, mixBar(doc, lang, m, top, stats.totals.tokens)),
      h(doc, "td", stale ? { class: "stale" } : {}, sync.text),
      h(doc, "td", { class: "chev-cell", "aria-hidden": "true" }, icon(doc, "right")),
    );
  });
}

/** Shows the members matching `query` in an already rendered members panel, without rebuilding the search box. */
export function applyMemberSearch(doc: Document, root: ParentNode, stats: Stats, lang: Lang, today: string, query: string): void {
  const table = root.querySelector("#members");
  const body = table?.querySelector("tbody");
  const countLine = root.querySelector<HTMLElement>("#members-count");
  const scroll = table?.parentElement;
  if (!body || !countLine || !scroll) return;
  const shown = matchMembers(stats.members, query);
  body.replaceChildren(...memberRows(doc, stats, lang, today, shown));
  const filtering = query.trim() !== "";
  countLine.hidden = !filtering;
  countLine.textContent = !filtering ? "" : shown.length === 0 ? t(lang, "noMatch") : matchCount(lang, shown.length, stats.members.length);
  scroll.hidden = shown.length === 0;
}

function membersPanel(doc: Document, stats: Stats, lang: Lang, today: string, query: string): HTMLElement {
  const input = h(doc, "input", { type: "search", id: "member-search", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  input.placeholder = t(lang, "searchPlaceholder");
  input.value = query; // a property, never markup
  const hasMix = stats.members.length > 0 && stats.members.every((m) => byAgentOf(m) !== null);
  const head = h(
    doc,
    "thead",
    {},
    h(
      doc,
      "tr",
      {},
      headCell(doc, t(lang, "mh0"), true, false),
      headCell(doc, t(lang, "mh1"), false, true),
      headCell(doc, t(lang, "mh2"), false, false),
      headCell(doc, t(lang, hasMix ? "mixHead" : "mh3"), true, false),
      headCell(doc, t(lang, "mh5"), false, false),
      h(doc, "td", { class: "chev-cell", "aria-hidden": "true" }),
    ),
  );
  const table = h(doc, "table", { id: "members" }, head, h(doc, "tbody"));
  const section = h(
    doc,
    "section",
    { class: "panel", "aria-labelledby": "members-heading" },
    h(
      doc,
      "div",
      { class: "panel-head" },
      h(doc, "div", {}, h(doc, "h2", { id: "members-heading" }, ...counted(doc, t(lang, "members"), stats.members.length)), h(doc, "p", { class: "hint" }, t(lang, "membersHint"))),
      h(doc, "div", { class: "search" }, h(doc, "label", { for: "member-search", class: "sr" }, t(lang, "searchMembers")), icon(doc, "search", "search-icon"), input),
    ),
    h(doc, "p", { id: "members-count", class: "count", "aria-live": "polite" }),
    h(doc, "div", { class: "scroll" }, table),
  );
  if (hasMix) section.append(h(doc, "p", { class: "mix-note" }, t(lang, "mixNote")));
  applyMemberSearch(doc, section, stats, lang, today, query);
  return section;
}

/** The agent's tile and name, for tables and the legend. */
const agentLabel = (doc: Document, agent: string): HTMLElement =>
  h(doc, "span", { class: "agent" }, agentIcon(doc, agent), h(doc, "span", { class: "agent-name" }, agentName(agent)));

function modelsTable(doc: Document, stats: Stats, lang: Lang): HTMLElement {
  // Largest first, as the API sends them; a stable sort keeps the API order for ties.
  const rows = [...stats.models].sort((a, b) => b.total - a.total);
  const body = rows.map((m) => {
    const model = h(doc, "td", { class: "l" }, m.model);
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
  const keys = ["oh0", "oh1", "oh2", "oh3", "oh4", "oh5", "oh6", "oh7"] as const;
  const head = h(doc, "thead", {}, h(doc, "tr", {}, ...keys.map((k, i) => headCell(doc, t(lang, k), i < 2, k === "oh6"))));
  return h(doc, "table", { id: "models" }, head, h(doc, "tbody", {}, ...body));
}

interface TileContext {
  filters: Filters;
  /** "team" or "member": changes the wording of the shares. */
  view: "team" | "member";
  /** The first tile's sub-line when no filter is on. */
  firstSub: string;
}

/** Total tokens, cost, a third tile that depends on the view, and the most used agent. */
function tiles(doc: Document, stats: Stats, lang: Lang, third: HTMLElement, ctx: TileContext): HTMLElement {
  const filtered = isActive(ctx.filters);
  const totals = agentTotals(stats.daily);
  const topAgent = rankAgents(totals)[0];
  const tokens = stats.totals.tokens;
  const first = filtered ? t(lang, "ofAllInPeriod", { n: pct(tokens, availableTotal(stats.available)) }) : ctx.firstSub;
  const agentShare = topAgent === undefined ? 0 : pct(totals.get(topAgent) ?? 0, tokens);
  const agentSub = filtered ? "ofFiltered" : ctx.view === "team" ? "share" : "ofTheirs";
  return h(
    doc,
    "div",
    { class: "tiles" },
    tile(doc, t(lang, filtered ? "k0f" : "k0"), [compact(tokens)], first, full(tokens)),
    tile(doc, t(lang, filtered ? "k1f" : "k1"), [usd(stats.totals.costUsd)], t(lang, "apiPrices")),
    third,
    topAgent === undefined || tokens <= 0
      ? tile(doc, t(lang, "k3"), ["—"], "")
      : tile(doc, t(lang, "k3"), [agentIcon(doc, topAgent), h(doc, "span", { class: "tile-text" }, agentName(topAgent))], t(lang, agentSub, { n: agentShare })),
  );
}

function chartPanel(doc: Document, stats: Stats, lang: Lang): HTMLElement {
  const loc = locale(lang);
  const names = [...SERIES.map(agentName), t(lang, "otherAgents")];
  const legend = h(
    doc,
    "div",
    { class: "legend" },
    ...presentSeries(agentTotals(stats.daily)).map((i) =>
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

/** The team view: tiles, then the chart and tables, or the empty state when nothing matches. */
export function renderStats(doc: Document, stats: Stats, lang: Lang, today: string, opts: { query?: string; filters?: Filters } = {}): DocumentFragment {
  const filters = opts.filters ?? NO_FILTERS;
  const days = Math.max(1, stats.daily.length);
  const active = tile(
    doc,
    t(lang, "k2"),
    nOfM(doc, lang, stats.totals.activeMembers, stats.totals.memberCount),
    t(lang, !isActive(filters) ? "sentUsage" : filters.models.length > 0 ? "usedSelectedModels" : "usedSelectedAgents"),
  );
  const out = doc.createDocumentFragment();
  out.append(tiles(doc, stats, lang, active, { filters, view: "team", firstSub: t(lang, "perDay", { n: compact(stats.totals.tokens / days) }) }));
  if (stats.totals.tokens <= 0) {
    out.append(emptyState(doc, lang, filters));
    return out;
  }
  out.append(chartPanel(doc, stats, lang), membersPanel(doc, stats, lang, today, opts.query ?? ""), modelsPanel(doc, stats, lang));
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
  const heading = counted(doc, t(lang, "mh4"), machines.length);
  if (machines.length === 0) return panel(doc, heading, "machines-heading", h(doc, "p", { class: "machines-none" }, t(lang, "noMachines")));
  const items = machines.map((m) => {
    const { pill, note } = machineStatus(doc, lang, m.lastSyncAt, today);
    const text = h(doc, "div", { class: "machine-text" }, h(doc, "span", { class: "machine-label" }, m.label));
    if (note) text.append(h(doc, "span", { class: "machine-note" }, note));
    return h(doc, "li", {}, h(doc, "span", { class: "machine-icon", "aria-hidden": "true" }, icon(doc, "machine")), text, pill);
  });
  return panel(doc, heading, "machines-heading", h(doc, "ul", { id: "machines", class: "machines" }, ...items));
}

/** One member's page below the filter bar: tiles, the chart, their agents and models, and their machines. */
export function renderMember(
  doc: Document,
  stats: Stats,
  id: number,
  lang: Lang,
  today: string,
  opts: { filters?: Filters; teamTokens?: number | null } = {},
): DocumentFragment {
  const filters = opts.filters ?? NO_FILTERS;
  const member = stats.members.find((m) => m.id === id);
  const activeDays = stats.daily.filter((d) => Object.values(d.byAgent).reduce((a, n) => a + n, 0) > 0).length;
  // The share of the team only when it is known for this period; otherwise no guess.
  const team = opts.teamTokens ?? null;
  const firstSub = team !== null && team > 0 ? t(lang, "teamShare", { n: pct(stats.totals.tokens, team) }) : "";
  const out = doc.createDocumentFragment();
  out.append(
    tiles(doc, stats, lang, tile(doc, t(lang, "k4"), nOfM(doc, lang, activeDays, stats.daily.length), t(lang, "activeDaysSub")), {
      filters,
      view: "member",
      firstSub,
    }),
  );
  if (stats.totals.tokens <= 0) {
    out.append(emptyState(doc, lang, filters), machinesPanel(doc, stats, lang, today));
    return out;
  }
  out.append(chartPanel(doc, stats, lang), modelsPanel(doc, stats, lang), machinesPanel(doc, stats, lang, today));
  return out;
}

/** The member asked for does not exist. */
export function renderNotFound(doc: Document, lang: Lang): DocumentFragment {
  const out = doc.createDocumentFragment();
  out.append(h(doc, "div", { class: "panel empty" }, t(lang, "notFound")));
  return out;
}
