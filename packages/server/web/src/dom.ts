/**
 * DOM building blocks. Elements are created one by one; every value goes in as a text node or an attribute
 * value, so nothing is ever parsed as HTML.
 */

export type Child = Node | string;

export function h(doc: Document, tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

const SVG = "http://www.w3.org/2000/svg";

/** Fixed, decorative line icons drawn in the current text colour. */
const ICONS = {
  down: { size: 12, d: "M2.5 4.5 6 8l3.5-3.5" },
  up: { size: 12, d: "M2.5 7.5 6 4l3.5 3.5" },
  right: { size: 14, d: "M5 2.5 9.5 7 5 11.5" },
  left: { size: 14, d: "M9 2.5 4.5 7 9 11.5" },
  close: { size: 10, d: "M2 2l6 6M8 2 2 8" },
  check: { size: 12, d: "M2.5 6.5 5 9l4.5-5.5" },
  warn: { size: 12, d: "M6 2.5v4M6 9.3v.2" },
  search: { size: 16, d: "M10.5 10.5l3 3M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z" },
  machine: { size: 18, d: "M4.5 3.5h9A1.5 1.5 0 0 1 15 5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 10V5a1.5 1.5 0 0 1 1.5-1.5zM1.5 14.5h15" },
} as const;

export type IconName = keyof typeof ICONS;

export function icon(doc: Document, name: IconName, className = "icon"): SVGSVGElement {
  const { size, d } = ICONS[name];
  const svg = doc.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    class: className,
    "aria-hidden": "true",
    focusable: "false",
    width: String(size),
    height: String(size),
    viewBox: `0 0 ${size} ${size}`,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  })) {
    svg.setAttribute(k, v);
  }
  const path = doc.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
