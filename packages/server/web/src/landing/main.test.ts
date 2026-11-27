import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SIGN_IN_PATH } from "../site/session.js";
import { strings } from "./strings.js";

const PAGE = readFileSync(new URL("../../landing.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ?? "";
const REPOSITORY = "https://github.com/imvityalee/teamusage";

let win: Window;
let doc: Document;
let fetchSpy: ReturnType<typeof vi.fn>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => doc.querySelector(sel) as T;

async function boot(language = "en-US"): Promise<void> {
  win = new Window({
    url: "http://localhost:8787/",
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = BODY; // the page's own static markup
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

/** The `href` of every link whose text is the message `key`, by the key it carries. */
const hrefsOf = (key: string): (string | null)[] =>
  Array.from(doc.querySelectorAll(`a[data-i18n="${key}"], a [data-i18n="${key}"]`)).map(
    (el) => (el.closest("a") as HTMLAnchorElement).getAttribute("href"),
  );

describe("the links", () => {
  test.each([
    ["createTeam", SIGN_IN_PATH, 2],
    ["viewDemo", "/demo", 1],
    ["openDashboard", "/open", 1],
    ["footerPrivacy", "/privacy", 1],
    ["footerTerms", "/terms", 1],
    ["github", REPOSITORY, 2],
    ["selfHost", `${REPOSITORY}/blob/main/SELF-HOSTING.md`, 1],
  ])("%s goes to %s", async (key, href, count) => {
    await boot();
    expect(hrefsOf(key)).toEqual(Array<string>(count).fill(href));
  });

  test("a link to another site opens with no opener", async () => {
    await boot();
    for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')) expect(a.rel, a.href).toContain("noopener");
  });
});

describe("the language", () => {
  test("a switch to Russian puts Russian in the hero and on <html>", async () => {
    await boot();
    expect($("h1").textContent).toBe(strings.en.heroTitle);
    $<HTMLButtonElement>('#lang button[data-lang="ru"]').click();
    expect($("h1").textContent).toBe(strings.ru.heroTitle);
    expect(doc.documentElement.lang).toBe("ru");
    expect(doc.title).toBe(strings.ru.title);
    expect($('#lang button[data-lang="ru"]').getAttribute("aria-pressed")).toBe("true");
  });

  test("a Russian browser starts in Russian", async () => {
    await boot("ru-RU");
    expect($("h1").textContent).toBe(strings.ru.heroTitle);
    expect(doc.documentElement.lang).toBe("ru");
  });

  test("the sample chart is named in the chosen language", async () => {
    await boot("ru-RU");
    expect($("svg[role='img']").getAttribute("aria-label")).toBe(strings.ru.chartLabel);
  });
});

describe("the page is static", () => {
  test("a switch of language changes the text and sends no request", async () => {
    await boot();
    const before = $("main").innerHTML;
    $<HTMLButtonElement>('#lang button[data-lang="ru"]').click();
    expect($("main").innerHTML).not.toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
