import type { Stats } from "@teamusage/shared";
import { agentIcon, agentName } from "./agents.js";
import { dailyAgentTotals, rankAgents } from "./chart.js";
import { h, type Child } from "./dom.js";
import { pct } from "./dashboard/member-facts.js";
import { availableTotal, isActive, type Filters } from "./filters.js";
import { compact, full, usd } from "./format.js";
import { t, type Lang } from "./i18n.js";

/** The row of tiles at the top of the team view and of a member's page. */

export function tile(doc: Document, label: string, value: Child[], sub: string, hint?: string): HTMLElement {
  const v = h(doc, "div", { class: "v" }, ...value);
  if (hint) v.title = hint;
  return h(doc, "div", { class: "panel tile" }, h(doc, "div", { class: "k" }, label), v, h(doc, "div", { class: "s" }, sub));
}

/** "N of M", with the "of M" quieter. */
export const nOfM = (doc: Document, lang: Lang, n: number, m: number): Child[] => [String(n), " ", h(doc, "span", { class: "of" }, t(lang, "ofN", { n: m }))];

/** Characters of a figure that still fit half a row of tiles on a 320 px phone. */
const HALF_ROW_FIGURE = 10;

/**
 * The cost's tile. `--chars`, the figure's length, lets style.css shrink the figure until it fits the tile; a figure
 * longer than HALF_ROW_FIGURE also marks the tile `long`, and style.css gives it a whole row on a phone.
 */
function costTile(doc: Document, lang: Lang, cost: string, filtered: boolean): HTMLElement {
  const el = tile(doc, t(lang, filtered ? "tileCostFiltered" : "tileCost"), [cost], t(lang, "apiPrices"));
  el.classList.add("cost");
  el.style.setProperty("--chars", String(cost.length));
  el.classList.toggle("long", cost.length > HALF_ROW_FIGURE);
  return el;
}

interface TileContext {
  filters: Filters;
  /** "team" or "member": changes the wording of the shares. */
  view: "team" | "member";
  /** The first tile's sub-line when no filter is on. */
  firstSub: string;
}

/** Total tokens, cost, a third tile that depends on the view, and the most used agent. */
export function tiles(doc: Document, stats: Stats, lang: Lang, third: HTMLElement, ctx: TileContext): HTMLElement {
  const filtered = isActive(ctx.filters);
  const totals = dailyAgentTotals(stats.daily);
  const topAgent = rankAgents(totals)[0];
  const tokens = stats.totals.tokens;
  const first = filtered ? t(lang, "ofAllInPeriod", { n: pct(tokens, availableTotal(stats.available)) }) : ctx.firstSub;
  const agentShare = topAgent === undefined ? 0 : pct(totals.get(topAgent) ?? 0, tokens);
  const agentSub = filtered ? "ofFiltered" : ctx.view === "team" ? "share" : "ofTheirs";
  return h(
    doc,
    "div",
    { class: "tiles" },
    tile(doc, t(lang, filtered ? "tileTokensFiltered" : "tileTokens"), [compact(tokens)], first, full(tokens)),
    costTile(doc, lang, usd(stats.totals.costUsd), filtered),
    third,
    topAgent === undefined || tokens <= 0
      ? tile(doc, t(lang, "tileTopAgent"), ["—"], "")
      : tile(doc, t(lang, "tileTopAgent"), [agentIcon(doc, topAgent), h(doc, "span", { class: "tile-text" }, agentName(topAgent))], t(lang, agentSub, { n: agentShare })),
  );
}
