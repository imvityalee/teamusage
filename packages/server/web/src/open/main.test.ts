import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SIGN_IN_PATH } from "../site/session.js";
import { worstCase } from "../site/worst-case.fixture.js";
import { strings } from "./strings.js";

const PAGE = readFileSync(new URL("../../open.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ?? "";

const TOKEN = "fedcba9876543210".repeat(4);
const ADMINS_ONLY = "this team's dashboard is limited to its admins";
const NOT_VALID = "this link is no longer valid; ask your agent for a new one";

type Reply = Response | Error | "pending";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const user = (login: string) => json({ kind: "user", githubId: 9_104_227, login, teams: [] });
const nobody = () => json({ error: "unauthorized" }, 401);
const noAccounts = () => new Response("not found", { status: 404 });
const opened = () => new Response(null, { status: 204 });
const refused = (error: string) => json({ error }, 403);

let win: Window;
let doc: Document;
let calls: { url: string; init: RequestInit; href: string }[];
let replies: Reply[];
let replace: ReturnType<typeof vi.fn>;
let logged: unknown[][];

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => doc.querySelector(sel) as T;
const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};
const shownViews = () =>
  Array.from(doc.querySelectorAll<HTMLElement>("[data-view]"))
    .filter((el) => !el.hidden)
    .map((el) => el.dataset.view);

async function boot(hash: string, ...first: Reply[]): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  win = new Window({
    url: `http://localhost:8787/open${hash}`,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = BODY; // the page's own static markup
  calls = [];
  replies = [...first];
  logged = [];
  replace = vi.fn();
  vi.spyOn(win.location, "replace").mockImplementation(replace);
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", win.navigator);
  vi.stubGlobal("localStorage", win.localStorage);
  vi.stubGlobal("sessionStorage", win.sessionStorage);
  vi.stubGlobal("location", win.location);
  vi.stubGlobal("history", win.history);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, href: win.location.href });
      const next = replies.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      if (next === "pending") return new Promise<Response>(() => {});
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  vi.resetModules();
  await import("./main.js");
  await flush();
}

function press(sel: string): void {
  $(sel).click();
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await win?.happyDOM.close();
});

describe("the token", () => {
  test("is out of the address before the first request, and nowhere on the page or in storage afterwards", async () => {
    await boot(`#${TOKEN}`, nobody(), refused(NOT_VALID));
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/dashboard-link/open"]);
    for (const c of calls) expect(c.href).toBe("http://localhost:8787/open");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ token: TOKEN });

    expect(win.location.href).toBe("http://localhost:8787/open");
    expect(doc.documentElement.outerHTML).not.toContain(TOKEN);
    expect(doc.title).not.toContain(TOKEN);
    expect(win.localStorage.length).toBe(0);
    expect(win.sessionStorage.length).toBe(0);
    expect(doc.cookie).toBe("");
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  test("a fragment that is not a token is taken out of the address too, and nothing is posted", async () => {
    await boot("#not-a-token", nobody());
    expect(win.location.href).toBe("http://localhost:8787/open");
    expect(calls.map((c) => c.url)).toEqual(["/api/me"]);
    expect(shownViews()).toEqual(["how"]);
  });
});

describe("each view shows its own block and hides the others", () => {
  test.each<[string, string, Reply[]]>([
    ["how", "", [nobody()]],
    ["confirm", `#${TOKEN}`, [user("bob")]],
    ["expired", `#${TOKEN}`, [nobody(), refused(NOT_VALID)]],
    ["adminsOnly", `#${TOKEN}`, [nobody(), refused(ADMINS_ONLY)]],
    ["failed", `#${TOKEN}`, [nobody(), new TypeError("Failed to fetch")]],
  ])("%s", async (view, hash, answers) => {
    await boot(hash, ...answers);
    expect(shownViews()).toEqual([view]);
  });

  test("opening", async () => {
    await boot(`#${TOKEN}`, nobody(), "pending");
    await vi.advanceTimersByTimeAsync(400);
    expect(shownViews()).toEqual(["opening"]);
  });
});

describe("opening", () => {
  test("the text is absent at 399 ms and present at 401 ms", async () => {
    await boot(`#${TOKEN}`, "pending");
    const text = $('[data-view="opening"]');
    await vi.advanceTimersByTimeAsync(399);
    expect(text.hidden).toBe(true);
    expect(shownViews()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(text.hidden).toBe(false);
    expect(text.textContent).toBe(strings.en.opening);
  });

  test("a link that opens goes to the dashboard without drawing the text", async () => {
    await boot(`#${TOKEN}`, nobody(), opened());
    expect(replace).toHaveBeenCalledWith("/dashboard");
    expect($('[data-view="opening"]').hidden).toBe(true);
  });

  test("on a server with no accounts it goes to /", async () => {
    await boot(`#${TOKEN}`, noAccounts(), opened());
    expect(replace).toHaveBeenCalledWith("/");
  });

  test("on a server with no accounts the page shows the invite-code line instead of GitHub", async () => {
    await boot("", noAccounts());
    expect($("#code-line").hidden).toBe(false);
    expect($("#gh-line").hidden).toBe(true);
    expect($<HTMLAnchorElement>("#code-line a").getAttribute("href")).toBe("/");
  });

  test("with GitHub accounts the sign-in line links to GitHub's start", async () => {
    await boot("", nobody());
    expect($("#gh-line").hidden).toBe(false);
    expect($("#code-line").hidden).toBe(true);
    expect($<HTMLAnchorElement>("#gh-line a").getAttribute("href")).toBe(SIGN_IN_PATH);
  });
});

describe("a GitHub sign-in", () => {
  test("the question shows the whole login", async () => {
    await boot(`#${TOKEN}`, user(worstCase.login));
    expect($("#login").textContent).toBe(`@${worstCase.login}`);
  });

  test("Open as a member posts the token and goes to the dashboard", async () => {
    await boot(`#${TOKEN}`, user("bob"), opened());
    expect(calls).toHaveLength(1);
    press("#open-member");
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/dashboard-link/open"]);
    expect(replace).toHaveBeenCalledWith("/dashboard");
  });

  test("a press keeps the question on screen, its buttons disabled and busy, and a double press sends one request", async () => {
    await boot(`#${TOKEN}`, user("bob"), "pending");
    const button = $<HTMLButtonElement>("#open-member");
    press("#open-member");
    press("#open-member");
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/dashboard-link/open"]);
    expect(shownViews()).toEqual(["confirm"]);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect($<HTMLButtonElement>("#stay").disabled).toBe(true);
    expect($('[data-view="opening"]').hidden).toBe(true);
  });

  test("a refused press gives the buttons back", async () => {
    await boot(`#${TOKEN}`, user("bob"), new TypeError("Failed to fetch"), "pending");
    press("#open-member");
    await flush();
    expect(shownViews()).toEqual(["failed"]);
    const retry = $<HTMLButtonElement>("#retry");
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute("aria-busy")).toBe("false");
    press("#retry");
    await flush();
    expect(shownViews()).toEqual(["failed"]);
    expect(retry.disabled).toBe(true);
  });

  test("Stay signed in with GitHub goes to the teams page and sends nothing", async () => {
    await boot(`#${TOKEN}`, user("bob"));
    press("#stay");
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["/api/me"]);
    expect(replace).toHaveBeenCalledWith("/teams");
  });
});

describe("Try again", () => {
  test("after a network error sends the same token again", async () => {
    await boot(`#${TOKEN}`, nobody(), new TypeError("Failed to fetch"), opened());
    press("#retry");
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/dashboard-link/open", "/api/dashboard-link/open"]);
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({ token: TOKEN });
    expect(replace).toHaveBeenCalledWith("/dashboard");
  });

  test("when the session could not be read asks who is signed in before anything is posted", async () => {
    await boot(`#${TOKEN}`, json({ error: "internal error" }, 500), user("bob"));
    expect(shownViews()).toEqual(["failed"]);
    press("#retry");
    await flush();
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/me"]);
    expect(shownViews()).toEqual(["confirm"]);
  });
});

describe("language", () => {
  test("a switch redraws the view in Russian and sets <html lang>", async () => {
    await boot(`#${TOKEN}`, user(worstCase.login));
    expect(doc.documentElement.lang).toBe("en");
    press('#lang [data-lang="ru"]');
    expect(doc.documentElement.lang).toBe("ru");
    expect($('[data-view="confirm"] h1').textContent).toBe(strings.ru.confirmTitle);
    expect($("#open-member").textContent).toBe(strings.ru.openAsMember);
    expect(doc.title).toBe(strings.ru.title);
    expect($("#login").textContent).toBe(`@${worstCase.login}`);
    expect(shownViews()).toEqual(["confirm"]);
  });
});
