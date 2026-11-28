import { h } from "../dom.js";

/**
 * The modal dialog of the new pages (`.dialog` in site.css, which also holds its motion). The element is built here,
 * shown with `showModal()` and taken out of the document once it has closed, with whatever it held.
 */

export type Dialog = {
  element: HTMLDialogElement;
  close(): void;
  setBusy(busy: boolean): void;
  /** From now on only `close()` closes it: Escape and the backdrop do not (a secret shown once, which a slip would lose). */
  holdOpen(): void;
};

let made = 0;

/** An id no other element of the page has, for a heading or a field a dialog labels with it. */
export const uniqueId = (prefix: string): string => `${prefix}-${++made}`;

/** The row of a dialog's buttons, in the order given. */
export const dialogActions = (doc: Document, ...buttons: HTMLElement[]): HTMLElement => h(doc, "div", { class: "dialog-actions" }, ...buttons);

/** The field that asks for focus (`autofocus`), or the dialog itself. */
function focusInside(el: HTMLDialogElement): void {
  const target = el.querySelector<HTMLElement>("[autofocus]") ?? el;
  target.focus();
}

/** True when a press on `el` is outside its box: on its backdrop. */
function onBackdrop(el: HTMLDialogElement, e: MouseEvent): boolean {
  const box = el.getBoundingClientRect();
  const outside = e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
  return e.target === el && outside;
}

/** Takes `el` out of the document once its closing motion has run; at once when the browser runs none. */
function removeAfterMotion(el: HTMLDialogElement): void {
  const running = typeof el.getAnimations === "function" ? el.getAnimations({ subtree: true }) : [];
  if (running.length === 0) return el.remove();
  void Promise.allSettled(running.map((a) => a.finished)).then(() => el.remove());
}

/**
 * Opens a modal `<dialog>` holding `content` under the heading `title`. Focus moves into it; Escape, the backdrop and
 * `close()` close it and give focus back to `opener`; while busy none of them closes it, and once held open only
 * `close()` does. `onClose` runs once.
 */
export function openDialog(doc: Document, o: { title: string; content: Node[]; opener: HTMLElement | null; onClose?(): void }): Dialog {
  const headingId = uniqueId("dialog-title");
  const el = h(doc, "dialog", { class: "dialog", "aria-labelledby": headingId, tabindex: "-1" }) as HTMLDialogElement;
  el.append(h(doc, "div", { class: "dialog-body" }, h(doc, "h2", { id: headingId }, o.title), ...o.content));
  let busy = false;
  let held = false;
  let pressStartedOnBackdrop = false;

  const close = (): void => {
    if (!busy && el.open) el.close();
  };
  /** Escape and the backdrop. */
  const dismiss = (): void => {
    if (!held) close();
  };

  // Escape: the browser sends `cancel`; the module decides, so that a busy dialog stays the same in every browser.
  el.addEventListener("cancel", (e) => {
    e.preventDefault();
    dismiss();
  });
  // A browser may close a dialog whose `cancel` was refused before; a busy dialog refuses the key itself.
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (busy || held)) e.preventDefault();
  });
  // A press on the backdrop targets the dialog element, as does one on the dialog's own scrollbar: only a press outside
  // its box is on the backdrop. One that began inside (a drag out of the field) is not.
  el.addEventListener("pointerdown", (e) => (pressStartedOnBackdrop = onBackdrop(el, e)));
  el.addEventListener("click", (e) => {
    if (pressStartedOnBackdrop && onBackdrop(el, e)) dismiss();
  });
  el.addEventListener("close", () => {
    o.onClose?.();
    if (o.opener?.isConnected) o.opener.focus();
    removeAfterMotion(el);
  });

  doc.body.append(el);
  el.showModal();
  focusInside(el);
  return {
    element: el,
    close,
    setBusy(next) {
      busy = next;
      el.setAttribute("aria-busy", String(next));
    },
    holdOpen() {
      held = true;
    },
  };
}
