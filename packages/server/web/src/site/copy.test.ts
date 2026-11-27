import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { copyWhenReady, copyWith } from "./copy.js";

let win: Window;
let button: HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  win = new Window();
  button = (win.document as unknown as Document).createElement("button");
  button.textContent = "Copy code";
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await win.happyDOM.close();
});

const clipboard = (writeText: (text: string) => Promise<void>) => vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(writeText) } });

test("copies the text and shows the done text for two seconds, then the button's own label again", async () => {
  clipboard(async () => {});
  expect(await copyWith(button, "the text", "Copied")).toBe(true);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the text");
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(1);
  expect(button.textContent).toBe("Copy code");
});

test("a second copy inside the two seconds keeps the label, and the two seconds start again", async () => {
  clipboard(async () => {});
  await copyWith(button, "a", "Copied");
  await vi.advanceTimersByTimeAsync(1_500);
  await copyWith(button, "b", "Copied");
  await vi.advanceTimersByTimeAsync(1_500);
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(500);
  expect(button.textContent).toBe("Copy code");
});

test("a label drawn again meanwhile (another language) is left as it is", async () => {
  clipboard(async () => {});
  await copyWith(button, "a", "Copied");
  button.textContent = "Скопировать код";
  await vi.advanceTimersByTimeAsync(2_000);
  expect(button.textContent).toBe("Скопировать код");
});

test("returns false when the browser refuses, and the label stays", async () => {
  clipboard(async () => {
    throw new Error("NotAllowedError");
  });
  expect(await copyWith(button, "the text", "Copied")).toBe(false);
  expect(button.textContent).toBe("Copy code");
});

test("returns false when the browser has no clipboard", async () => {
  vi.stubGlobal("navigator", {});
  expect(await copyWith(button, "the text", "Copied")).toBe(false);
  expect(button.textContent).toBe("Copy code");
});

/** A browser with `ClipboardItem`: `write` takes an item whose text may still be a promise, and waits for it. */
function clipboardWithItems() {
  const held: string[] = [];
  const write = vi.fn(async ([item]: { data: Record<string, Promise<Blob>> }[]) => {
    held.push(await ((await item?.data["text/plain"]) as Blob).text());
  });
  vi.stubGlobal("ClipboardItem", class {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
  });
  vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
  return { held, write };
}

test("a text still on its way: the write starts at once, inside the press, and the button says done once it is written", async () => {
  const { held, write } = clipboardWithItems();
  let give: (text: string) => void = () => {};
  const copying = copyWhenReady(button, new Promise<string>((resolve) => (give = resolve)), "Copied");
  expect(write).toHaveBeenCalledTimes(1);
  expect(button.textContent).toBe("Copy code");
  give("the text");
  expect(await copying).toBe(true);
  expect(held).toEqual(["the text"]);
  expect(button.textContent).toBe("Copied");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(button.textContent).toBe("Copy code");
});

test("a text that does not come: false, nothing written, and the label stays", async () => {
  const { held } = clipboardWithItems();
  expect(await copyWhenReady(button, Promise.reject(new Error("no code")), "Copied")).toBe(false);
  expect(held).toEqual([]);
  expect(button.textContent).toBe("Copy code");
});

test("without ClipboardItem it waits for the text and writes it", async () => {
  clipboard(async () => {});
  expect(await copyWhenReady(button, Promise.resolve("the text"), "Copied")).toBe(true);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("the text");
  expect(button.textContent).toBe("Copied");
});

test("without ClipboardItem, a text that does not come is not written", async () => {
  clipboard(async () => {});
  expect(await copyWhenReady(button, Promise.reject(new Error("no code")), "Copied")).toBe(false);
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});
