import type { ServerConfig } from "./config.js";

export type Mode = ServerConfig["mode"];

/** A self-hosted server: the dashboard at `/`, and the page that opens a member's link. */
const SELF_HOSTED_PAGES: Readonly<Record<string, string>> = Object.freeze({
  "/": "index.html",
  "/index.html": "index.html",
  "/open": "open.html",
});

/** A hosted server: the landing page at `/`, the dashboard, the team pages and the legal pages. */
const HOSTED_PAGES: Readonly<Record<string, string>> = Object.freeze({
  "/": "landing.html",
  "/dashboard": "index.html",
  "/demo": "index.html",
  "/open": "open.html",
  "/teams": "teams.html",
  "/team": "team.html",
  "/invite": "invite.html",
  "/privacy": "privacy.html",
  "/terms": "terms.html",
});

/** The pages a server of this mode serves: URL path to file name in the web directory. */
export function pagesOf(mode: Mode): Readonly<Record<string, string>> {
  return mode === "hosted" ? HOSTED_PAGES : SELF_HOSTED_PAGES;
}
