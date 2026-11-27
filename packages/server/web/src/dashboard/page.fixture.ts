import { vi } from "vitest";
import { bootPage, json, type Page, type Reply } from "../site/page.fixture.js";

/** Opens the dashboard at `url` (`/`, `/demo` or `/dashboard`, with a query and a fragment) and answers each request with the next reply (tests only). */
export const bootDashboard = (url: string, ...replies: Reply[]): Promise<Page> =>
  bootPage(
    {
      url,
      html: "index.html",
      load: () => import("../main.js"),
      // main.ts restores the caret with `instanceof HTMLInputElement`, a global in a browser.
      prepare: (win) => vi.stubGlobal("HTMLInputElement", win.HTMLInputElement),
    },
    replies,
  );

/** The server's answer when the team's statistics have used up their minute (limit-answers.ts). */
export const busy = (retryAfterSec: number) =>
  new Response(JSON.stringify({ error: "this team's statistics are busy; try again in a minute", limit: "team-stats" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSec) },
  });

export const teamNotFound = () => json({ error: "team not found" }, 404);

/** The path of each request the page sent, and the `team` it named, if any. */
export const sent = (page: Page) =>
  page.calls.map((c) => {
    const url = new URL(c.url, "http://localhost");
    return { path: url.pathname, team: url.searchParams.get("team"), member: url.searchParams.get("member") };
  });

/** Which of the header's parts and the page's panels are on screen. */
export const shown = (page: Page) =>
  ["team-name", "team-nav", "sample", "account", "login", "signed-out", "filterbar", "stats", "status"].filter((id) => page.doc.getElementById(id)?.hidden === false);
