import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, test } from "vitest";
import type { Lang } from "../i18n.js";
import { expectComplete, expectEnglishInHtml } from "../site/i18n.fixture.js";
import { PRIVACY } from "./privacy.js";
import { LEGAL_TEXT_IS_PLACEHOLDER, strings } from "./strings.js";
import { TERMS } from "./terms.js";

const LANGS: Lang[] = ["en", "ru"];
const PAGES = [
  ["privacy", PRIVACY, readFileSync(new URL("../../privacy.html", import.meta.url), "utf8")],
  ["terms", TERMS, readFileSync(new URL("../../terms.html", import.meta.url), "utf8")],
] as const;
const PREFIX = { en: "[Placeholder]", ru: "[Заглушка]" };
const PLACEHOLDER_TEXT = {
  en: "This section is supplied by the service's owner before launch.",
  ru: "Этот раздел владелец сервиса добавит до запуска.",
};
const FACT_PHRASES = {
  en: ["24 months", "not verified", "can read the database"],
  ru: ["24 месяцев", "не проверяется", "может читать базу данных"],
};

describe("the string table", () => {
  test("has the same keys in both languages, no empty text and the same placeholders", () => {
    expectComplete(strings);
  });

  test.each(PAGES)("%s.html already reads in English", (_name, _sections, html) => {
    expectEnglishInHtml(html, strings);
  });

  test.each(PAGES)("the <title> of %s.html is the English title", (name, _sections, html) => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(strings.en[name === "privacy" ? "privacyDocTitle" : "termsDocTitle"]);
  });
});

describe.each(PAGES)("%s", (_name, page) => {
  test("English and Russian have the same sections with the same placeholder flags in the same order", () => {
    expect(page.ru.map((s) => s.placeholder)).toEqual(page.en.map((s) => s.placeholder));
  });

  test.each(LANGS)("no %s section is empty", (lang) => {
    expect(page[lang].length).toBeGreaterThan(0);
    for (const s of page[lang]) {
      expect(s.heading.trim(), "heading").not.toBe("");
      expect(s.paragraphs.length, s.heading).toBeGreaterThan(0);
      for (const p of s.paragraphs) expect(p.trim(), s.heading).not.toBe("");
    }
  });

  test.each(LANGS)("every %s placeholder section is marked and holds the one standard paragraph", (lang) => {
    for (const s of page[lang].filter((x) => x.placeholder)) {
      expect(s.heading.startsWith(`${PREFIX[lang]} `), s.heading).toBe(true);
      expect(s.paragraphs, s.heading).toEqual([PLACEHOLDER_TEXT[lang]]);
    }
  });

  test.each(LANGS)("no %s section that states a fact carries the placeholder mark", (lang) => {
    for (const s of page[lang].filter((x) => !x.placeholder)) {
      expect(s.heading.startsWith(PREFIX[lang]), s.heading).toBe(false);
      expect(s.paragraphs.join(" "), s.heading).not.toContain(PLACEHOLDER_TEXT[lang]);
    }
  });

  test("the flag says the text is placeholder for as long as any section is", () => {
    const anyPlaceholder = page.en.some((s) => s.placeholder);
    expect(LEGAL_TEXT_IS_PLACEHOLDER || !anyPlaceholder).toBe(true);
  });
});

/** The sections written in a page's HTML, read as `main.js` finds them before it runs. */
function staticSections(html: string): { heading: string | undefined; paragraphs: (string | null)[]; placeholder: boolean }[] {
  const win = new Window();
  try {
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
    return Array.from(doc.querySelectorAll("#sections > section")).map((s) => ({
      heading: s.querySelector("h2")?.textContent,
      paragraphs: Array.from(s.querySelectorAll("p")).map((p) => p.textContent),
      placeholder: s.classList.contains("placeholder"),
    }));
  } finally {
    void win.happyDOM.close();
  }
}

describe("the HTML before the script runs", () => {
  test.each(PAGES)("%s.html holds the English sections, so it reads without script", (_name, page, html) => {
    expect(staticSections(html)).toEqual(page.en.map((s) => ({ heading: s.heading, paragraphs: s.paragraphs, placeholder: s.placeholder })));
  });
});

describe("the facts of the privacy page", () => {
  test.each(LANGS)("hold the exact %s phrases", (lang) => {
    const facts = PRIVACY[lang].filter((s) => !s.placeholder);
    const text = facts.flatMap((s) => s.paragraphs).join("\n");
    for (const phrase of FACT_PHRASES[lang]) expect(text, phrase).toContain(phrase);
  });

  test("are seven sections of facts, then the six placeholders the brief names", () => {
    expect(PRIVACY.en.filter((s) => !s.placeholder).map((s) => s.heading)).toEqual([
      "What is sent",
      "What is never sent",
      "Who can see a team's numbers",
      "Accounts",
      "What a browser keeps",
      "Known limits",
      "Keeping and deleting",
    ]);
    expect(PRIVACY.en.filter((s) => s.placeholder)).toHaveLength(6);
  });
});

describe("the terms", () => {
  test("are placeholders from the first section to the last", () => {
    for (const lang of LANGS) expect(TERMS[lang].every((s) => s.placeholder)).toBe(true);
    expect(TERMS.en).toHaveLength(8);
  });
});
