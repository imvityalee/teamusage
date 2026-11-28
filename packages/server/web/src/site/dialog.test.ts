import { Window } from "happy-dom";
import { afterEach, expect, test, vi } from "vitest";
import { dialogActions, openDialog, type Dialog } from "./dialog.js";

/**
 * happy-dom's `<dialog>` sets and removes `open` and fires `close`; it has no backdrop, no Escape key and no focus
 * trap. These tests send what a browser sends (`cancel` for Escape, a click whose target is the dialog for the
 * backdrop) and check what the module does with it.
 */

let win: Window;
afterEach(async () => win?.happyDOM.close());

function setUp(onClose = vi.fn()) {
  win = new Window();
  const doc = win.document as unknown as Document;
  const opener = doc.createElement("button");
  opener.textContent = "Open";
  doc.body.append(opener);
  opener.focus();
  const input = doc.createElement("input");
  input.setAttribute("autofocus", "");
  const cancel = doc.createElement("button");
  const dialog = openDialog(doc, { title: "Replace the team code?", content: [input, dialogActions(doc, cancel)], opener, onClose });
  // happy-dom lays nothing out: the dialog's box is given, 300 × 200 at (100, 100).
  dialog.element.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200, x: 100, y: 100 }) as DOMRect;
  return { doc, opener, input, cancel, dialog, onClose };
}

const cancelEvent = () => new win.Event("cancel", { cancelable: true }) as unknown as Event;
const escape = () => new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event;

const INSIDE = { clientX: 200, clientY: 200 };
const OUTSIDE = { clientX: 20, clientY: 20 };
/** The dialog's own scrollbar: the dialog element is the target, inside its box. */
const SCROLLBAR = { clientX: 395, clientY: 200 };

/** A press that starts and ends on `target` at `at`: on the dialog element outside its box, that is the backdrop. */
function pressOn(target: Element, at: { clientX: number; clientY: number } = INSIDE): void {
  target.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, ...at }) as unknown as Event);
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...at }) as unknown as Event);
}

const isOpen = (d: Dialog) => d.element.open && d.element.isConnected;

test("it opens as a modal named by its heading, with focus inside on the field that asks for it", () => {
  const { doc, input, dialog } = setUp();
  expect(isOpen(dialog)).toBe(true);
  const heading = doc.getElementById(dialog.element.getAttribute("aria-labelledby") ?? "");
  expect(heading?.textContent).toBe("Replace the team code?");
  expect(heading?.tagName).toBe("H2");
  expect(doc.activeElement).toBe(input);
});

test("with no field asking for focus, the dialog itself takes it", () => {
  win = new Window();
  const doc = win.document as unknown as Document;
  const dialog = openDialog(doc, { title: "T", content: [doc.createTextNode("text")], opener: null });
  expect(doc.activeElement).toBe(dialog.element);
});

test("Escape closes it, gives focus back to the opener and runs onClose once", () => {
  const { doc, opener, dialog, onClose } = setUp();
  dialog.element.dispatchEvent(cancelEvent());
  expect(dialog.element.open).toBe(false);
  expect(doc.activeElement).toBe(opener);
  dialog.close();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a press on the backdrop closes it; a press inside does not", () => {
  const { input, dialog } = setUp();
  pressOn(input);
  expect(isOpen(dialog)).toBe(true);
  pressOn(dialog.element, OUTSIDE);
  expect(dialog.element.open).toBe(false);
});

test("a press on the dialog's own scrollbar, inside its box, does not close it", () => {
  const { dialog } = setUp();
  pressOn(dialog.element, SCROLLBAR);
  expect(isOpen(dialog)).toBe(true);
});

test("a drag that starts inside and ends on the backdrop does not close it", () => {
  const { input, dialog } = setUp();
  input.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, ...INSIDE }) as unknown as Event);
  dialog.element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, ...OUTSIDE }) as unknown as Event);
  expect(isOpen(dialog)).toBe(true);
});

test("a busy dialog is closed by neither Escape nor the backdrop, and focus returns to the opener when it closes", () => {
  const { doc, opener, dialog, onClose } = setUp();
  dialog.setBusy(true);
  const cancel = cancelEvent();
  dialog.element.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  const key = escape();
  dialog.element.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  pressOn(dialog.element, OUTSIDE);
  dialog.close();
  expect(isOpen(dialog)).toBe(true);
  expect(dialog.element.getAttribute("aria-busy")).toBe("true");
  expect(onClose).not.toHaveBeenCalled();

  dialog.setBusy(false);
  dialog.close();
  expect(dialog.element.open).toBe(false);
  expect(doc.activeElement).toBe(opener);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a dialog held open is closed by neither Escape nor the backdrop, is not busy, and its own close() still closes it", () => {
  const { dialog, onClose } = setUp();
  dialog.holdOpen();
  const cancel = cancelEvent();
  dialog.element.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  const key = escape();
  dialog.element.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(true);
  pressOn(dialog.element, OUTSIDE);
  expect(isOpen(dialog)).toBe(true);
  expect(dialog.element.hasAttribute("aria-busy")).toBe(false);
  dialog.close();
  expect(dialog.element.open).toBe(false);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("an Escape that is not busy is left to the browser, which answers it with cancel", () => {
  const { dialog } = setUp();
  const key = escape();
  dialog.element.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
});

test("a closed dialog leaves the document, with whatever it held", () => {
  const { doc, dialog } = setUp();
  dialog.close();
  expect(dialog.element.isConnected).toBe(false);
  expect(doc.querySelector("dialog")).toBeNull();
});

test("an opener that left the document is not focused", () => {
  const { opener, dialog } = setUp();
  const focus = vi.spyOn(opener, "focus");
  opener.remove();
  dialog.close();
  expect(focus).not.toHaveBeenCalled();
});

test("the buttons sit in one row, in the order given", () => {
  win = new Window();
  const doc = win.document as unknown as Document;
  const a = doc.createElement("button");
  const b = doc.createElement("button");
  const row = dialogActions(doc, a, b);
  expect(row.className).toBe("dialog-actions");
  expect([...row.children]).toEqual([a, b]);
});
