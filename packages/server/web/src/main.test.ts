import { readFileSync } from "node:fs";
import { presetRange } from "@teamusage/shared";
import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { localIsoDate } from "./format.js";
import { LANG_KEY } from "./i18n.js";
import { memberStatsFixture, statsFixture } from "./test-fixtures.js";

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

const boot = (...first: Reply[]) => bootAt("http://localhost:8787/", ...first);

async function bootAt(url: string, ...first: Reply[]): Promise<void> {
  win = new Window({
    url,
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

const memberUrl = (r: { from: string; to: string }, id: number) => `${statsUrl(r)}&member=${id}`;
const memberRows = () => [...doc.querySelectorAll("#members tbody tr")].map((r) => r.querySelector("th")?.textContent);

function typeQuery(value: string): void {
  const input = $<HTMLInputElement>("#member-search");
  input.value = value;
  input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
}

async function goTo(hash: string): Promise<void> {
  win.location.hash = hash;
  await flush();
}

describe("member search", () => {
  test("typing filters the loaded rows without a request and keeps the query nowhere", async () => {
    await boot(json(statsFixture()));
    expect(memberRows()).toHaveLength(3);
    typeQuery("NGUY");
    await flush();
    expect(memberRows()).toEqual(["Bao Nguyenbao@example.com"]);
    expect($("#members-count").textContent).toBe("1 of 3 members");
    typeQuery("zzz");
    await flush();
    expect(memberRows()).toEqual([]);
    expect($("#members-count").textContent).toBe("No members match");
    typeQuery("");
    await flush();
    expect(memberRows()).toHaveLength(3);
    expect($("#members-count").hidden).toBe(true);

    expect(calls).toHaveLength(1);
    expect(keys(win.localStorage as unknown as Storage)).toEqual([]);
    expect(win.sessionStorage.length).toBe(0);
    expect(win.location.href).toBe("http://localhost:8787/");
  });

  test("the query survives a range change and a language switch", async () => {
    await boot(json(statsFixture()));
    typeQuery("carla");
    replies.push(json(statsFixture()));
    $('#range button[data-days="30"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(statsUrl(range(30)));
    expect(calls.at(-1)?.url).not.toContain("carla");
    expect($<HTMLInputElement>("#member-search").value).toBe("carla");
    expect(memberRows()).toEqual(["Carla Mendescarla@example.com"]);
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect($("#members-count").textContent).toBe("1 из 3 участников");
    expect(memberRows()).toEqual(["Carla Mendescarla@example.com"]);
  });

  test("the search box keeps focus when a load finishes while typing", async () => {
    await boot(json(statsFixture()));
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    $('#range button[data-days="30"]').click();
    $<HTMLInputElement>("#member-search").focus();
    typeQuery("al");
    release(json(statsFixture()));
    await flush();
    expect(doc.activeElement?.id).toBe("member-search");
    expect($<HTMLInputElement>("#member-search").value).toBe("al");
  });
});

describe("member page", () => {
  test("clicking a member name opens their page with the member's stats", async () => {
    await boot(json(statsFixture()));
    replies.push(json(memberStatsFixture()));
    $('#members a[href="#/member/1"]').click();
    await flush();
    expect(win.location.hash).toBe("#/member/1");
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 1));
    expect(calls.at(-1)?.init.credentials).toBe("same-origin");
    expect($("#member-heading").textContent).toBe("Alice Archer");
    expect(doc.title).toBe("Alice Archer — teamusage");
    expect(doc.querySelectorAll("#machines tbody tr")).toHaveLength(3);
    expect(doc.querySelector("#members")).toBeNull();
    expect(doc.querySelector("#member-search")).toBeNull();
  });

  test("a hashchange loads that member; going back to the team clears the query and drops the member", async () => {
    await boot(json(statsFixture()));
    typeQuery("alice");
    replies.push(json({ ...memberStatsFixture(), members: [{ ...statsFixture().members[1], id: 2 }] }));
    await goTo("#/member/2");
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 2));
    expect(doc.title).toBe("Bao Nguyen — teamusage");

    replies.push(json(statsFixture()));
    $("a.back").click();
    await flush();
    expect(win.location.hash).toBe("#/");
    expect(calls.at(-1)?.url).toBe(statsUrl(range(90)));
    expect(doc.title).toBe("teamusage — team usage");
    expect($<HTMLInputElement>("#member-search").value).toBe("");
    expect(memberRows()).toHaveLength(3);
  });

  test("while the member page loads, the previous view stays, dimmed", async () => {
    await boot(json(statsFixture()));
    let release: (r: Response) => void = () => {};
    replies.push(() => new Promise<Response>((r) => (release = r)));
    await goTo("#/member/1");
    expect($("#stats").classList.contains("loading")).toBe(true);
    expect(doc.querySelectorAll("#members tbody tr")).toHaveLength(3);
    release(json(memberStatsFixture()));
    await flush();
    expect($("#stats").classList.contains("loading")).toBe(false);
    expect($("#member-heading").textContent).toBe("Alice Archer");
  });

  test("range and language keep working on the member page", async () => {
    await bootAt("http://localhost:8787/#/member/1", json(memberStatsFixture()));
    expect(calls.map((c) => c.url)).toEqual([memberUrl(range(90), 1)]);
    replies.push(json(memberStatsFixture()));
    $('#range button[data-days="180"]').click();
    await flush();
    expect(calls.at(-1)?.url).toBe(memberUrl(range(180), 1));
    $('#lang button[data-lang="ru"]').click();
    await flush();
    expect(calls).toHaveLength(2);
    expect($("a.back").textContent).toBe("← Все участники");
    expect(doc.title).toBe("Alice Archer — teamusage");
  });

  test("a malformed member fragment is the team view and sends no member", async () => {
    for (const hash of ["#/member/01", "#/member/1%22%3E%3Cimg%3E", "#/member/12345678901", "#/member/1/x"]) {
      await bootAt(`http://localhost:8787/${hash}`, json(statsFixture()));
      expect(calls.map((c) => c.url)).toEqual([statsUrl(range(90))]);
      expect(doc.querySelector("#members")).not.toBeNull();
      vi.unstubAllGlobals();
      await win.happyDOM.close();
    }
  });

  test("an unknown member shows not found with the link back", async () => {
    await boot(json(statsFixture()));
    replies.push(json({ error: "member not found" }, 404));
    await goTo("#/member/999999");
    expect(calls.at(-1)?.url).toBe(memberUrl(range(90), 999999));
    expect($("#stats .empty").textContent).toBe("Member not found");
    expect($("#stats a.back").getAttribute("href")).toBe("#/");
    expect($("#status").hidden).toBe(true);
    expect(doc.querySelector("#members")).toBeNull();
    $('#lang button[data-lang="ru"]').click();
    expect($("#stats .empty").textContent).toBe("Участник не найден");
  });

  test("other errors on the member page use the status line", async () => {
    await boot(json(statsFixture()));
    replies.push(json({ error: "<b>boom</b>" }, 500));
    await goTo("#/member/1");
    expect($("#status").hidden).toBe(false);
    expect($("#status-text").textContent).toBe("Could not load the statistics: <b>boom</b>");
    expect(doc.querySelector("#status b")).toBeNull();
  });
});
