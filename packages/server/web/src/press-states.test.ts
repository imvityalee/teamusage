import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * base.css turns the tap highlight off on every page, so every control must answer a press itself (Global
 * Constraints, "On a phone" and "Motion"). The controls are listed from index.html, render.ts, filterbar.ts,
 * src/dashboard/, the new pages' HTML and the team page's cards and dialogs (src/team/, src/site/dialog.ts).
 */

const css = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The innermost rules of `text`: each selector of a rule, with `:not(…)` taken out, and the rule's declarations. */
function rules(text: string): { selectors: string[]; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "").split(",").map((s) => s.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").replace(/\s+/g, " ").trim()),
    body: (m[2] ?? "").replace(/\s+/g, " "),
  }));
}

/** The text inside `@media (prefers-reduced-motion: reduce) { … }`, and the text outside it. */
function splitReduced(text: string): { reduced: string; rest: string } {
  const start = text.indexOf("@media (prefers-reduced-motion: reduce)");
  if (start < 0) return { reduced: "", rest: text };
  let depth = 0;
  let end = text.indexOf("{", start);
  do {
    if (text[end] === "{") depth++;
    if (text[end] === "}") depth--;
    end++;
  } while (depth > 0 && end < text.length);
  return { reduced: text.slice(start, end), rest: text.slice(0, start) + text.slice(end) };
}

const has = (text: string, selector: string, declaration: string) =>
  rules(text).some((r) => r.selectors.includes(selector) && r.body.includes(declaration));

const PRESSED = {
  "style.css": { scale: [".seg button", ".pill", ".chip", ".status button", ".login button"], dim: ["a", ".link", ".pop-row", ".sort-btn"] },
  "base.css": { scale: [".pager button", ".team-nav a"], dim: [".pager select"] },
  "chrome.css": { scale: [".signed-out .btn"], dim: [".brand-link", ".text-button", ".account a", ".sample a", ".signed-out .aside a"] },
  "site.css": { scale: [".btn", ".site-head .seg button", ".card .seg button"], dim: [".site-head .brand", ".aside a", ".link-button", ".account a", ".option"] },
};

test("base.css turns the tap highlight off, which is why every control needs its own press state", () => {
  expect(css("base.css")).toMatch(/html \{[^}]*-webkit-tap-highlight-color: transparent/);
});

describe.each(Object.entries(PRESSED))("%s", (file, { scale, dim }) => {
  const { reduced, rest } = splitReduced(css(file));

  test.each(scale)("%s scales to 0.97 while pressed, in 160 ms on the shared curve", (selector) => {
    expect(has(rest, `${selector}:active`, "transform: scale(0.97)")).toBe(true);
    expect(has(rest, selector, "transition: transform 160ms var(--ease-out)")).toBe(true);
  });

  test.each(scale)("%s does not scale under reduced motion, and still answers a press", (selector) => {
    expect(has(reduced, selector, "transition: none")).toBe(true);
    expect(has(reduced, `${selector}:active`, "transform: none; opacity: .8")).toBe(true);
  });

  test.each(dim)("%s dims while pressed", (selector) => {
    expect(has(rest, `${selector}:active`, "opacity: .6")).toBe(true);
  });
});
