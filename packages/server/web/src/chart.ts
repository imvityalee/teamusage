import type { Stats } from "@teamusage/shared";
import { OTHER_SERIES, SERIES_CLASS, seriesOf } from "./agents.js";
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
export function dailyAgentTotals(daily: Stats["daily"]): Map<string, number> {
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

/** The chart series that have any tokens, in the fixed bottom-to-top order (see agents.ts). */
export function presentSeries(totals: Map<string, number>): number[] {
  const present = new Set<number>();
  for (const [agent, n] of totals) if (n > 0) present.add(seriesOf(agent));
  return [...present].sort((a, b) => a - b);
}

export interface ChartOptions {
  /** Display name per series, in series order; the last is "Other agents". */
  names: string[];
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

const GAP = 2;
const RADIUS = 3;
const num = (n: number): string => String(Math.round(n * 100) / 100);

/** A bar segment with its top corners rounded. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, h, w / 2);
  return [
    `M${num(x)} ${num(y + h)}`,
    `V${num(y + r)}`,
    `Q${num(x)} ${num(y)} ${num(x + r)} ${num(y)}`,
    `H${num(x + w - r)}`,
    `Q${num(x + w)} ${num(y)} ${num(x + w)} ${num(y + r)}`,
    `V${num(y + h)}`,
    "Z",
  ].join(" ");
}

/**
 * Stacked bars drawn as SVG elements, one segment per series in the fixed order, so an agent keeps its colour
 * whatever is shown. Segments are separated by a small gap; only the top one is rounded.
 * Every text, including tooltips, goes in as textContent; classes come from the fixed SERIES_CLASS list.
 */
export function drawChart(doc: Document, data: Bucket[], opts: ChartOptions): SVGSVGElement {
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) => {
    const node = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });
  const series = data.map((b) => {
    const bySeries = Array.from({ length: OTHER_SERIES + 1 }, () => 0);
    for (const [agent, n] of Object.entries(b.byAgent)) {
      const i = seriesOf(agent);
      bySeries[i] = (bySeries[i] ?? 0) + (Number.isFinite(n) && n > 0 ? n : 0);
    }
    return bySeries;
  });
  const sums = series.map((s) => s.reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...sums) || 1;
  const plot = H - BOTTOM - TOP;

  for (let g = 0; g <= 3; g++) {
    const y = TOP + plot * (1 - g / 3);
    svg.append(
      el("line", { x1: LEFT, x2: W, y1: y, y2: y, class: g === 0 ? "axis" : "grid" }),
      el("text", { x: LEFT - 6, y: y + 4, "text-anchor": "end" }, compact((max * g) / 3)),
    );
  }

  const bw = (W - LEFT) / Math.max(1, data.length);
  const every = Math.ceil(data.length / X_LABELS);
  data.forEach((bucket, n) => {
    const label = opts.label(bucket.label);
    const bySeries = series[n] ?? [];
    const lines = bySeries.flatMap((v, i) => (v > 0 ? [`${opts.names[i] ?? ""}: ${full(v)}`] : []));
    const group = el("g", { class: "bar" });
    group.append(el("title", {}, [`${label}: ${full(sums[n] ?? 0)}`, ...lines].join("\n")));
    const shown = bySeries.flatMap((v, i) => (v > 0 ? [i] : []));
    const x = LEFT + n * bw + bw * 0.12;
    const w = bw * 0.76;
    let base = H - BOTTOM;
    shown.forEach((i, k) => {
      const slot = ((bySeries[i] ?? 0) / max) * plot;
      // Every segment above the first leaves a gap of the card colour under it.
      const bottom = k === 0 ? base : base - GAP;
      const top = base - slot;
      const height = Math.max(0, bottom - top);
      const cls = SERIES_CLASS[i] as string;
      if (k === shown.length - 1) group.append(el("path", { d: roundedTop(x, top, w, height), class: cls }));
      else group.append(el("rect", { x: num(x), y: num(top), width: num(w), height: num(height), class: cls }));
      base = top;
    });
    svg.append(group);
    if (n % every === 0) {
      svg.append(el("text", { x: LEFT + n * bw + bw / 2, y: H - 6, "text-anchor": "middle" }, label));
    }
  });
  return svg;
}
