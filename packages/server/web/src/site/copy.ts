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

/** True when the browser takes a clipboard item whose text is still a promise (Safari, Chrome). */
const takesPromisedText = (): boolean => typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";

/**
 * `copyWith` for a text still on its way (asked for by this press). Safari takes a clipboard write only inside the
 * press, so where the browser has `ClipboardItem` the write starts now, holding the promise; elsewhere the text is
 * written once it came. A `text` that rejects writes nothing and gives false, as does a refusal.
 */
export async function copyWhenReady(button: HTMLButtonElement, text: Promise<string>, done: string): Promise<boolean> {
  try {
    if (takesPromisedText()) {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      blob.catch(() => {}); // a text that does not come is answered by `write` rejecting, below
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
  } catch {
    return false; // the text did not come, or the browser refused
  }
  showDone(button, done);
  return true;
}
