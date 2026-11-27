import { t } from "../i18n.js";
import { linkBrand, PLAIN, type Chrome, type Panel } from "./chrome.js";
import type { View } from "./frame.js";
import { startOf } from "./session-start.js";
import type { Source } from "./source.js";
import type { Text } from "./strings.js";

/** The part of the dashboard's state its start reads and writes. */
export type Shell = { view: View; chrome: Chrome | null; source: Source; status: Text | null };

/**
 * How the dashboard opens: a hosted team's session is read first; Retry asks for it again while it could not be read,
 * and reloads the statistics after that. `paint` draws the state, `ready` loads the first statistics, `load` reloads.
 */
export function dashboardStart(doc: Document, shell: Shell, on: { paint(): void; ready(): void; load(): void }) {
  const retry = doc.getElementById("retry") as HTMLButtonElement;
  if (shell.source.kind !== "selfHosted") linkBrand(doc);

  /** Shows `panel` instead of the dashboard, with a header that names no team and no account. */
  function showPanel(panel: Panel): void {
    shell.view = panel;
    shell.chrome = PLAIN;
    shell.status = null;
    on.paint();
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
  return { begin, showPanel };
}
