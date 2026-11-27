import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LANG_KEY } from "../i18n.js";
import { applyText, languageSwitch, translator, type Table } from "./i18n.js";

const table: Table<"title" | "hello" | "label" | "hint"> = {
  en: { title: "Page", hello: "Hello, {name}", label: "Language", hint: "Search {what}" },
  ru: { title: "Страница", hello: "Привет, {name}", label: "Язык", hint: "Поиск: {what}" },
};

const SWITCH = `<div id="lang" role="group"><button type="button" data-lang="en" aria-pressed="false">EN</button><button type="button" data-lang="ru" aria-pressed="false">RU</button></div>`;

let win: Window;

function page(body: string, navigatorLang = "en-US"): Document {
  win = new Window({ url: "http://localhost:8787/open" });
  Object.defineProperty(win.navigator, "language", { value: navigatorLang, configurable: true });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = body;
  vi.stubGlobal("navigator", win.navigator);
  vi.stubGlobal("localStorage", win.localStorage);
  return doc;
}

const pressed = (doc: Document) =>
  Array.from(doc.querySelectorAll("#lang button"), (b) => `${b.getAttribute("data-lang")}=${b.getAttribute("aria-pressed")}`);

afterEach(async () => {
  vi.unstubAllGlobals();
  await win?.happyDOM.close();
});

describe("translator", () => {
  const t = translator(table);

  test("fills a placeholder literally, markup included, and leaves an unknown one as it is", () => {
    expect(t("en", "hello", { name: "<b>Jo</b> $& {what}" })).toBe("Hello, <b>Jo</b> $& {what}");
    expect(t("ru", "hello", { name: 7 })).toBe("Привет, 7");
    expect(t("en", "hello")).toBe("Hello, {name}");
    expect(t("en", "hello", { other: "x" })).toBe("Hello, {name}");
  });
});

describe("applyText", () => {
  test("fills text, aria-label and placeholder, the title and <html lang>", () => {
    const doc = page(`<h1 data-i18n="hello">Hello, {name}</h1><div data-i18n-label="label"></div><input data-i18n-placeholder="hint"><p data-i18n="nope">kept</p>`);
    applyText(doc, table, "ru", "title");
    expect(doc.querySelector("h1")?.textContent).toBe("Привет, {name}");
    expect(doc.querySelector("div")?.getAttribute("aria-label")).toBe("Язык");
    expect(doc.querySelector("input")?.getAttribute("placeholder")).toBe("Поиск: {what}");
    expect(doc.querySelector("p")?.textContent).toBe("kept");
    expect(doc.title).toBe("Страница");
    expect(doc.documentElement.lang).toBe("ru");
  });
});

describe("languageSwitch", () => {
  test("starts from the browser's language and marks it pressed", () => {
    const doc = page(SWITCH, "ru-RU");
    expect(languageSwitch(doc, () => {})).toBe("ru");
    expect(pressed(doc)).toEqual(["en=false", "ru=true"]);
  });

  test("a stored choice wins over the browser's language", () => {
    const doc = page(SWITCH, "ru-RU");
    win.localStorage.setItem(LANG_KEY, "en");
    expect(languageSwitch(doc, () => {})).toBe("en");
  });

  test("a press marks the button, stores the choice and calls onChange", () => {
    const doc = page(SWITCH);
    const onChange = vi.fn();
    languageSwitch(doc, onChange);
    (doc.querySelector('[data-lang="ru"]') as HTMLElement).click();
    expect(onChange).toHaveBeenCalledWith("ru");
    expect(pressed(doc)).toEqual(["en=false", "ru=true"]);
    expect(win.localStorage.getItem(LANG_KEY)).toBe("ru");
  });

  test("reads and writes only teamusage.lang", () => {
    const doc = page(SWITCH);
    const store = win.localStorage as unknown as Storage;
    const getItem = vi.spyOn(store, "getItem");
    const setItem = vi.spyOn(store, "setItem");
    languageSwitch(doc, () => {});
    (doc.querySelector('[data-lang="ru"]') as HTMLElement).click();
    (doc.querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(new Set(getItem.mock.calls.map(([k]) => k))).toEqual(new Set([LANG_KEY]));
    expect(new Set(setItem.mock.calls.map(([k]) => k))).toEqual(new Set([LANG_KEY]));
    expect(Array.from({ length: store.length }, (_, i) => store.key(i))).toEqual([LANG_KEY]);
  });
});
