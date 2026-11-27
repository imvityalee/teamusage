import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { expect, test } from "vitest";
import { expectComplete } from "../site/i18n.fixture.js";
import { strings } from "./strings.js";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("both tables have the same keys, no empty text and the same placeholders", () => {
  expectComplete(strings);
});

test("every data-dash element of index.html already holds its English, and names a key of the table", async () => {
  const win = new Window();
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ?? "";
  const keyed = [...doc.querySelectorAll("[data-dash]")];
  expect(keyed.length).toBeGreaterThan(0);
  for (const el of keyed) {
    const key = el.getAttribute("data-dash") ?? "";
    expect(Object.hasOwn(strings.en, key), key).toBe(true);
    expect(el.textContent?.trim(), key).toBe(strings.en[key as keyof typeof strings.en]);
  }
  for (const el of doc.querySelectorAll("[data-dash-label]")) {
    expect(el.getAttribute("aria-label")).toBe(strings.en[el.getAttribute("data-dash-label") as keyof typeof strings.en]);
  }
  await win.happyDOM.close();
});

test("index.html keeps no inline script, style attribute or event attribute", () => {
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
});
