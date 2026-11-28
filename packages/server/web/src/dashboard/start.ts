import { t } from "../i18n.js";
import { reloadWhenRestored } from "../site/restored.js";
import { linkBrand, PLAIN, type Chrome, type Panel } from "./chrome.js";
import type { View } from "./frame.js";
import { startOf } from "./session-start.js";
import type { Source } from "./source.js";
import type { Text } from "./strings.js";

/** The part of the dashboard's state its start reads and writes. `shown`: the statistics on the page, or null. */
export type Shell = { view: View; chrome: Chrome | null; source: Source; status: Text | null; shown: object | null };

/**
 * How the dashboard opens: a hosted team's session is read first; Retry asks for it again while it could not be read,
 * and reloads the statistics after that. `paint` draws the state, `ready` loads the first statistics, `load` reloads.
 */
export function dashboardStart(doc: Document, shell: Shell, on: { paint(): void; ready(): void; load(): void }) {
  const retry = doc.getElementById("retry") as HTMLButtonElement;
  if (shell.source.kind !== "selfHosted") linkBrand(doc);
  // The demo shows nothing private; every other dashboard is behind a session.
  if (shell.source.kind !== "demo") reloadWhenRestored(window);

  /**
   * Takes the statistics off the page (the state, `#stats` and `#page-head`) and draws it again, which also gives the
   * title back from a member's name: a 401, a lost role, a sign-out.
   */
  function clearShown(): void {
    shell.shown = null;
    for (const id of ["stats", "page-head"]) doc.getElementById(id)?.replaceChildren();
    on.paint();
  }

  /** Shows `panel` instead of the dashboard, with a header that names no team and no account. */
  function showPanel(panel: Panel): void {
    shell.view = panel;
    shell.chrome = PLAIN;
    shell.status = null;
    clearShown();
  }

  /** A self-hosted server's 401: the code form, with nothing of the team behind it. */
  function showLogin(): void {
    shell.view = "login";
    shell.status = null;
    clearShown();
  }

  async function begin(): Promise<void> {
    on.paint();
    const start = await startOf(shell.source);
    if (start.kind === "failed") {
      shell.status = (lang) => t(lang, "netError");
      return on.paint();
    }
    if (start.kind === "panel") return showPanel(start.panel);
    if (start.kind === "left") return;
    shell.source = start.source;
    shell.chrome = start.chrome;
    shell.view = "stats";
    shell.status = null;
    on.ready();
  }

  /** One `/api/me` at a time: Retry is disabled until the answer, and keeps focus when the error stays. */
  async function retrySession(): Promise<void> {
    retry.disabled = true;
    await begin();
    retry.disabled = false;
    if (shell.status !== null) retry.focus();
  }

  retry.addEventListener("click", () => void (shell.chrome === null ? retrySession() : on.load()));
  return { begin, showPanel, showLogin, clearShown };
}
