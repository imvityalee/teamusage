import type { Lang } from "../lang.js";
import { signOut } from "../site/session.js";
import { dt } from "./strings.js";

/**
 * The header's sign-out button: one request at a time, then `/`. If the session may still be there the person stays,
 * with the button back, focused, and a sentence saying so.
 */
export function signOutButton(doc: Document, lang: () => Lang): { paint(): void } {
  const button = doc.getElementById("sign-out") as HTMLButtonElement;
  const error = doc.getElementById("signout-error") as HTMLElement;
  let busy = false;
  let failed = false;

  function paint(): void {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    error.hidden = !failed;
    error.textContent = failed ? dt(lang(), "signOutFailed") : "";
  }

  async function leave(): Promise<void> {
    busy = true;
    failed = false;
    paint();
    if (await signOut()) return location.assign("/");
    busy = false;
    failed = true;
    paint();
    button.focus();
  }

  button.addEventListener("click", () => void leave());
  return { paint };
}
