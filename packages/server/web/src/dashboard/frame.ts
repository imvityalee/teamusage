import type { Lang } from "../lang.js";
import { PLAIN, renderChrome, type Chrome, type Panel } from "./chrome.js";
import { codeSignIn } from "./code-sign-in.js";
import { signOutButton } from "./sign-out.js";
import { renderSignedOut } from "./signed-out.js";
import { dt } from "./strings.js";

/** What the dashboard shows. `waiting`: a hosted team's session is being read, and nothing else is asked meanwhile. */
export type View = "waiting" | "stats" | "login" | Panel;

/**
 * Everything around the statistics: the header, the title of a hosted team, the code form, sign out, and the
 * signed-out or noTeam panel. `signedIn` runs once the code form has opened a session.
 */
export function dashboardFrame(doc: Document, opts: { lang: () => Lang; signedIn: () => Promise<void> }) {
  const signIn = codeSignIn(doc, opts);
  const signOut = signOutButton(doc, opts.lang);
  const login = doc.getElementById("login") as HTMLElement;
  const panelBox = doc.getElementById("signed-out") as HTMLElement;
  /** The panel on screen. A new one is drawn only when its kind changes: a drawn panel is announced. */
  let drawn: Panel | null = null;

  return {
    /** Draws the parts of `view` and `chrome` (null: the session is not read yet). Call after the dashboard's own title is set. */
    paint(view: View, chrome: Chrome | null): void {
      const lang = opts.lang();
      renderChrome(doc, chrome ?? PLAIN, lang);
      if (chrome?.teamName) doc.title = dt(lang, "teamTitle", { team: chrome.teamName });
      signIn.paint();
      signOut.paint();
      login.hidden = view !== "login";
      const panel = view === "signedOut" || view === "noTeam" ? view : null;
      panelBox.hidden = panel === null;
      // The panel's texts follow the language through `renderChrome`'s `applyDashText`.
      if (panel !== drawn) panelBox.replaceChildren(...(panel === null ? [] : [renderSignedOut(doc, lang, panel)]));
      drawn = panel;
    },
  };
}
