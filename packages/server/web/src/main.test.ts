import { readFileSync } from "node:fs";
import { presetRange } from "@teamusage/shared";
import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { localIsoDate } from "./format.js";
import { LANG_KEY } from "./i18n.js";
import { statsFixture } from "./test-fixtures.js";

const PAGE = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const BODY = /<body>([\s\S]*)<\/body>/.exec(PAGE)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ?? "";

type Reply = Response | Error | (() => Promise<Response>);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const unauthorized = () => json({ error: "unauthorized" }, 401);

let win: Window;
let doc: Document;
let calls: { url: string; init: RequestInit }[];
let replies: Reply[];

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => doc.querySelector(sel) as T;
const keys = (s: Storage) => Array.from({ length: s.length }, (_, i) => s.key(i));
const range = (days: 30 | 90 | 180) => presetRange(days, localIsoDate(new Date()));
const statsUrl = (r: { from: string; to: string }) => `/api/stats?from=${r.from}&to=${r.to}`;

async function boot(...first: Reply[]): Promise<void> {
  win = new Window({
    url: "http://localhost:8787/",
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = BODY; // the page's own static markup
  calls = [];
  replies = [...first];
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", win.navigator);
  vi.stubGlobal("localStorage", win.localStorage);
  vi.stubGlobal("sessionStorage", win.sessionStorage);
  vi.stubGlobal("location", win.location);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = replies.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    }),
  );
  vi.resetModules();
  await import("./main.js");
  await flush();
}

function submitLogin(code: string): void {
  $<HTMLInputElement>("#invite").value = code;
  $("#login-form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await win?.happyDOM.close();
});

describe("login", () => {
  test("a 401 shows the login form; signing in loads the stats and leaves the code nowhere", async () => {
    await boot(unauthorized());
    expect($("#login").hidden).toBe(false);
    expect($("#stats").hidden).toBe(true);
    const invite = $<HTMLInputElement>("#invite");
    expect(invite.type).toBe("password");
    expect(invite.getAttribute("autocomplete")).toBe("off");
    expect(doc.querySelector('label[for="invite"]')).not.toBeNull();

    const code = "s3cret-invite-code-0123";
    replies.push(new Response(null, { status: 204 }), json(statsFixture()));
    submitLogin(code);
    expect(invite.value).toBe("");
    await flush();

    expect(calls.map((c) => c.url)).toEqual([statsUrl(range(90)), "/api/login", statsUrl(range(90))]);
    const loginCall = calls[1] as { init: RequestInit };
    expect(loginCall.init.method).toBe("POST");
    expect(loginCall.init.credentials).toBe("same-origin");
    expect(JSON.parse(loginCall.init.body as string)).toEqual({ inviteCode: code });
    for (const c of calls) expect(c.init.credentials).toBe("same-origin");

    expect($("#login").hidden).toBe(true);
    expect($("#stats").hidden).toBe(false);
    expect(doc.querySelectorAll("#stats .tile")).toHaveLength(4);

    // The code is not kept anywhere the page can write.
    const stored = keys(win.localStorage as unknown as Storage).filter((k) => k !== LANG_KEY);
    expect(stored).toEqual([]);
    expect(win.sessionStorage.length).toBe(0);
    expect(doc.cookie).toBe("");
    expect(win.location.href).toBe("http://localhost:8787/");
    expect(doc.documentElement.outerHTML).not.toContain(code);
  });

  test("a wrong code and too many attempts are explained", async () => {
    await boot(unauthorized());
    replies.push(json({ error: "invalid invite code" }, 403));
    submitLogin("wrong-code-wrong-code");
    await flush();
    expect($("#login-msg").hidden).toBe(false);
    expect($("#login-msg").textContent).toBe("Wrong invite code.");

    replies.push(json({ error: "too many attempts" }, 429, { "Retry-After": "120" }));
    submitLogin("wrong-code-wrong-code");
    await flush();
    expect($("#login-msg").textContent).toBe("Too many attempts. Try again in 2 minutes.");
    expect($("#login").hidden).toBe(false);
    expect($<HTMLInputElement>("#invite").value).toBe("");
  });
});

describe("range", () => {
  test("presets and a valid custom range reload; a too long range is refused without a request", async () => {
    await boot(json(statsFixture()));
    expect(calls.map((c) => c.url)).toEqual([statsUrl(range(90))]);
    const pressed = () => [...doc.querySelectorAll("#range button")].map((b) => b.getAttribute("aria-pressed"));
    expect(pressed()).toEqual(["false", "true", "false"]);

    replies.push(json(statsFixture()));
    $('#range button[data-days="30"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(30)));
    expect(pressed()).toEqual(["true", "false", "false"]);
    expect($<HTMLInputElement>("#from").value).toBe(range(30).from);

    const from = $<HTMLInputElement>("#from");
    const to = $<HTMLInputElement>("#to");
    from.value = "2024-01-01";
    to.value = "2026-01-01";
    to.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    await flush();
    expect(calls).toHaveLength(2);
    expect($("#range-msg").hidden).toBe(false);
    expect($("#range-msg").textContent).toBe("A range can be at most 730 days.");

    replies.push(json(statsFixture()));
    from.value = "2026-01-01";
    from.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    await flush();
    expect(calls.at(-1)?.url).toBe("/api/stats?from=2026-01-01&to=2026-01-01");
    expect($("#range-msg").hidden).toBe(true);
    expect(pressed()).toEqual(["false", "false", "false"]);
  });

  test("while loading, the previous numbers stay and are dimmed", async () => {
    await boot(json(statsFixture()));
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    $('#range button[data-days="180"]').click();
    await flush();
    expect($("#stats").getAttribute("aria-busy")).toBe("true");
    expect($("#stats").classList.contains("loading")).toBe(true);
    expect(doc.querySelectorAll("#stats .tile")).toHaveLength(4);
    release(json(statsFixture()));
    await flush();
    expect($("#stats").getAttribute("aria-busy")).toBe("false");
    expect($("#stats").classList.contains("loading")).toBe(false);
  });

  test("a network failure keeps the numbers and offers a retry", async () => {
    await boot(json(statsFixture()));
    replies.push(new TypeError("offline"));
    $('#range button[data-days="30"]').click();
    await flush();
    expect($("#status").hidden).toBe(false);
    expect($("#status-text").textContent).toBe("Could not reach the server.");
    expect(doc.querySelectorAll("#stats .tile")).toHaveLength(4);

    replies.push(json(statsFixture()));
    $("#retry").click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(30)));
    expect($("#status").hidden).toBe(true);
  });
});

describe("language", () => {
  test("switching language re-renders every string, stores only the choice and does not refetch", async () => {
    await boot(json(statsFixture()));
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.title).toBe("teamusage — team usage");
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect(calls).toHaveLength(1);
    expect(doc.documentElement.lang).toBe("ru");
    expect(doc.title).toBe("teamusage — статистика команды");
    expect($('#lang button[data-lang="ru"]').getAttribute("aria-pressed")).toBe("true");
    expect($('#range button[data-days="90"]').textContent).toBe("3 месяца");
    expect($("#stats .tile .k").textContent).toBe("Всего токенов");
    expect($('label[for="invite"]').textContent).toBe("Инвайт-код");
    expect(keys(win.localStorage as unknown as Storage)).toEqual([LANG_KEY]);
    expect(win.localStorage.getItem(LANG_KEY)).toBe("ru");
  });
});
