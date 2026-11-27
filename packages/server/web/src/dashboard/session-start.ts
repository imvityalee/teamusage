import { me } from "../site/session.js";
import { dashboardPath } from "../site/team-param.js";
import { chromeOf, type Chrome, type Panel } from "./chrome.js";
import { sessionSource, type Source } from "./source.js";

/** How the dashboard opens: its header and the source of its statistics, a panel instead, the error with Retry, or another page. */
export type Start =
  | { kind: "draw"; chrome: Chrome; source: Source }
  | { kind: "panel"; panel: Panel }
  | { kind: "failed" } // the session could not be read
  | { kind: "left" }; // the browser is on its way to another page

/** A GitHub user's only team is written into the address, without a navigation, before anything else is asked. */
function adopt(source: Source): Source {
  if (source.kind === "hosted" && source.team !== null) {
    const path = dashboardPath(source.team);
    if (location.pathname + location.search !== path) history.replaceState(null, "", path + location.hash);
  }
  return source;
}

/** Reads a hosted team's session first; the demo and a self-hosted server start at once, asking nobody who they are. */
export async function startOf(source: Source): Promise<Start> {
  const session = source.kind === "hosted" ? await me() : null;
  if (session?.kind === "failed" || session?.kind === "noAccounts") return { kind: "failed" };
  const next = chromeOf(source, session);
  if ("go" in next) {
    location.replace(next.go);
    return { kind: "left" };
  }
  if ("panel" in next) return { kind: "panel", panel: next.panel };
  const read = session?.kind === "me" && source.kind === "hosted" ? adopt(sessionSource(source, session.me)) : source;
  return { kind: "draw", chrome: next, source: read };
}
