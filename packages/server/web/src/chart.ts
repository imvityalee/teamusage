import type { Stats } from "@teamusage/shared";
import { compact, full } from "./format.js";

export interface Bucket {
  label: string;
  byAgent: Record<string, number>;
}

/** Ranges longer than this many days are drawn as weekly bars. */
export const WEEKLY_AFTER_DAYS = 90;

/** Daily when the range is 90 days or less, otherwise 7-day buckets labelled by their first date. */
export function buckets(daily: Stats["daily"]): Bucket[] {
  const step = daily.length > WEEKLY_AFTER_DAYS ? 7 : 1;
  const out: Bucket[] = [];
  for (let i = 0; i < daily.length; i += step) {
    // Agent ids are data: a Map plus fromEntries keeps `__proto__` an ordinary own key.
    const sums = new Map<string, number>();
    for (const day of daily.slice(i, i + step)) {
      for (const [agent, n] of Object.entries(day.byAgent)) sums.set(agent, (sums.get(agent) ?? 0) + n);
    }
    out.push({ label: daily[i]?.date ?? "", byAgent: Object.fromEntries(sums) as Record<string, number> });
  }
  return out;
}

/** Total tokens per agent over the days. */
export function agentTotals(daily: Stats["daily"]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const day of daily) {
    for (const [agent, n] of Object.entries(day.byAgent)) totals.set(agent, (totals.get(agent) ?? 0) + n);
  }
  return totals;
}

/** Agent ids with any tokens, largest total first; ties by id. */
export function rankAgents(totals: Map<string, number>): string[] {
  return [...totals]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id]) => id);
}

const OWN_COLOURS = 4;
/** The neutral colour slot shared by every agent past the top four. */
export const OTHERS_SLOT = OWN_COLOURS;

/** Colour slot 0–3 for the top four agents, 4 ("others") for the rest. */
export function slotOf(agent: string, ranked: string[]): number {
  const i = ranked.indexOf(agent);
  return i >= 0 && i < OWN_COLOURS ? i : OTHERS_SLOT;
}

export interface ChartOptions {
  /** Agents in rank order; the first is drawn at the bottom of each bar. */
  ranked: string[];
  /** Display name per colour slot, in slot order (the last may be "Others"). */
  seriesNames: string[];
  label: (bucketLabel: string) => string;
  ariaLabel: string;
}

const SVG = "http://www.w3.org/2000/svg";
const W = 900;
const H = 230;
const LEFT = 46;
const BOTTOM = 22;
const TOP = 8;
const X_LABELS = 8;

/** Stacked bars drawn as SVG elements. Every text, including tooltips, goes in as textContent. */
export function drawChart(doc: Document, data: Bucket[], opts: ChartOptions): SVGSVGElement {
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) => {
    const node = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });
  const series = data.map((b) => {
    const bySlot = opts.seriesNames.map(() => 0);
    for (const [agent, n] of Object.entries(b.byAgent)) {
      const slot = Math.min(slotOf(agent, opts.ranked), opts.seriesNames.length - 1);
      bySlot[slot] = (bySlot[slot] ?? 0) + n;
    }
    return bySlot;
  });
  const sums = series.map((s) => s.reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...sums) || 1;
  const plot = H - BOTTOM - TOP;

  for (let g = 0; g <= 3; g++) {
    const y = TOP + plot * (1 - g / 3);
    svg.append(
      el("line", { x1: LEFT, x2: W, y1: y, y2: y, class: "grid" }),
      el("text", { x: LEFT - 6, y: y + 4, "text-anchor": "end" }, compact((max * g) / 3)),
    );
  }

  const bw = (W - LEFT) / Math.max(1, data.length);
  const every = Math.ceil(data.length / X_LABELS);
  data.forEach((bucket, n) => {
    const label = opts.label(bucket.label);
    const bySlot = series[n] ?? [];
    const lines = bySlot.flatMap((v, slot) => (v > 0 ? [`${opts.seriesNames[slot]}: ${full(v)}`] : []));
    const group = el("g", { class: "bar" });
    group.append(el("title", {}, [`${label}: ${full(sums[n] ?? 0)}`, ...lines].join("\n")));
    let y = H - BOTTOM;
    bySlot.forEach((v, slot) => {
      if (v <= 0) return;
      const h = (v / max) * plot;
      y -= h;
      group.append(el("rect", { x: LEFT + n * bw + bw * 0.12, y, width: bw * 0.76, height: h, class: `s${slot}` }));
    });
    svg.append(group);
    if (n % every === 0) {
      svg.append(el("text", { x: LEFT + n * bw + bw / 2, y: H - 6, "text-anchor": "middle" }, label));
    }
  });
  return svg;
}
