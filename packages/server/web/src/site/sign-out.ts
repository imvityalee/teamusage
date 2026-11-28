import { signOut } from "./session.js";

/**
 * The header's sign-out button (`#sign-out`) of the dashboard and the team page: one request at a time, then
 * `leaving` takes what the page shows off it, and the browser goes to `/`. If the session may still be there the
 * person stays, with the button back, focused, and `failedText` in `#signout-error`.
 */
export function signOutButton(doc: Document, failedText: () => string, leaving: () => void): { paint(): void } {
  const button = doc.getElementById("sign-out") as HTMLButtonElement;
  const error = doc.getElementById("signout-error") as HTMLElement;
  let busy = false;
  let failed = false;

  function paint(): void {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    error.hidden = !failed;
    error.textContent = failed ? failedText() : "";
  }

  async function leave(): Promise<void> {
    busy = true;
    failed = false;
    paint();
    if (await signOut()) {
      leaving();
      return location.assign("/");
    }
    busy = false;
    failed = true;
    paint();
    button.focus();
  }

  button.addEventListener("click", () => void leave());
  return { paint };
}
