/**
 * Loads a signed-in page again when the browser restores it from its back-forward cache: Back after "Sign out" would
 * otherwise show what the page held, without asking the server.
 */
export function reloadWhenRestored(win: Window): void {
  win.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) win.location.reload();
  });
}
