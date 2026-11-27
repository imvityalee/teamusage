import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PRIVACY } from "./privacy.js";
import { strings } from "./strings.js";
import { TERMS } from "./terms.js";

const PAGES = {
  privacy: { file: "privacy.html", sections: PRIVACY, docTitle: "privacyDocTitle" },
  terms: { file: "terms.html", sections: TERMS, docTitle: "termsDocTitle" },
} as const;

let win: Window;
let doc: Document;
let fetchSpy: ReturnType<typeof vi.fn>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => doc.querySelector(sel) as T;

async function boot(page: keyof typeof PAGES, language = "en-US"): Promise<void> {
  const html = readFileSync(new URL(`../../${PAGES[page].file}`, import.meta.url), "utf8");
  const body = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  win = new Window({
    url: `http://localhost:8787/${page}`,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = (body?.[2] ?? "").replace(/<script[\s\S]*?<\/script>/g, "");
  const kind = /data-legal="(\w+)"/.exec(body?.[1] ?? "")?.[1];
  if (kind !== undefined) doc.body.setAttribute("data-legal", kind);
  fetchSpy = vi.fn();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { language });
  vi.stubGlobal("localStorage", win.localStorage);
  vi.stubGlobal("fetch", fetchSpy);
  vi.resetModules();
  await import("./main.js");
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await win?.happyDOM.close();
});

describe.each(Object.keys(PAGES) as (keyof typeof PAGES)[])("the %s page", (page) => {
  test("shows the draft banner while the legal text is a placeholder, in the chosen language", async () => {
    await boot(page);
    expect($(".notice.warn").hidden).toBe(false);
    expect($(".notice.warn").textContent).toBe(strings.en.banner);
    $<HTMLButtonElement>('#lang button[data-lang="ru"]').click();
    expect($(".notice.warn").hidden).toBe(false);
    expect($(".notice.warn").textContent).toBe(strings.ru.banner);
  });

  test("draws every section as a heading and its paragraphs, in English and then in Russian", async () => {
    await boot(page);
    const drawn = () =>
      Array.from(doc.querySelectorAll("#sections > section")).map((s) => ({
        heading: s.querySelector("h2")?.textContent,
        paragraphs: Array.from(s.querySelectorAll("p")).map((p) => p.textContent),
      }));
    const expected = (lang: "en" | "ru") => PAGES[page].sections[lang].map((s) => ({ heading: s.heading, paragraphs: s.paragraphs }));
    expect(drawn()).toEqual(expected("en"));
    $<HTMLButtonElement>('#lang button[data-lang="ru"]').click();
    expect(drawn()).toEqual(expected("ru"));
    expect(doc.documentElement.lang).toBe("ru");
    expect(doc.title).toBe(strings.ru[PAGES[page].docTitle]);
  });

  test("a Russian browser starts in Russian and makes no request", async () => {
    await boot(page, "ru-RU");
    expect($("h1").textContent).toBe(strings.ru[page === "privacy" ? "privacyHeading" : "termsHeading"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("marks the sections that are placeholders, and only those", async () => {
    await boot(page);
    const marked = Array.from(doc.querySelectorAll("#sections > section")).map((s) => s.classList.contains("placeholder"));
    expect(marked).toEqual(PAGES[page].sections.en.map((s) => s.placeholder));
  });
});
