import type { Stats } from "@teamusage/shared";
import { accountPlanName } from "../accounts.js";
import { agentName, SERIES_CLASS, seriesOf } from "../agents.js";
import { h, icon } from "../dom.js";
import { full, initials, usd } from "../format.js";
import { t, type Lang } from "../i18n.js";
import { isMemberId, memberHref } from "../route.js";
import { agentMixOf, byAccountPlanOf, lastSync, pct, STALE_DAYS, sumOf } from "./member-facts.js";

/** The rows of the members table: who, tokens, cost, the agent mix, the accounts and the last sync. Every value is drawn as text. */

/** Accounts shown per member in the table; the rest are counted as "+N". */
const ACCOUNT_LINES = 2;

/** "Team · Devcats 78%" lines, at most two, then "+N"; a dash when there is nothing to show. Text only. */
function accountsCell(doc: Document, lang: Lang, m: Stats["members"][number]): HTMLElement {
  const parts = byAccountPlanOf(m);
  const cell = h(doc, "td", { class: "l accts-cell" });
  if (parts.length === 0) {
    cell.textContent = "—";
    return cell;
  }
  const total = sumOf(parts);
  const lines = parts
    .slice(0, ACCOUNT_LINES)
    .map(([key, plan, n]) => h(doc, "li", {}, h(doc, "span", { class: "acct-name" }, accountPlanName(key, plan, lang)), " ", h(doc, "span", { class: "acct-share" }, `${pct(n, total)}%`)));
  if (parts.length > ACCOUNT_LINES) lines.push(h(doc, "li", { class: "acct-more" }, `+${parts.length - ACCOUNT_LINES}`));
  cell.append(h(doc, "ul", { class: "accts" }, ...lines));
  return cell;
}

/** The fixed five first in their order, then the others by tokens. */
function mixOrder(mix: Map<string, number>): [string, number][] {
  return [...mix].sort((a, b) => seriesOf(a[0]) - seriesOf(b[0]) || b[1] - a[1]);
}

/**
 * The agent-mix bar: its length is the member's share of the top member's tokens, its segments the member's
 * tokens by agent in agent colours.
 */
function mixBar(doc: Document, lang: Lang, m: Stats["members"][number], top: number, teamTokens: number, filtered: boolean): HTMLElement {
  const bar = h(doc, "div", { class: "mix-bar" });
  bar.style.width = `${top > 0 ? Number(((m.tokens / top) * 100).toFixed(1)) : 0}%`;
  const share = pct(m.tokens, teamTokens);
  const parts = mixOrder(agentMixOf(m));
  const total = parts.reduce((s, [, n]) => s + n, 0);
  // One segment per series, so all agents outside the fixed five share one grey segment.
  const bySeries = new Map<number, number>();
  for (const [agent, n] of parts) bySeries.set(seriesOf(agent), (bySeries.get(seriesOf(agent)) ?? 0) + n);
  for (const [series, n] of [...bySeries].sort((a, b) => a[0] - b[0])) {
    const seg = h(doc, "i", { class: SERIES_CLASS[series] as string });
    seg.style.flexGrow = (n / total).toFixed(4);
    bar.append(seg);
  }
  const label =
    parts.length === 0
      ? t(lang, filtered ? "shareLabelFiltered" : "shareLabel", { share })
      : t(lang, filtered ? "mixLabelFiltered" : "mixLabel", { share, parts: parts.map(([agent, n]) => `${agentName(agent)} ${pct(n, total)}%`).join(", ") });
  return h(doc, "div", { class: "mix", role: "img", "aria-label": label }, bar);
}

export function memberRows(doc: Document, stats: Stats, lang: Lang, today: string, shown: Stats["members"], filtered: boolean): HTMLElement[] {
  // Bars scale to the top member of the whole team, so they do not jump while searching, sorting or paging.
  const top = stats.members.reduce((most, m) => Math.max(most, m.tokens), 0);
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
      h(doc, "td", { class: "l" }, mixBar(doc, lang, m, top, stats.totals.tokens, filtered)),
      accountsCell(doc, lang, m),
      h(doc, "td", stale ? { class: "stale" } : {}, sync.text),
      h(doc, "td", { class: "chev-cell", "aria-hidden": "true" }, icon(doc, "right")),
    );
  });
}
