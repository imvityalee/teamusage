import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

/** The dialog's motion in site.css, as the Global Constraints ("Motion") give it. */

const css = readFileSync(new URL("../../site.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

/** The declarations of the first rule whose selector is exactly `selector`, inside `text`. */
const rule = (text: string, selector: string): string => {
  const at = text.indexOf(`${selector} {`);
  return at < 0 ? "" : text.slice(at, text.indexOf("}", at));
};

const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
const starting = css.slice(css.indexOf("@starting-style"));

test("it enters with opacity and a scale from 0.96, in 200 ms on the shared curve, centred", () => {
  const open = rule(css, ".dialog");
  expect(open).toContain("transform-origin: center");
  expect(open).toContain("opacity 200ms var(--ease-out), transform 200ms var(--ease-out)");
  expect(rule(starting, ".dialog[open]")).toContain("opacity: 0; transform: scale(0.96)");
});

test("it leaves in 150 ms to the same state, its backdrop with it", () => {
  expect(rule(css, ".dialog:not([open])")).toContain("opacity: 0; transform: scale(0.96); transition-duration: 150ms");
  expect(rule(css, ".dialog:not([open])::backdrop")).toContain("opacity: 0; transition-duration: 150ms");
  expect(rule(starting, ".dialog[open]::backdrop")).toContain("opacity: 0");
});

test("only transform and opacity move; display and overlay are discrete", () => {
  const moving = [...css.matchAll(/\.dialog[^{]*\{[^}]*transition: ([^;]+);/g)].flatMap((m) => (m[1] ?? "").split(","));
  expect(moving.length).toBeGreaterThan(0);
  for (const part of moving) expect(part.trim()).toMatch(/^(opacity|transform) |^(overlay|display) .*allow-discrete$/);
});

test("under reduced motion the dialog only fades", () => {
  expect(rule(reduced, ".dialog, .dialog:not([open])")).toContain("transform: none");
  expect(rule(reduced.slice(reduced.indexOf("@starting-style")), ".dialog[open]")).toContain("transform: none");
});
