import type { Stats } from "@teamusage/shared";
import { agentTotals, buckets, drawChart, rankAgents, slotOf, WEEKLY_AFTER_DAYS } from "./chart.js";
import { agentName, compact, daysSince, full, longDate, shortDate, usd } from "./format.js";
import { locale, messages, t, type Lang, type MessageKey } from "./i18n.js";

/**
 * Builds the DOM from a Stats. Elements are created one by one and every value, from the server or not,
 * goes in as a text node or an attribute value; nothing here is ever parsed as HTML.
 */

type Child = Node | string;

function h(doc: Document, tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

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

function tile(doc: Document, label: string, value: string, sub: string, hint?: string): HTMLElement {
  const v = h(doc, "div", { class: "v" }, value);
  if (hint) v.title = hint;
  return h(doc, "div", { class: "panel tile" }, h(doc, "div", { class: "k" }, label), v, h(doc, "div", { class: "s" }, sub));
}

function lastSync(lang: Lang, at: string | null, today: string): string {
  const days = at === null ? null : daysSince(at, today);
  if (days === null) return "—";
  if (days === 0) return t(lang, "today");
  if (days === 1) return t(lang, "yesterday");
  return t(lang, "daysAgo", { n: days });
}

function headRow(doc: Document, labels: string[], leftAligned: number[]): HTMLElement {
  return h(
    doc,
    "thead",
    {},
    h(doc, "tr", {}, ...labels.map((l, i) => h(doc, "th", { scope: "col", ...(leftAligned.includes(i) ? { class: "l" } : {}) }, l))),
  );
}

function panel(doc: Document, heading: string, headingId: string, ...children: Child[]): HTMLElement {
  return h(doc, "section", { class: "panel", "aria-labelledby": headingId }, h(doc, "h2", { id: headingId }, heading), ...children);
}

function membersTable(doc: Document, stats: Stats, lang: Lang, today: string): HTMLElement {
  const top = stats.members[0]?.tokens ?? 0;
  const body = stats.members.map((m) => {
    const width = top > 0 ? Number(((m.tokens / top) * 100).toFixed(1)) : 0;
    const bar = h(doc, "div", { class: "bar", "aria-hidden": "true" }, h(doc, "i"));
    (bar.firstChild as HTMLElement).style.width = `${width}%`;
    const share = stats.totals.tokens > 0 ? Math.round((m.tokens / stats.totals.tokens) * 100) : 0;
    return h(
      doc,
      "tr",
      {},
      h(doc, "th", { scope: "row", class: "who" }, h(doc, "b", {}, m.name), h(doc, "span", {}, m.email)),
      h(doc, "td", {}, full(m.tokens)),
      h(doc, "td", {}, usd(m.costUsd)),
      h(doc, "td", { class: "l" }, bar, h(doc, "span", { class: "sr" }, `${share}%`)),
      h(doc, "td", {}, String(m.machines)),
      h(doc, "td", {}, lastSync(lang, m.lastSyncAt, today)),
    );
  });
  const labels = (["mh0", "mh1", "mh2", "mh3", "mh4", "mh5"] as const).map((k) => t(lang, k));
  return h(doc, "table", { id: "members" }, headRow(doc, labels, [0, 3]), h(doc, "tbody", {}, ...body));
}

function modelsTable(doc: Document, stats: Stats, lang: Lang, ranked: string[]): HTMLElement {
  const rank = (agent: string) => {
    const i = ranked.indexOf(agent);
    return i < 0 ? ranked.length : i;
  };
  // Stable sort: within an agent the API order (by tokens) stays.
  const rows = [...stats.models].sort((a, b) => rank(a.agent) - rank(b.agent));
  const body = rows.map((m) => {
    const model = h(doc, "td", { class: "l" }, m.model);
    if (m.unpriced) {
      model.append(h(doc, "span", { class: "unpriced", title: t(lang, "unpricedHint") }, t(lang, "unpriced")));
    }
    return h(
      doc,
      "tr",
      {},
      h(doc, "td", {}, h(doc, "i", { class: `dot s${slotOf(m.agent, ranked)}`, "aria-hidden": "true" }), agentName(m.agent)),
      model,
      ...[m.input, m.output, m.cacheCreate, m.cacheRead, m.total].map((n) => h(doc, "td", {}, full(n))),
      h(doc, "td", {}, usd(m.costUsd)),
    );
  });
  const labels = (["oh0", "oh1", "oh2", "oh3", "oh4", "oh5", "oh6", "oh7"] as const).map((k) => t(lang, k));
  return h(doc, "table", { id: "models" }, headRow(doc, labels, [0, 1]), h(doc, "tbody", {}, ...body));
}

/** Tiles, then the chart and tables, or the empty state when nothing was used in the range. */
export function renderStats(doc: Document, stats: Stats, lang: Lang, today: string): DocumentFragment {
  const loc = locale(lang);
  const totals = agentTotals(stats.daily);
  const ranked = rankAgents(totals);
  const topAgent = ranked[0];
  const days = Math.max(1, stats.daily.length);
  const out = doc.createDocumentFragment();

  out.append(
    h(
      doc,
      "div",
      { class: "tiles" },
      tile(doc, t(lang, "k0"), compact(stats.totals.tokens), t(lang, "perDay", { n: compact(stats.totals.tokens / days) }), full(stats.totals.tokens)),
      tile(doc, t(lang, "k1"), usd(stats.totals.costUsd), t(lang, "apiPrices")),
      tile(doc, t(lang, "k2"), String(stats.totals.activeMembers), t(lang, "ofN", { n: stats.totals.memberCount })),
      topAgent === undefined || stats.totals.tokens <= 0
        ? tile(doc, t(lang, "k3"), "—", "")
        : tile(
            doc,
            t(lang, "k3"),
            agentName(topAgent),
            t(lang, "share", { n: Math.round(((totals.get(topAgent) ?? 0) / stats.totals.tokens) * 100) }),
          ),
    ),
  );

  if (stats.totals.tokens <= 0) {
    out.append(h(doc, "div", { class: "panel empty" }, t(lang, "empty")));
    return out;
  }

  const seriesNames = ranked.slice(0, 4).map(agentName);
  if (ranked.length > 4) seriesNames.push(t(lang, "others"));
  const legend = h(
    doc,
    "div",
    { class: "legend" },
    ...seriesNames.map((name, slot) => h(doc, "span", {}, h(doc, "i", { class: `dot s${slot}`, "aria-hidden": "true" }), name)),
  );
  const chart = drawChart(doc, buckets(stats.daily), {
    ranked,
    seriesNames,
    label: (iso) => shortDate(iso, loc),
    ariaLabel: t(lang, "chartAlt", { from: longDate(stats.from, loc), to: longDate(stats.to, loc), total: full(stats.totals.tokens) }),
  });
  const weekly = stats.daily.length > WEEKLY_AFTER_DAYS;

  out.append(
    panel(doc, t(lang, weekly ? "chartWeekly" : "chartDaily"), "chart-heading", legend, chart),
    h(
      doc,
      "div",
      { class: "grid2" },
      panel(doc, t(lang, "members"), "members-heading", h(doc, "div", { class: "scroll" }, membersTable(doc, stats, lang, today))),
      panel(doc, t(lang, "models"), "models-heading", h(doc, "div", { class: "scroll" }, modelsTable(doc, stats, lang, ranked))),
    ),
  );
  return out;
}
