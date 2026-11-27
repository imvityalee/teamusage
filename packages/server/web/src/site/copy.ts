/** Copying to the clipboard from a button, which says so for a moment. */

/** How long a button shows its done text. */
const DONE_MS = 2_000;

/** A button's own label while it shows its done text, and the timer that gives the label back. */
const showing = new WeakMap<HTMLButtonElement, { label: string; timer: ReturnType<typeof setTimeout> }>();

/** Shows `done` in `button`, then its own label again after DONE_MS unless the label was drawn anew meanwhile. */
function showDone(button: HTMLButtonElement, done: string): void {
  const before = showing.get(button);
  clearTimeout(before?.timer);
  const label = before?.label ?? button.textContent ?? "";
  button.textContent = done;
  const timer = setTimeout(() => {
    showing.delete(button);
    if (button.textContent === done) button.textContent = label;
  }, DONE_MS);
  showing.set(button, { label, timer });
}

/** Copies `text` and shows `done` in `button` for two seconds, then its own label again; false when the browser refuses. */
export async function copyWith(button: HTMLButtonElement, text: string, done: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false; // no clipboard, no permission, or a page that is not focused
  }
  showDone(button, done);
  return true;
}
