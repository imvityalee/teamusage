import { h } from "../dom.js";
import type { ApiResult } from "../site/http.js";
import { dialogActions, openDialog, type Dialog } from "../site/dialog.js";
import type { TeamContext } from "./card.js";
import { tt } from "./strings.js";

/**
 * A dialog of the team page that asks before one request: its content, a line for what went wrong (an alert), and
 * Cancel and the confirm button in a form, so that Enter in its field confirms too.
 */
export type Flow = {
  dialog: Dialog;
  confirm: HTMLButtonElement;
  /**
   * Sends `request`: the dialog is busy and the confirm button reads `busy` until it answers, and `onConfirm` is not
   * called meanwhile. A 401 closes the dialog, shows the page's sign-in panel and gives null.
   */
  send<T>(request: () => Promise<ApiResult<T>>): Promise<ApiResult<T> | null>;
  /** Says `text` in the dialog and gives focus back to the confirm button, which from now on reads `label` when given. */
  fail(text: string, label?: string): void;
};

export type FlowOptions = {
  title: string;
  content: Node[];
  confirm: string;
  busy: string;
  /** `danger` for a button that deletes. */
  tone: "primary" | "danger";
  opener: HTMLElement | null;
  /** Called by the confirm button and by Enter in a field. */
  onConfirm(): void;
};

export function openFlow(ctx: TeamContext, o: FlowOptions): Flow {
  const { doc } = ctx;
  const lang = ctx.lang();
  let label = o.confirm;
  let busy = false;
  const error = h(doc, "p", { class: "notice warn dialog-error", role: "alert", hidden: "" });
  const cancel = h(doc, "button", { type: "button", class: "btn quiet compact", "data-action": "cancel" }, tt(lang, "cancel")) as HTMLButtonElement;
  const confirm = h(doc, "button", { type: "submit", class: `btn ${o.tone} compact`, "data-action": "confirm" }, label) as HTMLButtonElement;
  const form = h(doc, "form", { class: "dialog-form", novalidate: "" }, ...o.content, error, dialogActions(doc, cancel, confirm));
  const dialog = openDialog(doc, { title: o.title, content: [form], opener: o.opener });

  function setBusy(next: boolean): void {
    busy = next;
    dialog.setBusy(next);
    confirm.disabled = next;
    cancel.disabled = next;
    confirm.textContent = next ? o.busy : label;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!busy) o.onConfirm();
  });
  cancel.addEventListener("click", () => dialog.close());

  return {
    dialog,
    confirm,
    async send(request) {
      error.hidden = true;
      setBusy(true);
      const result = await request();
      setBusy(false);
      if (result.kind !== "unauthorized") return result;
      dialog.close();
      ctx.signedOut();
      return null;
    },
    fail(text, nextLabel) {
      label = nextLabel ?? label;
      confirm.textContent = label;
      error.textContent = text;
      error.hidden = false;
      confirm.focus();
    },
  };
}
