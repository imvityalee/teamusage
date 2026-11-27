import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { vi } from "vitest";

/** Boots `/teams` in happy-dom with the page's own static markup and stubbed answers (tests only). */

const PAGE = readFileSync(new URL("../../teams.html", import.meta.url), "utf8");
const BODY = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ?? "";

export type Reply = Response | Error | "pending";
export type Page = ReturnType<typeof makePage>;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const nobody = () => json({ error: "unauthorized" }, 401);
export const member = (team: string) => json({ kind: "member", team: { id: "3333333333333333", name: team }, memberId: 4 });
export const user = (teams: { id: string; name: string; role: "owner" | "admin" | "viewer" }[], login = "acme-admin") =>
  json({ kind: "user", githubId: 9_104_227, login, teams: teams.map((t) => ({ ...t, dashboardAccess: "members" })) });

function makePage(win: Window, calls: { url: string; init: RequestInit }[], logged: unknown[][]) {
  const doc = win.document as unknown as Document;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => doc.querySelector(sel) as T;
  return {
    win,
    doc,
    calls,
    logged,
    $,
    replace: win.location.replace as unknown as ReturnType<typeof vi.fn>,
    assign: win.location.assign as unknown as ReturnType<typeof vi.fn>,
    flush: async () => {
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    },
    press(sel: string) {
      $(sel).click();
    },
    fire(sel: string, type: string) {
      $(sel).dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }) as unknown as Event);
    },
    shownViews: () =>
      Array.from(doc.querySelectorAll<HTMLElement>("[data-view]"))
        .filter((el) => !el.hidden)
        .map((el) => el.dataset.view),
    async goTo(hash: string) {
      win.location.hash = hash;
      win.dispatchEvent(new win.Event("hashchange"));
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    },
    close: async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await win.happyDOM.close();
    },
  };
}

/** Opens `/teams<suffix>` (a query and a fragment) and answers each request with the next reply. */
export async function boot(suffix: string, ...replies: Reply[]): Promise<Page> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const win = new Window({
    url: `http://localhost:8787/teams${suffix}`,
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  (win.document as unknown as Document).body.innerHTML = BODY;
  const calls: { url: string; init: RequestInit }[] = [];
  const logged: unknown[][] = [];
  vi.spyOn(win.location, "replace").mockImplementation(vi.fn());
  vi.spyOn(win.location, "assign").mockImplementation(vi.fn());
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, name).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
  for (const [name, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    sessionStorage: win.sessionStorage,
    location: win.location,
    history: win.history,
  })) vi.stubGlobal(name, value);
  const queue = [...replies];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      if (next === "pending") return new Promise<Response>(() => {});
      if (next instanceof Error) throw next;
      return next;
    }),
  );
  vi.resetModules();
  await import("./main.js");
  const page = makePage(win, calls, logged);
  await page.flush();
  return page;
}
