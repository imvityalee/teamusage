import { login, type LoginResult } from "../api.js";
import { t } from "../i18n.js";
import type { Lang } from "../lang.js";
import { dt, type Text } from "./strings.js";

/** The code form of a self-hosted dashboard: sends the team code once and says why a sign-in failed. */

/** What the form says after a sign-in that did not open the dashboard. */
function messageOf(res: Exclude<LoginResult, { kind: "ok" }>): Text {
  switch (res.kind) {
    case "wrong":
      return (lang) => t(lang, "loginWrong");
    case "wrongAddress":
      return (lang) => dt(lang, "wrongAddress");
    case "tooMany": {
      const minutes = Math.max(1, Math.ceil(res.retryAfterSec / 60));
      return (lang) => (minutes === 1 ? t(lang, "loginTooMany1") : t(lang, "loginTooMany", { n: minutes }));
    }
    case "network":
      return (lang) => t(lang, "netError");
    case "error":
      return (lang) => t(lang, "loginFailed");
  }
}

/** Wires `#login-form`. `signedIn` runs once the server has set the session; `paint` draws the message in the current language. */
export function codeSignIn(doc: Document, opts: { lang: () => Lang; signedIn: () => Promise<void> }): { paint(): void } {
  const form = doc.getElementById("login-form") as HTMLFormElement;
  const invite = doc.getElementById("invite") as HTMLInputElement;
  const msg = doc.getElementById("login-msg") as HTMLElement;
  let message: Text | null = null;

  function paint(): void {
    msg.hidden = message === null;
    msg.textContent = message === null ? "" : message(opts.lang());
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    // The code lives only in this local variable and the request body.
    const code = invite.value;
    invite.value = "";
    if (code === "") return;
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (button) button.disabled = true;
    const res = await login(code);
    if (button) button.disabled = false;
    if (res.kind === "ok") {
      message = null;
      paint();
      await opts.signedIn();
      return;
    }
    message = messageOf(res);
    paint();
    invite.focus();
  }

  form.addEventListener("submit", (e) => void submit(e));
  return { paint };
}
